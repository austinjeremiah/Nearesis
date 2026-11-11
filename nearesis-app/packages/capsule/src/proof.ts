import { readFileSync } from "node:fs";
import type { AttestationEvidence, AttestationPolicy } from "@nearesis/contracts";
import { verifyAttestation } from "./attestation.ts";
import type { QuoteVerifier } from "./attestation.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { deriveVerifierInput, loadSnapshot } from "./snapshot.ts";
import { computeResults, resultsDigest } from "./verifier-ref.ts";
import { runWasi } from "./wasi.ts";

/**
 * Proof orchestration (ch.08 independent verification loop, ch.25 failure propagation, ch.19 step 11).
 *
 * 1. The proof job is refused, before any attestation request, unless the snapshot's hash matches the expected one.
 * 2. The metric is recomputed locally (TypeScript reference) and under the local WASI runner.
 * 3. Attestation is requested and passed through the proof policy.
 * 4. The attested output must equal the local recomputation. The badge exists only on an accepted record, and its
 *    wording says whether the evidence is fixture or live. A failed proof never blocks the local rebuild.
 */
export const FIXTURE_BADGE = "attested (fixture trust root, not OutLayer-backed)";
export const LIVE_BADGE = "attested";

export interface AttestRequest {
  inputBytes: Buffer;
  inputSha256: string;
  wasmSha256: string;
  /** The output the WASI run produced; a real attester would produce its own, the fixture attester reports this. */
  outputSha256: string;
}
export type Attester = (r: AttestRequest) => Promise<AttestationEvidence> | AttestationEvidence;

export interface ProofJobOptions {
  snapshotDir: string;
  /** The snapshot dataHash the proof job was approved for (capsule `snapshot.dataHash`). */
  expectedDataHash: string;
  wasmPath: string;
  policy: AttestationPolicy;
  attest: Attester;
  quoteVerifier?: QuoteVerifier;
  expectedJobId?: string;
  now?: Date;
}

export interface ProofJobResult {
  refused: null | { reason: "SNAPSHOT_HASH_MISMATCH" | "SNAPSHOT_INVALID"; detail: string };
  attestationRequested: boolean;
  local: { outputSha256: string | null };
  wasi: { ran: boolean; outputSha256: string | null };
  attestedOutputSha256: string | null;
  localReproduction: "reproduced" | "not_reproduced" | "not_run";
  decision: "accept" | "reject" | null;
  reasons: string[];
  evidenceSource: "fixture" | "live" | null;
  badge: string | null;
  gate: "PASS" | "FAIL" | "REFUSED";
  humanReview: boolean;
  liveHalf: { status: "BLOCKED_DEPENDENCY" | "LIVE"; reference: string };
}

const dataHashOf = (files: Array<{ path: string; sha256: string }>): string =>
  sha256Hex(
    files
      .map((f) => `${f.path}:${f.sha256}`)
      .sort()
      .join("\n"),
  );

export async function runProofJob(o: ProofJobOptions): Promise<ProofJobResult> {
  const base: ProofJobResult = {
    refused: null,
    attestationRequested: false,
    local: { outputSha256: null },
    wasi: { ran: false, outputSha256: null },
    attestedOutputSha256: null,
    localReproduction: "not_run",
    decision: null,
    reasons: [],
    evidenceSource: null,
    badge: null,
    gate: "REFUSED",
    humanReview: false,
    // No live OutLayer run exists in this repository (BLK-20261110-003); the UI must say so and synthesise no badge.
    liveHalf: { status: "BLOCKED_DEPENDENCY", reference: "BLK-20261110-003" },
  };
  let snap;
  try {
    snap = loadSnapshot(o.snapshotDir);
  } catch (e) {
    return {
      ...base,
      refused: { reason: "SNAPSHOT_HASH_MISMATCH", detail: (e as Error).message.slice(0, 200) },
    };
  }
  const actual = dataHashOf(snap.descriptor.files);
  if (actual !== o.expectedDataHash)
    return {
      ...base,
      refused: {
        reason: "SNAPSHOT_HASH_MISMATCH",
        detail: "snapshot dataHash differs from the approved dataHash",
      },
    };

  const input = deriveVerifierInput(snap.descriptor, snap.raw.get(snap.descriptor.series.file)!);
  const inputBytes = Buffer.from(`${canonicalJson(input)}\n`);
  const inputSha256 = sha256Hex(inputBytes);
  const localOut = resultsDigest(computeResults(input));
  const wasmBytes = readFileSync(o.wasmPath);
  const wasmSha256 = sha256Hex(wasmBytes);
  const w = runWasi(o.wasmPath, inputBytes);

  const evidence = await o.attest({
    inputBytes,
    inputSha256,
    wasmSha256,
    outputSha256: w.outputSha256 ?? localOut,
  });
  const d = await verifyAttestation(evidence, o.policy, {
    localWasmSha256: wasmSha256,
    expectedInputSha256: inputSha256,
    expectedOutputSha256: localOut,
    now: o.now ?? new Date(),
    ...(o.quoteVerifier ? { quoteVerifier: o.quoteVerifier } : {}),
    ...(o.expectedJobId ? { expectedJobId: o.expectedJobId } : {}),
  });
  const reproduced = w.ran && w.outputSha256 === localOut;
  const accepted = d.decision === "accept" && evidence.outputSha256 === localOut;
  return {
    ...base,
    attestationRequested: true,
    local: { outputSha256: localOut },
    wasi: { ran: w.ran, outputSha256: w.outputSha256 },
    attestedOutputSha256: evidence.outputSha256,
    localReproduction: !w.ran ? "not_run" : reproduced ? "reproduced" : "not_reproduced",
    decision: accepted ? "accept" : "reject",
    reasons: d.reasons,
    evidenceSource: d.evidenceSource ?? "fixture",
    badge: accepted ? (d.evidenceSource === "live" ? LIVE_BADGE : FIXTURE_BADGE) : null,
    gate: accepted ? "PASS" : "FAIL",
    humanReview: !accepted,
  };
}

/** The line the UI shows for the proof state. It never synthesises a badge the verified record does not support. */
export function proofUiText(r: ProofJobResult): string {
  const live = `Live OutLayer proof: ${r.liveHalf.status} (${r.liveHalf.reference}); no live badge is shown.`;
  if (r.refused) return `Proof job refused before any attestation request (${r.refused.reason}). ${live}`;
  if (r.badge === null)
    return `Attestation failed (${r.reasons.join(", ")}); the attested badge is withheld, the gate is ${r.gate} and human review is required. Local reproduction: ${r.localReproduction}. ${live}`;
  return `${r.badge}. Local reproduction: ${r.localReproduction}. ${live}`;
}
