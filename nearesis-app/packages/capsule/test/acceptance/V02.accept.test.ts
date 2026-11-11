import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  buildCapsule,
  canonicalSha256,
  loadCapsuleView,
  SnapshotError,
  verifyCapsule,
} from "../../src/index.ts";
import { RESEARCH_BUNDLE, SNAPSHOT, tmp } from "../helpers.ts";

const OPTS = { research: "skip", wasm: "skip" } as const;

function fresh() {
  const dir = tmp("v02-");
  const m = buildCapsule({ snapshotDir: SNAPSHOT, outDir: dir, researchBundleDir: RESEARCH_BUNDLE });
  return { dir, m };
}
const flip = (p: string, from: string, to: string) => {
  const t = readFileSync(p, "utf8");
  expect(t).toContain(from);
  writeFileSync(p, t.replace(from, to));
};

/** V02 (ch.16): alter one raw source byte; hash check fails and the report is marked unverified. */
it("V02: one altered raw byte fails the hash check and marks the report unverified", async () => {
  const control = fresh();
  expect((await verifyCapsule(control.dir, OPTS)).status).toBe("reproduced");

  // 1. alter a single raw byte (digit 1 -> 2 in the first data row) in the capsule
  const { dir, m } = fresh();
  const raw = join(dir, "snapshot", "raw", "daily_series.csv");
  const buf = readFileSync(raw);
  const at = buf.indexOf(Buffer.from("2026-08-13,")) + "2026-08-13,".length;
  const before = buf[at]!;
  buf[at] = before === 0x39 ? 0x38 : before + 1;
  writeFileSync(raw, buf);
  const rep = await verifyCapsule(dir, OPTS);
  expect(rep.status).toBe("mismatch");
  expect(rep.reportStatus).toBe("UNVERIFIED");
  expect(rep.failures.map((f) => f.kind)).toContain("RAW_HASH_MISMATCH");
  const view = await loadCapsuleView(dir, OPTS);
  expect(view!.verification.local.status).toBe("mismatch");
  expect(view!.verification.local.detail).toContain("UNVERIFIED");
  expect(view!.verification.failures.some((f) => f.kind === "RAW_HASH_MISMATCH")).toBe(true);
  expect(view!.verification.outlayer.status).not.toBe("verified");

  // 2. a rebuild from an altered snapshot directory is refused outright
  const snap = tmp("v02-snap-");
  cpSync(SNAPSHOT, snap, { recursive: true });
  const b2 = readFileSync(join(snap, "raw", "daily_series.csv"));
  b2[b2.length - 3] = b2[b2.length - 3] === 0x31 ? 0x32 : 0x31;
  writeFileSync(join(snap, "raw", "daily_series.csv"), b2);
  expect(() => buildCapsule({ snapshotDir: snap, outDir: tmp("v02-out-") })).toThrowError(SnapshotError);

  // 3. tampered outputs: results file, exported thesis number, manifest claim
  const t = fresh();
  const r = JSON.parse(readFileSync(join(t.dir, "computation", "results.json"), "utf8")) as {
    pearson_ppm: string;
  };
  flip(
    join(t.dir, "computation", "results.json"),
    `"pearson_ppm":"${r.pearson_ppm}"`,
    `"pearson_ppm":"999999"`,
  );
  const rt = await verifyCapsule(t.dir, OPTS);
  expect(rt.failures.map((f) => f.kind)).toEqual(
    expect.arrayContaining(["FILE_HASH_MISMATCH", "RESULTS_MISMATCH"]),
  );
  const t2 = fresh();
  flip(join(t2.dir, "exports", "THESIS.md"), "0.", "9.");
  expect((await verifyCapsule(t2.dir, OPTS)).failures.map((f) => f.kind)).toContain("FILE_HASH_MISMATCH");
  const t3 = fresh();
  flip(join(t3.dir, "manifest.json"), '"label": "SYNTHETIC"', '"label": "LIVE"');
  expect((await verifyCapsule(t3.dir, OPTS)).failures.map((f) => f.kind)).toContain("CAPSULE_HASH_MISMATCH");

  // 4. a forger who also rewrites the raw hash and capsuleHash but keeps the old results is still caught by recomputation
  const f = fresh();
  const rawF = join(f.dir, "snapshot", "raw", "daily_series.csv");
  const bf = readFileSync(rawF);
  const idx = bf.indexOf(Buffer.from("2026-08-13,")) + 11;
  bf[idx] = bf[idx] === 0x39 ? 0x38 : bf[idx]! + 1;
  writeFileSync(rawF, bf);
  const mf = JSON.parse(readFileSync(join(f.dir, "manifest.json"), "utf8")) as {
    snapshot: { files: Array<{ path: string; sha256: string }> };
    capsuleHash: string;
  };
  const { sha256Hex } = await import("../../src/index.ts");
  for (const e of mf.snapshot.files) if (e.path.endsWith("daily_series.csv")) e.sha256 = sha256Hex(bf);
  const { capsuleHash: _c, ...body } = mf;
  mf.capsuleHash = canonicalSha256(body);
  writeFileSync(join(f.dir, "manifest.json"), JSON.stringify(mf, null, 2));
  const rf = await verifyCapsule(f.dir, OPTS);
  expect(rf.status).toBe("mismatch");
  expect(
    rf.failures
      .map((x) => x.kind)
      .some((k) => ["INPUT_REDERIVATION_MISMATCH", "RESULTS_MISMATCH", "DATA_HASH_MISMATCH"].includes(k)),
  ).toBe(true);

  observe({
    testId: "V02",
    observed: `Control capsule reproduced. One raw byte altered (offset ${at}, 0x${before.toString(16)} changed) -> status mismatch, reportStatus UNVERIFIED, failures [${rep.failures.map((x) => x.kind).join(",")}]; viewer record local.status=mismatch. Rebuild from altered snapshot refused (RAW_HASH_MISMATCH). Tampered results/THESIS/manifest caught (${rt.failures.map((x) => x.kind).join(",")}); forger who rewrote raw hash+capsuleHash caught by recomputation (${rf.failures.map((x) => x.kind).join(",")}).`,
    fixtureHash: m.snapshot.dataHash,
    evidence: {
      rawFailures: rep.failures.map((x) => x.kind),
      outputFailures: rt.failures.map((x) => x.kind),
      forgerFailures: rf.failures.map((x) => x.kind),
      reportStatus: rep.reportStatus,
    },
  });
});
