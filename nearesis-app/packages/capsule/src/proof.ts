import { readFileSync } from "node:fs";
import type { AttestationEvidence, AttestationPolicy } from "@nearesis/contracts";
import { verifyAttestation } from "./attestation.ts";
import { verifyOutlayerLive } from "./attest-outlayer.ts";
import type { OutlayerAttestationRecord, OutlayerLivePolicy } from "./attest-outlayer.ts";
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
/** Wording for a real OutLayer testnet job whose TDX quote chained to the pinned Intel root. Collateral is not checked. */
export const LIVE_OUTLAYER_BADGE =
  "attested (OutLayer testnet job, TDX quote chained to the pinned Intel SGX root; Intel PCS collateral not checked)";

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
  /** A recorded REAL OutLayer attestation for this snapshot's input; verified by `verifyOutlayerLive`, never by the fixture path. */
  live?: LiveProofInput;
}

export interface LiveProofInput {
  record: OutlayerAttestationRecord;
  /** The exact `input_data` string the chain recorded for the job. */
  inputData: string;
  /** The exact output the job returned (the bytes whose sha256 is the record's `output_hash`). */
  outputText: string;
  policy: OutlayerLivePolicy;
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
  /** Set only when a real OutLayer record verified and its output equals the local recomputation. */
  liveBadge: string | null;
  liveHalf: {
    status: "BLOCKED_DEPENDENCY" | "LIVE" | "FAILED";
    reference: string;
    requestId?: number;
    txHash?: string;
    reasons?: string[];
    collateralChecked?: false;
  };
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
    liveBadge: null,
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
  const live = o.live
    ? checkLive(o.live, { input, wasmSha256, localOut, wasiStdout: w.ran ? w.stdout : null })
    : null;
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
    ...(live ? { liveHalf: live.liveHalf, liveBadge: live.liveBadge } : {}),
  };
}

function checkLive(
  l: LiveProofInput,
  c: { input: unknown; wasmSha256: string; localOut: string; wasiStdout: Buffer | null },
): Pick<ProofJobResult, "liveHalf" | "liveBadge"> {
  const d = verifyOutlayerLive(l.record, l.policy, {
    localWasmSha256: c.wasmSha256,
    inputData: l.inputData,
    expectedOutputSha256: sha256Hex(l.outputText),
  });
  const reasons = [...d.reasons];
  // the job must have run on THIS snapshot, and its output must be the local recomputation
  if (l.inputData !== canonicalJson(c.input)) reasons.push("LIVE_INPUT_NOT_THE_SNAPSHOT");
  let attested: string | null = null;
  try {
    attested = (JSON.parse(l.outputText) as { results_sha256?: string }).results_sha256 ?? null;
  } catch {
    /* unparseable output is a mismatch below */
  }
  if (attested !== c.localOut) reasons.push("LIVE_OUTPUT_DIFFERS_FROM_LOCAL");
  if (c.wasiStdout) {
    const text = c.wasiStdout.toString("utf8");
    if (text !== l.outputText && text.trimEnd() !== l.outputText)
      reasons.push("LIVE_OUTPUT_DIFFERS_FROM_LOCAL_WASI");
  }
  const reference = `OutLayer testnet request ${l.record.request_id}, tx ${l.record.transaction_hash}`;
  const common = {
    reference,
    requestId: l.record.request_id,
    txHash: l.record.transaction_hash,
    collateralChecked: false as const,
  };
  return reasons.length === 0
    ? { liveHalf: { status: "LIVE", ...common }, liveBadge: LIVE_OUTLAYER_BADGE }
    : { liveHalf: { status: "FAILED", ...common, reasons }, liveBadge: null };
}

/** The line the UI shows for the proof state. It never synthesises a badge the verified record does not support. */
export function proofUiText(r: ProofJobResult): string {
  const live =
    r.liveHalf.status === "LIVE" && r.liveBadge
      ? `Live OutLayer proof: LIVE (${r.liveHalf.reference}); ${r.liveBadge}.`
      : `Live OutLayer proof: ${r.liveHalf.status} (${r.liveHalf.reference}); no live badge is shown.`;
  if (r.refused) return `Proof job refused before any attestation request (${r.refused.reason}). ${live}`;
  if (r.badge === null)
    return `Attestation failed (${r.reasons.join(", ")}); the attested badge is withheld, the gate is ${r.gate} and human review is required. Local reproduction: ${r.localReproduction}. ${live}`;
  return `${r.badge}. Local reproduction: ${r.localReproduction}. ${live}`;
}
