import { ProofRecord } from "@nearesis/contracts";
import { sha256Hex } from "./canonical.ts";

/** A hash that is obviously not a measurement: one repeated nibble, or a repeating 0-f counter. */
export function isPlaceholderHash(h: string): boolean {
  return /^(.)\1{63}$/.test(h) || h === "0123456789abcdef".repeat(4) || h === "fedcba9876543210".repeat(4);
}

export interface CompletedProofInput {
  evidenceSource: "fixture" | "live";
  /** Bytes of the artifacts the record names. Hashes are computed here from the bytes, never copied from elsewhere. */
  sourceArtifact: Uint8Array;
  inputs: { path: string; bytes: Uint8Array };
  wasm: Uint8Array;
  output: Uint8Array;
  approvedMeasurements: string[];
  quote: { measurement: string };
  jobId: string;
}

export function writeCompletedProofRecord(i: CompletedProofInput): ProofRecord {
  const rec = ProofRecord.parse({
    status: "verified",
    evidenceSource: i.evidenceSource,
    sourceArtifactSha256: sha256Hex(i.sourceArtifact),
    exactInputs: { path: i.inputs.path, sha256: sha256Hex(i.inputs.bytes) },
    wasmSha256: sha256Hex(i.wasm),
    outputSha256: sha256Hex(i.output),
    approvedMeasurements: i.approvedMeasurements,
    quoteVerification: { ok: true, reasonCode: null, measurement: i.quote.measurement },
    jobId: i.jobId,
  });
  if (rec.status === "verified") {
    const hs = [rec.sourceArtifactSha256, rec.exactInputs.sha256, rec.wasmSha256, rec.outputSha256];
    if (hs.some(isPlaceholderHash)) throw new Error("proof record refused: placeholder hash");
    if (!rec.approvedMeasurements.includes(rec.quoteVerification.measurement))
      throw new Error("proof record refused: the quoted measurement is not an approved measurement");
  }
  return rec;
}

/** Blocked or failed proof: no job id, `unverified`, a reason, and `null` for everything that does not exist. */
export function writeBlockedProofRecord(i: {
  reason: string;
  known?: Partial<{
    sourceArtifact: Uint8Array;
    inputs: { path: string; bytes: Uint8Array };
    wasm: Uint8Array;
  }>;
  approvedMeasurements?: string[];
  reasonCode?: string | null;
}): ProofRecord {
  const k = i.known ?? {};
  return ProofRecord.parse({
    status: "unverified",
    evidenceSource: null,
    sourceArtifactSha256: k.sourceArtifact ? sha256Hex(k.sourceArtifact) : null,
    exactInputs: k.inputs ? { path: k.inputs.path, sha256: sha256Hex(k.inputs.bytes) } : null,
    wasmSha256: k.wasm ? sha256Hex(k.wasm) : null,
    outputSha256: null,
    approvedMeasurements: i.approvedMeasurements ?? [],
    quoteVerification:
      i.reasonCode === undefined ? null : { ok: false, reasonCode: i.reasonCode, measurement: null },
    jobId: null,
    reason: i.reason,
  });
}
