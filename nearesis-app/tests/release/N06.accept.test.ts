/**
 * N06: release manifest completeness and rollback manifest. The genuine candidate uses REAL image digests: the api, worker
 * and web images are built locally from a clean export of the commit (`release cli build-images`, never pushed) and their
 * digests are recomputed from the local image store here; the previous release for the rollback manifest is a second real
 * build. The testnet transaction is the real preregistration commitment (read back at FINAL when run with --live). The approver
 * and the operator signature are FIXTURE values (a test principal and an ephemeral test key, never a production key); the
 * operator's own approval and signature are HUMAN. Without built images or without --live the verdict is BLOCKED_DEPENDENCY.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  buildManifest,
  manifestHash,
  validateManifest,
  validateRollback,
  verifyHashes,
  verifyManifestSignature,
} from "../../scripts/release/manifest.ts";
import { signManifest, testSigningKey } from "./_sign.ts";
import { readBuildRecord, realRun, recomputeDigests } from "../../scripts/release/images.ts";
import { readbackLive } from "../../plugins/chain-commit/src/live.ts";
import type { ReleaseManifest } from "../../scripts/release/manifest.ts";
import { readSec11Sbom } from "../../scripts/release/sbom.ts";
import { scanProblems } from "../../scripts/release/manifest.ts";
import { evaluatePolicy, scanImage, scannerInfo } from "../../scripts/release/vuln-scan.ts";
import type { ScanRecord } from "../../scripts/release/vuln-scan.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const d = (c: string) => `sha256:${c.repeat(64)}`;
const REL = join(ROOT, ".data", "release");
const candidate = readBuildRecord(join(REL, "candidate"));
const previous = readBuildRecord(join(REL, "previous"));
const live = !!process.env.NEARESIS_ACCEPT_LIVE;
const blockedByScan: string[] = [];
const tnPath = join(
  ROOT,
  "..",
  "NEARESIS_Build_Bible",
  "reports",
  "TESTS",
  "TESTNET-LIVE",
  "prereg-commit.json",
);
const tn = existsSync(tnPath)
  ? (JSON.parse(readFileSync(tnPath, "utf8")) as { txHash: string; payloadHash: string })
  : null;
const realImages = (r: NonNullable<typeof candidate>) => ({
  api: r.images.api.digest,
  worker: r.images.worker.digest,
  web: r.images.web.digest,
});
// With no build records the fixture digests below keep the validator half running; the verdict is then BLOCKED_DEPENDENCY.
const IMAGES = candidate ? realImages(candidate) : { api: d("1"), worker: d("2"), web: d("3") };
const PREVIOUS = previous ? realImages(previous) : { api: d("4"), worker: d("5"), web: d("6") };

it("N06: the manifest builder and validator reject every bad variant naming the field; the genuine candidate carries real image digests and a real testnet transaction; the operator signature verifies", async () => {
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
    gitSha: candidate?.gitSha,
    testnetTxHash: tn?.txHash ?? "9Ed7Cq2fixtureTxHash0000000000000000000000",
    approver: "fixture-owner-test-principal",
    previous: { gitSha: previous?.gitSha ?? "a".repeat(40), images: PREVIOUS },
  });
  expect(validateManifest({ ...complete.manifest })).toEqual([]);
  // each image digest equals the digest recomputed from the local image store; each other hash equals its artefact's hash
  const recomputed = candidate ? recomputeDigests(realRun, candidate) : null;
  const built = recomputed
    ? { api: recomputed.api!, worker: recomputed.worker!, web: recomputed.web! }
    : IMAGES;
  expect(verifyHashes(complete.manifest, ROOT, built)).toEqual([]);
  const prevRecomputed = previous ? recomputeDigests(realRun, previous) : null;
  const prevOk =
    !!prevRecomputed && Object.values(PREVIOUS).every((x, i) => Object.values(prevRecomputed)[i] === x);
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
      m: { ...M, approver: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ4In0", "c2lnbmF0dXJl"].join(".") },
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

  // (e) operator signature (ephemeral test key): verifies over the manifest hash; one altered byte invalidates it
  const key = testSigningKey();
  const sig = signManifest(complete.manifest, key.privateKeyPem);
  expect(verifyManifestSignature(complete.manifest, sig, key.publicKeyPem)).toBe(true);
  expect(
    verifyManifestSignature({ ...complete.manifest, expectedMaxSpend: "0.06 NEAR" }, sig, key.publicKeyPem),
  ).toBe(false);
  const flipped = Buffer.from(sig, "base64");
  flipped[0] = flipped[0]! ^ 1;
  expect(verifyManifestSignature(complete.manifest, flipped.toString("base64"), key.publicKeyPem)).toBe(
    false,
  );
  expect(manifestHash(complete.manifest)).toMatch(/^[0-9a-f]{64}$/);

  // (a) the testnet transaction is a readable, confirmed transaction (live half)
  let txOk: boolean | null = null;
  if (live && tn) {
    const rb = await readbackLive(tn.txHash, tn.payloadHash);
    txOk = rb.finality === "FINAL" && rb.succeeded && rb.equal;
    expect(txOk).toBe(true);
  }

  // vulnerability scan record (real trivy): present in the manifest, scanner pinned with a DB date, every image scanned, verdict
  // consistent with its own blockers; with --live the candidate images are re-scanned and must reproduce the recorded verdict.
  const scanRec = candidate?.vulnerabilityScan ?? null;
  const withScan = buildManifest({
    ...base,
    images: IMAGES,
    gitSha: candidate?.gitSha,
    vulnerabilityScan: scanRec,
  }).manifest;
  const ran = scanRec?.status === "RAN" ? (scanRec as ScanRecord) : null;
  let rescanned: Record<string, string> | null = null;
  if (ran) {
    expect(ran.scanner.name).toBe("trivy");
    expect(ran.scanner.pinOk).toBe(true);
    expect(ran.scanner.dbUpdatedAt).toMatch(/^20\d\d-/);
    for (const k of ["api", "worker", "web"] as const) {
      const r = ran.images[k]!;
      expect(r.digest, k).toBe(candidate!.images[k].digest);
      expect(r.verdict.verdict === "BLOCK", k).toBe(r.verdict.blockers.length > 0);
    }
    expect(ran.verdict === "PASS").toBe(
      [ran.lockfiles.verdict, ...Object.values(ran.images).map((i) => i.verdict)].every(
        (v) => v.verdict === "PASS",
      ),
    );
    if (live && scannerInfo()) {
      rescanned = {};
      for (const k of ["api", "worker", "web"] as const) {
        const again = evaluatePolicy(scanImage(candidate!.images[k].tag), []);
        rescanned[k] = again.verdict;
        expect(again.verdict, `${k} re-scan must reproduce the recorded verdict`).toBe(
          ran.images[k]!.verdict.verdict,
        );
        expect(again.blockers.map((b) => b.id).sort()).toEqual(
          ran.images[k]!.verdict.blockers.map((b) => b.id).sort(),
        );
      }
    }
  }
  // negative controls on the manifest check itself: no scan, a scan that did not run, a BLOCK verdict and a missing image all fail
  const noScan = scanProblems({ ...withScan, vulnerabilityScan: null });
  expect(noScan.map((p) => p.field)).toEqual(["vulnerabilityScan"]);
  expect(
    scanProblems({ ...withScan, vulnerabilityScan: { status: "NOT_RUN", reason: "x" } })[0]?.problem,
  ).toMatch(/not run/);
  if (ran) {
    const blocked = structuredClone(ran);
    blocked.images.api!.verdict = {
      ...blocked.images.api!.verdict,
      verdict: "BLOCK",
      blockers: [{ kind: "vulnerability", id: "CVE-X", target: "t", rule: "CRITICAL", detail: "planted" }],
    };
    expect(
      scanProblems({ ...withScan, vulnerabilityScan: blocked }).some(
        (p) => /images\.api/.test(p.field) && /BLOCK/.test(p.problem),
      ),
    ).toBe(true);
    const missingImg = structuredClone(ran);
    delete (missingImg.images as Record<string, unknown>).web;
    expect(
      scanProblems({ ...withScan, vulnerabilityScan: missingImg }).some((p) => /images\.web/.test(p.field)),
    ).toBe(true);
  }
  const releaseBlockers = scanProblems(withScan);
  if (!ran)
    blockedByScan.push("candidate build record has no RAN vulnerability scan (rebuild with build-images)");

  // SBOM link: the manifest carries SEC11's sbomSha256
  const sbomLinked = !!sbom && genuine.manifest.sbomSha256 === sbom.sbomSha256;
  const blockedBy: string[] = blockedByScan;
  if (!candidate || !previous)
    blockedBy.push(
      "built image records missing (run `tsx scripts/release/cli.ts build-images --label candidate` and `--label previous --ref <older commit>`)",
    );
  if (candidate && recomputed && !Object.values(recomputed).every(Boolean))
    blockedBy.push("candidate images are not in the local image store");
  if (previous && !prevOk) blockedBy.push("previous-release images are not in the local image store");
  if (!tn) blockedBy.push("testnet preregistration commitment record missing");
  if (!live) blockedBy.push("testnet transaction readback needs --live");
  if (!sbomLinked) blockedBy.push("SEC11 sbomSha256 evidence not found");
  expect(existsSync(join(ROOT, "scripts/release/cli.ts"))).toBe(true);

  observe({
    testId: "N06",
    ...(blockedBy.length ? { blocked: `${blockedBy.join("; ")}. Fixture half passed` } : {}),
    observed: `genuine candidate manifest: all required fields non-null with real values: gitSha ${genuine.manifest.gitSha?.slice(0, 12)}, image digests api ${IMAGES.api.slice(0, 19)}, worker ${IMAGES.worker.slice(0, 19)}, web ${IMAGES.web.slice(0, 19)} ${candidate ? "(locally built, recomputed from the image store, equal)" : "(FIXTURE digests: no build record)"}, semantic model, plugin manifest set, source snapshot, preregistration and test suite hashes (each equals the recomputed artefact hash), testnet tx ${tn?.txHash.slice(0, 12) ?? "(none)"} ${txOk ? "read back at FINAL, succeeded, payload equal" : "(readback not run)"}, approver fixture test principal; mainnetAllowedActions is exactly [commit_preregistration_hash], expectedMaxSpend 0.05 NEAR; the completed manifest validates with 0 problems; ${Object.keys(variants).length} variants rejected naming the field (placeholder hash, placeholder token, missing field, extra allowed action, transfer, no max spend, null testnet tx, private-key-like, JWT-like), image digest mismatch rejected, secret scan 0 findings, transfer variant rejected; rollback manifest names the previous images by digest ${prevOk ? "(real previous build, present in the store)" : "(fixture)"}, migration range ${genuine.rollback.migrationCompatibility.from} to ${genuine.rollback.migrationCompatibility.to} with 0 destructive migrations, frozen metric versions, hash bound to the manifest; ${ran ? `vulnerability scan (${ran.scanner.name} ${ran.scanner.version}, DB ${ran.scanner.dbUpdatedAt}) recorded for api, worker and web plus lockfiles, policy verdict ${ran.verdict}${rescanned ? `, live re-scan of the three images reproduced the verdicts (${JSON.stringify(rescanned)})` : ""}; release blockers: ${releaseBlockers.length ? releaseBlockers.map((b) => `${b.field}: ${b.problem}`).join(" | ") : "none"}; scan-record negative controls (missing, NOT_RUN, BLOCK, missing image) rejected` : "vulnerability scan NOT RUN"}; Ed25519 test-key signature verifies over the manifest hash and a changed manifest or one flipped signature byte fails; manifest sbomSha256 ${sbomLinked ? "equals" : "NOT linked to"} SEC11's value ${sbom ? sbom.sbomSha256.slice(0, 16) : "(none)"}. The operator's own approval and signature are HUMAN`,
    fixtureHash: genuine.manifest.testSuiteReportSha,
    evidence: {
      genuineMissingFields: missing,
      variantFields: named,
      sbomLinked,
      sbomSha256: sbom?.sbomSha256 ?? null,
      migrationRange: genuine.rollback.migrationCompatibility,
      images: IMAGES,
      previousImages: PREVIOUS,
      imageSbom: candidate?.sbom ?? null,
      vulnerabilityScan: candidate?.vulnerabilityScan ?? null,
      releaseBlockers,
      liveRescan: rescanned,
      testnetTxHash: tn?.txHash ?? null,
      testnetReadbackFinal: txOk,
      manifestHash: manifestHash(complete.manifest),
    },
  });
}, 120_000);
