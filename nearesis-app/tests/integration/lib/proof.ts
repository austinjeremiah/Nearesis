/**
 * The proof leg of the audit step (ch.19 step 11, ch.25 "Failure propagation"): the real proof orchestration of
 * packages/capsule with a recorded (fixture) attester, or an attester that is unavailable. No signer is registered
 * with OutLayer and no live job runs; a recorded proof is always labelled fixture evidence.
 */
import { readFileSync } from "node:fs";
import {
  buildCapsule,
  createTdxQuoteVerifier,
  proofUiText,
  runProofJob,
  sha256Hex,
  type Attester,
  type ProofJobResult,
} from "../../../packages/capsule/src/index.ts";
import { WASM, committedPolicy, testSigner } from "../../../packages/capsule/test/helpers.ts";
import { MRTD_GOOD, fixturePki, mintOutlayerEvidence } from "../../../packages/capsule/test/tdx-fixture.ts";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { SNAPSHOT_DIR } from "./research.ts";

export type ProofMode = "unavailable" | "recorded";
export interface ProofOutcome {
  mode: ProofMode;
  status: "blocked" | "recorded";
  reason: string | null;
  result: ProofJobResult | null;
  ui: string;
  /** Gate record the audit step writes: the proof gate never passes on unavailable evidence. */
  gate: {
    gate: "proof";
    status: "BLOCKED" | "FIXTURE_PASS";
    humanReview: boolean;
    reason: string | null;
    liveHalf: string;
  };
}

export async function proofStep(mode: ProofMode): Promise<ProofOutcome> {
  const live = "BLOCKED_DEPENDENCY BLK-20261110-003";
  if (mode === "unavailable") {
    const reason = "OutLayer proof provider unavailable";
    return {
      mode,
      status: "blocked",
      reason,
      result: null,
      ui: `Proof: blocked (${reason}). Human review is required before any claim of complete verification. Live OutLayer proof: ${live}.`,
      gate: { gate: "proof", status: "BLOCKED", humanReview: true, reason, liveHalf: live },
    };
  }
  const signer = testSigner();
  const pki = fixturePki();
  const policy = { ...committedPolicy([signer.signer]), allowedMeasurements: [MRTD_GOOD] };
  const quoteVerifier = createTdxQuoteVerifier({ production: [], fixture: [pki.rootSha256] });
  const manifest = buildCapsule({
    snapshotDir: SNAPSHOT_DIR,
    outDir: mkdtempSync(join(tmpdir(), "proof-ref-")),
  });
  const attest: Attester = (r) =>
    mintOutlayerEvidence(signer, {
      wasmSha256: r.wasmSha256,
      inputSha256: r.inputSha256,
      outputSha256: r.outputSha256,
    });
  const result = await runProofJob({
    snapshotDir: SNAPSHOT_DIR,
    expectedDataHash: manifest.snapshot.dataHash,
    wasmPath: WASM,
    policy,
    quoteVerifier,
    attest,
  });
  const accepted = result.gate === "PASS" && result.evidenceSource === "fixture";
  return {
    mode,
    status: "recorded",
    reason: accepted ? null : result.reasons.join(","),
    result,
    ui: `${proofUiText(result)} The attestation covers the computation over the frozen bytes, not the accuracy of the data.`,
    gate: {
      gate: "proof",
      status: accepted ? "FIXTURE_PASS" : "BLOCKED",
      humanReview: !accepted,
      reason: accepted ? "recorded fixture evidence; not OutLayer-backed" : result.reasons.join(","),
      liveHalf: live,
    },
  };
}
export const wasmSha = (): string => sha256Hex(readFileSync(WASM));
