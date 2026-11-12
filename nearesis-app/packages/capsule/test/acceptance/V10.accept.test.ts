import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  FIXTURE_BADGE,
  buildCapsule,
  createTdxQuoteVerifier,
  proofUiText,
  runProofJob,
  sha256Hex,
  treeHashOf,
} from "../../src/index.ts";
import type { Attester } from "../../src/index.ts";
import { SNAPSHOT, WASM, committedPolicy, liveOutlayerV10, testSigner, tmp } from "../helpers.ts";
import { MRTD_GOOD, fixturePki, mintOutlayerEvidence } from "../tdx-fixture.ts";

/** V10 (16b): attested result versus reproducible local recomputation. FIXTURE half executes; the LIVE half is BLOCKED. */
it("V10: attested output equals local recomputation; hash mismatch refuses early; a failed proof withholds the badge but not the rebuild", async () => {
  const wasm = sha256Hex(readFileSync(WASM));
  const signer = testSigner();
  const pki = fixturePki();
  const policy = { ...committedPolicy([signer.signer]), allowedMeasurements: [MRTD_GOOD] };
  const quoteVerifier = createTdxQuoteVerifier({ production: [], fixture: [pki.rootSha256] });
  const dir = tmp("v10-");
  const manifest = buildCapsule({ snapshotDir: SNAPSHOT, outDir: dir });
  let requests = 0;
  const attester =
    (quote?: { debug?: boolean }): Attester =>
    (r) => {
      requests++;
      return mintOutlayerEvidence(
        signer,
        { wasmSha256: r.wasmSha256, inputSha256: r.inputSha256, outputSha256: r.outputSha256 },
        { ...(quote ? { quote } : {}) },
      );
    };
  const common = {
    wasmPath: WASM,
    policy,
    quoteVerifier,
    expectedDataHash: manifest.snapshot.dataHash,
  };

  // 1. matched snapshot: attested output equals the local recomputation
  const ok = await runProofJob({ ...common, snapshotDir: SNAPSHOT, attest: attester() });
  expect(requests).toBe(1);
  expect(ok.refused).toBeNull();
  expect(ok.wasi.ran).toBe(true);
  expect(ok.attestedOutputSha256).toBe(ok.local.outputSha256);
  expect(ok.attestedOutputSha256).toBe(ok.wasi.outputSha256);
  expect(ok.attestedOutputSha256).toBe(manifest.computation.resultsSha256);
  expect(ok.localReproduction).toBe("reproduced");
  expect(ok.badge).toBe(FIXTURE_BADGE);
  expect(ok.evidenceSource).toBe("fixture");
  expect(ok.gate).toBe("PASS");

  // 2. unmatched snapshots are refused before any attestation request
  const before = requests;
  const flipped = tmp("v10-flip-");
  cpSync(SNAPSHOT, flipped, { recursive: true });
  const csv = join(flipped, "raw", "daily_series.csv");
  const b = readFileSync(csv);
  b[b.length - 3] = b[b.length - 3] === 0x31 ? 0x32 : 0x31;
  writeFileSync(csv, b);
  const r1 = await runProofJob({ ...common, snapshotDir: flipped, attest: attester() });
  // a consistent but different snapshot: descriptor re-hashed by the attacker
  const rehashed = tmp("v10-rehash-");
  cpSync(flipped, rehashed, { recursive: true });
  const desc = JSON.parse(readFileSync(join(rehashed, "snapshot.json"), "utf8")) as {
    files: Array<{ sha256: string; bytes: number }>;
  };
  desc.files[0]!.sha256 = sha256Hex(b);
  writeFileSync(join(rehashed, "snapshot.json"), JSON.stringify(desc));
  const r2 = await runProofJob({ ...common, snapshotDir: rehashed, attest: attester() });
  expect(r1.refused?.reason).toBe("SNAPSHOT_HASH_MISMATCH");
  expect(r2.refused?.reason).toBe("SNAPSHOT_HASH_MISMATCH");
  expect(r1.attestationRequested || r2.attestationRequested).toBe(false);
  expect(requests).toBe(before);
  expect(r1.gate).toBe("REFUSED");

  // 3. failing attestation with a correct local recomputation
  const dashBefore = treeHashOf(dir);
  const bad = await runProofJob({ ...common, snapshotDir: SNAPSHOT, attest: attester({ debug: true }) });
  expect(bad.localReproduction).toBe("reproduced");
  expect(bad.local.outputSha256).toBe(manifest.computation.resultsSha256);
  expect(bad.badge).toBeNull(); // a build granting the badge because local recomputation matched must fail here
  expect(bad.gate).toBe("FAIL");
  expect(bad.humanReview).toBe(true);
  expect(bad.reasons).toEqual(["QUOTE_DEBUG_MODE"]);
  const rebuilt = tmp("v10-rebuild-");
  const m2 = buildCapsule({ snapshotDir: SNAPSHOT, outDir: rebuilt });
  expect(m2.capsuleHash).toBe(manifest.capsuleHash);
  expect(treeHashOf(rebuilt)).toEqual(dashBefore);

  // 4. live half is blocked and the UI says so; no badge is synthesised
  const ui = proofUiText(ok);
  expect(ok.liveHalf.status).toBe("BLOCKED_DEPENDENCY");
  expect(ui).toContain("BLOCKED_DEPENDENCY");
  expect(ui).toContain("not OutLayer-backed");
  expect(proofUiText(bad)).toContain("badge is withheld");
  expect(ok.badge).not.toBe("attested");

  // 5. LIVE half (--live): the recorded REAL OutLayer testnet job on this very snapshot, verified under the pinned Intel root
  const liveRun = process.env.NEARESIS_ACCEPT_LIVE === "1";
  let liveSummary: Record<string, unknown> | null = null;
  if (liveRun) {
    const live = liveOutlayerV10();
    const liveOk = await runProofJob({ ...common, snapshotDir: SNAPSHOT, attest: attester(), live });
    expect(liveOk.liveHalf.status).toBe("LIVE");
    expect(liveOk.liveHalf.reasons).toBeUndefined();
    expect(liveOk.liveHalf.collateralChecked).toBe(false);
    expect(liveOk.liveBadge).toContain("OutLayer testnet job");
    expect(proofUiText(liveOk)).toContain("Live OutLayer proof: LIVE");
    expect(live.record.wasm_hash).toBe(wasm);
    expect(JSON.parse(live.outputText).results_sha256).toBe(manifest.computation.resultsSha256);
    // negative controls: each defect must end FAILED with no live badge, and never LIVE
    const flip = (s: string) => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");
    const bads: Array<[string, typeof live, string]> = [
      [
        "output hash flipped",
        { ...live, record: { ...live.record, output_hash: flip(live.record.output_hash) } },
        "OUTPUT_HASH_MISMATCH",
      ],
      [
        "binding broken",
        { ...live, record: { ...live.record, task_id: live.record.task_id + 1 } },
        "RESPONSE_BINDING_MISMATCH",
      ],
      [
        "unpinned root",
        { ...live, policy: { ...live.policy, quoteTrustRootSha256: [] } },
        "QUOTE_ROOT_NOT_TRUSTED",
      ],
      [
        "input is another snapshot",
        { ...live, inputData: live.inputData.replace("2026", "2025") },
        "INPUT_HASH_MISMATCH",
      ],
    ];
    for (const [name, l, code] of bads) {
      const r = await runProofJob({ ...common, snapshotDir: SNAPSHOT, attest: attester(), live: l });
      expect(r.liveHalf.status, name).toBe("FAILED");
      expect(r.liveHalf.reasons, name).toContain(code);
      expect(r.liveBadge, name).toBeNull();
      expect(proofUiText(r), name).not.toContain("LIVE (");
    }
    // a record for a different snapshot's output is not this snapshot's proof
    const other = JSON.parse(live.outputText) as Record<string, unknown>;
    other.results_sha256 = "0".repeat(64);
    const otherText = JSON.stringify(other);
    const wrongOut = await runProofJob({
      ...common,
      snapshotDir: SNAPSHOT,
      attest: attester(),
      live: { ...live, outputText: otherText },
    });
    expect(wrongOut.liveHalf.status).toBe("FAILED");
    expect(wrongOut.liveBadge).toBeNull();
    // the fixture run in the same process stays fixture-labelled: nothing upgrades it to live
    expect(ok.evidenceSource).toBe("fixture");
    expect(ok.liveBadge).toBeNull();
    liveSummary = {
      requestId: live.record.request_id,
      txHash: live.record.transaction_hash,
      status: liveOk.liveHalf.status,
      badge: liveOk.liveBadge,
      collateralChecked: false,
      negativeControlsRejected: bads.length + 1,
    };
  }

  observe({
    testId: "V10",
    observed: `FIXTURE half: attested output ${ok.attestedOutputSha256!.slice(0, 16)} equals the TypeScript reference and the local WASI run (localReproduction reproduced); badge "${ok.badge}"; evidenceSource fixture. Altered snapshot (byte flip, and re-hashed descriptor) refused before any attestation request (requests ${before} -> ${requests}). Debug-quote attestation: badge withheld, gate FAIL, human review set, capsule and static dashboard rebuilt byte-identically (capsuleHash equal). ${liveSummary ? `LIVE half: executed against the recorded OutLayer testnet job ${String(liveSummary.requestId)} (tx ${String(liveSummary.txHash)}) on this snapshot. TDX quote chained to the pinned Intel SGX root, report data bound to the job record, wasm hash equals the local artifact, input equals the snapshot input, attested output equals the local recomputation; liveHalf LIVE. 5 negative controls (flipped output hash, broken binding, unpinned root, other input, other output) each FAILED with no live badge. Intel PCS collateral (TCB level, QE identity, CRLs) is NOT checked.` : `LIVE half: ${ok.liveHalf.status} citing ${ok.liveHalf.reference}; no live badge produced.`}`,
    fixtureHash: wasm,
    evidence: {
      okGate: ok.gate,
      refusals: [r1.refused, r2.refused],
      badGate: bad.gate,
      badReasons: bad.reasons,
      liveHalf: liveSummary ? { status: "LIVE", ...liveSummary } : ok.liveHalf,
      uiText: ui,
    },
  });
}, 300_000);
