import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCapsule,
  canonicalJson,
  checkPublication,
  compareReadback,
  canonicalDocHash,
  computeResults,
  inputDigest,
  loadCapsuleView,
  readManifest,
  resultsDigest,
  validateInput,
  verifyCapsule,
} from "../src/index.ts";
import type { VerifierInput } from "../src/index.ts";
import { CapsuleViewRecord } from "@nearesis/contracts";
import { APP, RESEARCH_BUNDLE, SNAPSHOT, WASM, tmp } from "./helpers.ts";

const FIX = join(APP, "services", "outlayer-verifier", "fixtures");

describe("TypeScript reference verifier matches the WASM fixtures", () => {
  const manifest = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8")) as {
    fixtures: Array<{ fixture: string; status: string; expected_output?: string }>;
  };
  for (const f of manifest.fixtures.filter((x) => /^f0/.test(x.fixture))) {
    it(`${f.fixture}: digests equal the WASM output`, () => {
      const input = JSON.parse(readFileSync(join(FIX, f.fixture), "utf8")) as VerifierInput;
      const want = JSON.parse(f.expected_output!) as {
        input_sha256: string;
        results_sha256: string;
        results?: unknown;
      };
      expect(validateInput(input)).toBeNull();
      const results = computeResults(input);
      expect(inputDigest(input)).toBe(want.input_sha256);
      expect(resultsDigest(results)).toBe(want.results_sha256);
      if (want.results) expect(canonicalJson(results)).toBe(canonicalJson(want.results));
    });
  }
  it("rejects the invalid-input fixtures that parse as JSON", () => {
    let rejected = 0;
    for (const n of readdirSync(FIX).filter((x) => /^i0[1-8]/.test(x))) {
      let parsed: VerifierInput;
      try {
        parsed = JSON.parse(readFileSync(join(FIX, n), "utf8")) as VerifierInput;
      } catch {
        rejected++;
        continue;
      }
      try {
        if (validateInput(parsed) !== null) rejected++;
      } catch {
        rejected++;
      }
    }
    expect(rejected).toBe(8);
  });
});

describe("capsule build", () => {
  it("is deterministic and verifies locally", async () => {
    const a = tmp();
    const b = tmp();
    const ma = buildCapsule({ snapshotDir: SNAPSHOT, outDir: a, researchBundleDir: RESEARCH_BUNDLE });
    const mb = buildCapsule({ snapshotDir: SNAPSHOT, outDir: b, researchBundleDir: RESEARCH_BUNDLE });
    expect(ma.capsuleHash).toBe(mb.capsuleHash);
    expect(readManifest(a)?.capsuleHash).toBe(ma.capsuleHash);
    const rep = await verifyCapsule(a, { research: "skip", wasm: "skip" });
    expect(rep.status).toBe("reproduced");
    expect(rep.checks).toEqual([
      "capsuleHash",
      "fileHashes",
      "dataHash",
      "inputRederivation",
      "resultsRecomputation",
    ]);
  });

  it("serves the exact record the viewer expects, with local and OutLayer kept apart", async () => {
    const a = tmp();
    buildCapsule({ snapshotDir: SNAPSHOT, outDir: a });
    const v = await loadCapsuleView(a, { research: "skip", wasm: "skip" });
    expect(CapsuleViewRecord.safeParse(v).success).toBe(true);
    expect(v!.sourceLabel).toBe("SYNTHETIC");
    expect(v!.verification.local.status).toBe("reproduced");
    expect(v!.verification.local.method).toContain("local");
    expect(v!.verification.outlayer).toMatchObject({ status: "not_submitted", jobId: null });
    expect(v!.provenance.some((n) => n.kind === "claim")).toBe(true);
    for (const n of v!.provenance)
      for (const p of n.parents) expect(v!.provenance.some((x) => x.id === p)).toBe(true);
  });

  it("every claim cites only existing results", () => {
    const a = tmp();
    const m = buildCapsule({ snapshotDir: SNAPSHOT, outDir: a, researchBundleDir: RESEARCH_BUNDLE });
    const ids = new Set(m.results.map((r) => r.id));
    for (const c of m.claims) for (const r of c.resultIds) expect(ids.has(r)).toBe(true);
    expect(existsSync(join(a, "exports", "site", "index.html"))).toBe(true);
  });

  it("an unsupported number in author notes blocks the build and leaves no capsule", () => {
    const a = tmp();
    expect(() =>
      buildCapsule({ snapshotDir: SNAPSHOT, outDir: a, extraThesisNotes: ["Volume rose 45% last week."] }),
    ).toThrow(/publication check blocked/);
    expect(existsSync(join(a, "manifest.json"))).toBe(false);
    expect(existsSync(join(a, "exports"))).toBe(false);
  });
});

describe("publication check", () => {
  const results = [
    { id: "n", value: "90" },
    { id: "r", value: "0.212024" },
  ];
  it("accepts cited, matching numbers and exempts dates, hashes and fences", () => {
    const md = [
      "Over 90 days [R:n] the correlation is 0.212024 [R:r].",
      "Window 2026-08-13 to 2026-11-10 with hash e08dd7e47f87933ff1e838a69008ddb04c4a4a8a5f839c581c136c43ffc52888.",
      "```",
      "seed 20261111",
      "```",
    ].join("\n");
    expect(checkPublication(md, results)).toMatchObject({ ok: true });
  });
  it("blocks missing, unknown and mismatching citations", () => {
    const kinds = checkPublication(
      ["Volume doubled 2x.", "Value 3 [R:nope].", "Value 91 [R:n]."].join("\n"),
      results,
    ).violations.map((v) => v.kind);
    expect(kinds).toEqual(["MISSING_CITATION", "UNKNOWN_RESULT", "VALUE_NOT_IN_RESULT"]);
  });
});

describe("prereg readback comparison (offline logic only)", () => {
  const doc = { b: 1, a: "x" };
  it("equal only for the canonical hash on the expected network", () => {
    const h = canonicalDocHash({ a: "x", b: 1 });
    expect(compareReadback(doc, { network: "testnet", payloadHash: `sha256:${h}` }, "testnet").equal).toBe(
      true,
    );
    expect(compareReadback(doc, { network: "mainnet", payloadHash: h }, "testnet").reasons).toContain(
      "NETWORK_MISMATCH",
    );
    expect(
      compareReadback(doc, { network: "testnet", payloadHash: "0".repeat(64) }, "testnet").reasons,
    ).toContain("HASH_MISMATCH");
  });
});

it("the committed policy pins the shipped wasm (drift check)", async () => {
  const { sha256Hex } = await import("../src/index.ts");
  const { committedPolicy } = await import("./helpers.ts");
  expect(committedPolicy([]).allowedWasmSha256).toEqual([sha256Hex(readFileSync(WASM))]);
});
