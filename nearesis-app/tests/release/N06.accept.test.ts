/**
 * N06: release manifest completeness and rollback manifest. Builder, validator, variants, hash verification, secret scan,
 * rollback manifest and the SEC11 SBOM hash link run here. BLOCKED_DEPENDENCY for what only humans or the testnet can
 * supply: built image digests (no production images exist), a confirmed testnet transaction (N01), the human approver id,
 * previous-release image digests, and the operator signature (no signing is performed by agents).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  buildManifest,
  validateManifest,
  validateRollback,
  verifyHashes,
} from "../../scripts/release/manifest.ts";
import type { ReleaseManifest } from "../../scripts/release/manifest.ts";
import { readSec11Sbom } from "../../scripts/release/sbom.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const d = (c: string) => `sha256:${c.repeat(64)}`;
const IMAGES = { api: d("1"), worker: d("2"), web: d("3") };

it("N06: the manifest builder and validator reject every bad variant naming the field; the genuine candidate lacks only human or testnet inputs", () => {
  const sbom = readSec11Sbom(ROOT);
  const base = {
    root: ROOT,
    expectedMaxSpend: "0.05 NEAR",
    balanceCeiling: "10",
    feeCeiling: "1",
    sbomSha256: sbom?.sbomSha256 ?? null,
  };

  // the genuine candidate from this repository: every locally computable field is real; the rest are named human inputs
  const genuine = buildManifest(base);
  const genuineProblems = validateManifest({ ...genuine.manifest });
  const missing = genuineProblems.map((p) => p.field).sort();
  expect(missing).toEqual(["approver", "images.api", "images.web", "images.worker", "testnetTxHash"].sort());
  expect(genuine.manifest.gitSha).toMatch(/^[0-9a-f]{40}$/);
  for (const f of [
    "semanticModelSha",
    "pluginManifestSetSha",
    "sourceSnapshotSha",
    "preregistrationSha",
    "testSuiteReportSha",
  ] as const)
    expect(genuine.manifest[f], f).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(genuine.manifest.mainnetAllowedActions).toEqual(["commit_preregistration_hash"]); // (b)
  expect(genuine.manifest.expectedMaxSpend).toBe("0.05 NEAR");
  expect(genuine.rollback.migrationCompatibility.destructive).toEqual([]); // expand/contract only
  expect(genuine.rollback.migrationCompatibility.from).toMatch(/migrations/);
  expect(Object.keys(genuine.rollback.frozenMetricVersions).length).toBeGreaterThan(0);

  // the same manifest completed with fixture-labelled human inputs validates fully, so the validator accepts a complete manifest
  const complete = buildManifest({
    ...base,
    images: IMAGES,
    testnetTxHash: "9Ed7Cq2fixtureTxHash0000000000000000000000",
    approver: "owner-1",
    previous: { gitSha: "a".repeat(40), images: { api: d("4"), worker: d("5"), web: d("6") } },
  });
  expect(validateManifest({ ...complete.manifest })).toEqual([]);
  expect(verifyHashes(complete.manifest, ROOT, IMAGES)).toEqual([]); // each hash equals the recomputed artefact hash
  expect(validateRollback(complete.rollback, complete.manifest)).toEqual([]); // (d)
  // tampering with the rollback manifest breaks its recorded hash
  expect(
    validateRollback({ ...complete.rollback, previousGitSha: "b".repeat(40) }, complete.manifest).map(
      (p) => p.field,
    ),
  ).toContain("rollbackManifestSha");

  // (c) variants
  const M = complete.manifest;
  const variants: Record<string, { m: ReleaseManifest & Record<string, unknown>; field: RegExp }> = {
    placeholderHash: { m: { ...M, semanticModelSha: d("0") }, field: /^semanticModelSha$/ },
    placeholderToken: { m: { ...M, sourceSnapshotSha: "sha256:<hash>" }, field: /^sourceSnapshotSha$/ },
    missingField: { m: { ...M, pluginManifestSetSha: null }, field: /^pluginManifestSetSha$/ },
    extraAllowedAction: {
      m: { ...M, mainnetAllowedActions: ["commit_preregistration_hash", "transfer"] },
      field: /^mainnetAllowedActions$/,
    },
    transferOnly: { m: { ...M, mainnetAllowedActions: ["transfer"] }, field: /^mainnetAllowedActions$/ },
    noMaxSpend: { m: { ...M, expectedMaxSpend: null }, field: /^expectedMaxSpend$/ },
    nullTestnetTx: { m: { ...M, testnetTxHash: null }, field: /^testnetTxHash$/ },
    privateKeyLike: { m: { ...M, approver: "ed25519:" + "3a".repeat(32) + "AbCdEfGh" }, field: /^approver$/ },
    jwtLike: {
      m: { ...M, approver: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl" },
      field: /^approver$/,
    },
  };
  const named: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(variants)) {
    const p = validateManifest(v.m);
    expect(
      p.some((x) => v.field.test(x.field)),
      k,
    ).toBe(true);
    named[k] = p.map((x) => x.field);
  }
  const imageMismatch = verifyHashes(M, ROOT, { ...IMAGES, web: d("7") });
  expect(imageMismatch.map((p) => p.field)).toEqual(["images.web"]);
  expect(validateManifest({ ...M }).filter((p) => /contains/.test(p.problem))).toEqual([]); // secret scan of the genuine manifest: 0
  const transferRejected = validateManifest(variants.transferOnly!.m).some(
    (p) => p.field === "mainnetAllowedActions",
  );
  expect(transferRejected).toBe(true);

  // SBOM link: the manifest carries SEC11's sbomSha256
  const sbomLinked = !!sbom && genuine.manifest.sbomSha256 === sbom.sbomSha256;
  const humanNeeds = [
    "built image digests (no production container images exist yet)",
    "confirmed testnet transaction hash (N01, needs a testnet write)",
    "human approver id",
    "previous-release image digests for the rollback manifest",
    "operator signature over the manifest hash (no signing by agents)",
  ];
  expect(existsSync(join(ROOT, "scripts/release/cli.ts"))).toBe(true);

  observe({
    testId: "N06",
    blocked: `HUMAN-required inputs missing: ${humanNeeds.join("; ")}${sbomLinked ? "" : "; SEC11 sbomSha256 evidence not found (SBOM link unverified)"}. Fixture half passed: builder, validator, variants, hash recomputation, secret scan and rollback manifest`,
    observed: `candidate manifest from this repository: git sha, semantic model, plugin manifest set, source snapshot, preregistration, test suite hashes are real recomputable sha256 values and mainnetAllowedActions is exactly [commit_preregistration_hash]; only ${missing.join(", ")} are missing (human or testnet inputs); a completed manifest validates with 0 problems and all hashes match recomputation; ${Object.keys(variants).length} variants rejected naming the field (placeholder hash, placeholder token, missing field, extra allowed action, transfer, no max spend, null testnet tx, private-key-like, JWT-like), image digest mismatch rejected, secret scan 0 findings, transfer variant rejected; rollback manifest has previous images, migration range ${genuine.rollback.migrationCompatibility.from} to ${genuine.rollback.migrationCompatibility.to} with 0 destructive migrations, frozen metric versions, and its hash is bound to the manifest; manifest sbomSha256 ${sbomLinked ? "equals" : "NOT linked to"} SEC11's recorded value ${sbom ? sbom.sbomSha256.slice(0, 16) : "(none)"}`,
    fixtureHash: genuine.manifest.testSuiteReportSha,
    evidence: {
      genuineMissingFields: missing,
      variantFields: named,
      sbomLinked,
      sbomSha256: sbom?.sbomSha256 ?? null,
      migrationRange: genuine.rollback.migrationCompatibility,
      humanNeeds,
    },
  });
});
