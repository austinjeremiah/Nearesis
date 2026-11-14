import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { CapsuleManifest } from "@nearesis/contracts";
import { buildCapsule, canonicalSha256, scrubbedEnv, sha256Hex, verifyCapsule } from "../../src/index.ts";
import { PKG, RESEARCH_BUNDLE, SNAPSHOT, tmp, treeHashes } from "../helpers.ts";

const ENV = scrubbedEnv();
const cli = (args: string[]) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", join(PKG, "src", "no-network.mjs"), join(PKG, "src", "cli.ts"), ...args],
    { cwd: PKG, env: ENV, encoding: "utf8", timeout: 280_000 },
  );

/** V12 (16b): capsule export, verification and deterministic rebuild. FIXTURE, offline. */
it("V12: the capsule validates, verifies offline from its own contents, rebuilds twice identically, and broken fields are named", async () => {
  const dir = tmp("v12-cap-");
  const m = buildCapsule({ snapshotDir: SNAPSHOT, outDir: dir, researchBundleDir: RESEARCH_BUNDLE });
  const onDisk = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as unknown;

  // (a) schema, ch.20 fields, each hash equals the hash of the artifact it names, no invented values
  const parsed = CapsuleManifest.parse(onDisk);
  const o = onDisk as Record<string, unknown>;
  for (const k of [
    "schemaVersion",
    "capsuleId",
    "claims",
    "hashes",
    "attestation",
    "chainCommitment",
    "limitations",
  ])
    expect(o, k).toHaveProperty(k);
  const h = parsed.hashes;
  expect(parsed.claims.length).toBeGreaterThan(0);
  expect(h.resultManifestHash).toBe(canonicalSha256(parsed.results));
  expect(h.sourceSnapshotHash).toBe(parsed.snapshot.dataHash);
  expect(parsed.snapshot.dataHash).toBe(
    sha256Hex(
      parsed.snapshot.files
        .filter((f) => f.path !== "snapshot/snapshot.json")
        .map((f) => `${f.path.replace(/^snapshot\//, "")}:${sha256Hex(readFileSync(join(dir, f.path)))}`)
        .sort()
        .join("\n"),
    ),
  );
  expect(parsed.computation.resultsSha256).toBeTruthy();
  const run = JSON.parse(readFileSync(join(dir, "research", "research_run.json"), "utf8")) as {
    preregistration: { hash: string };
  };
  expect(`sha256:${h.preregistrationHash}`).toBe(run.preregistration.hash);
  expect(h.containerDigest).toBeNull();
  expect(parsed.attestation).toEqual({
    status: "unverified",
    evidenceSource: null,
    jobId: null,
    reason: expect.any(String),
  });
  expect(parsed.chainCommitment).toMatchObject({ status: "blocked", network: null, txHash: null });
  for (const f of [...parsed.snapshot.files, parsed.computation.resultsFile, ...parsed.publication.files])
    expect(sha256Hex(readFileSync(join(dir, f.path))), f.path).toBe(f.sha256);

  // (b) research:verify succeeds offline and prints the hash chain; (e) 0 network calls (preload throws on any use)
  const v = cli(["verify", "--capsule", dir]);
  expect(v.status, v.stderr.slice(0, 500)).toBe(0);
  const rep = JSON.parse(v.stdout) as {
    status: string;
    hashChain: Record<string, string | null>;
    failures: unknown[];
  };
  expect(rep.status).toBe("reproduced");
  expect(rep.hashChain.capsuleHash).toBe(m.capsuleHash);
  expect(rep.hashChain.resultManifestHash).toBe(h.resultManifestHash);
  expect(rep.hashChain.sourceSnapshotHash).toBe(h.sourceSnapshotHash);
  const probe = spawnSync(
    process.execPath,
    [
      "--import",
      join(PKG, "src", "no-network.mjs"),
      "-e",
      "try{fetch('http://127.0.0.1:9')}catch(e){console.log(e.message)}",
    ],
    { encoding: "utf8", env: ENV },
  );
  expect(probe.stdout).toContain("NETWORK_BLOCKED");

  // (c) two rebuilds: identical canonical hashes; every file (incl. dashboard) hash-equal. No timestamp field is written.
  const outs = [tmp("v12-r1-"), tmp("v12-r2-")];
  const reb = outs.map((out) =>
    cli([
      "rebuild",
      "--snapshot",
      SNAPSHOT,
      "--out",
      out,
      "--research-bundle",
      RESEARCH_BUNDLE,
      "--expect",
      join(dir, "manifest.json"),
    ]),
  );
  for (const r of reb) expect(r.status, r.stderr.slice(0, 500)).toBe(0);
  const trees = outs.map(treeHashes);
  expect(trees[0]).toEqual(trees[1]);
  expect(trees[0]).toEqual(treeHashes(dir));
  expect(trees[0]!["computation/results.json"] === treeHashes(dir)["computation/results.json"]).toBe(true);
  expect(trees[0]!["exports/site/index.html"]).toBe(treeHashes(dir)["exports/site/index.html"]);

  // (d) edited manifests fail verification and name the broken field
  const removed = tmp("v12-rm-");
  buildCapsule({ snapshotDir: SNAPSHOT, outDir: removed, researchBundleDir: RESEARCH_BUNDLE });
  const mp = join(removed, "manifest.json");
  const mj = JSON.parse(readFileSync(mp, "utf8")) as { hashes: Record<string, unknown> };
  delete mj.hashes.preregistrationHash;
  writeFileSync(mp, JSON.stringify(mj, null, 2));
  const r1 = await verifyCapsule(removed, { research: "skip", wasm: "skip" });
  expect(r1.status).toBe("mismatch");
  expect(r1.failures[0]!.kind).toBe("MANIFEST_INVALID");
  expect(r1.failures[0]!.detail).toContain("hashes.preregistrationHash");

  const corrupt = tmp("v12-cr-");
  buildCapsule({ snapshotDir: SNAPSHOT, outDir: corrupt, researchBundleDir: RESEARCH_BUNDLE });
  const cp = join(corrupt, "manifest.json");
  const cj = JSON.parse(readFileSync(cp, "utf8")) as {
    hashes: { resultManifestHash: string };
    capsuleHash: string;
  };
  cj.hashes.resultManifestHash = "e".repeat(64);
  const { capsuleHash: _x, ...body } = cj;
  cj.capsuleHash = canonicalSha256(body); // the forger also repairs capsuleHash, so only the field-level check can catch it
  writeFileSync(cp, JSON.stringify(cj, null, 2));
  const r2 = await verifyCapsule(corrupt, { research: "skip", wasm: "skip" });
  expect(r2.status).toBe("mismatch");
  const named = r2.failures.find((f) => f.kind === "RESULT_MANIFEST_HASH_MISMATCH");
  expect(named?.detail).toContain("hashes.resultManifestHash");

  // negative control: a flipped byte in the result file fails verification
  const flip = tmp("v12-fl-");
  buildCapsule({ snapshotDir: SNAPSHOT, outDir: flip, researchBundleDir: RESEARCH_BUNDLE });
  const rf = join(flip, "computation", "results.json");
  const rb = readFileSync(rf);
  rb[rb.length - 3] = rb[rb.length - 3] === 0x31 ? 0x32 : 0x31;
  writeFileSync(rf, rb);
  const r3 = await verifyCapsule(flip, { research: "skip", wasm: "skip" });
  expect(r3.status).toBe("mismatch");
  expect(r3.failures.map((f) => f.kind)).toContain("FILE_HASH_MISMATCH");

  observe({
    testId: "V12",
    observed: `Manifest validates against the schema with all ch.20 fields; resultManifestHash, sourceSnapshotHash, preregistrationHash and every file hash recomputed from artifacts; attestation {unverified, null job} and chainCommitment {blocked, null tx} are never invented. research:verify (child process, network use throws) exit 0, status reproduced, printed hash chain with capsuleHash ${m.capsuleHash.slice(0, 16)}. Two rebuilds: ${Object.keys(trees[0]!).length} files each, all hash-equal (no timestamp field is emitted, createdAt is the frozen snapshot time). Removed preregistrationHash -> ${r1.failures[0]!.kind} naming hashes.preregistrationHash; corrupted resultManifestHash with repaired capsuleHash -> ${named!.kind}; flipped result byte -> FILE_HASH_MISMATCH.`,
    fixtureHash: m.snapshot.dataHash,
    evidence: {
      capsuleHash: m.capsuleHash,
      hashChain: rep.hashChain,
      rebuildTreeHash: canonicalSha256(trees[0]),
      files: Object.keys(trees[0]!).length,
      removedField: r1.failures[0]!.detail,
      corruptedField: named!.detail,
    },
  });
}, 300_000);
