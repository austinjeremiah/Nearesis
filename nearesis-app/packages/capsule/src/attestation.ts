import { createPublicKey, verify } from "node:crypto";
import { AttestationEvidence } from "@nearesis/contracts";
import type { AttestationDecision, AttestationPolicy } from "@nearesis/contracts";
import { canonicalJson, sha256Hex } from "./canonical.ts";

/**
 * Attestation proof policy (ch.14 "never claim verified unless cryptographic verification succeeds").
 *
 * Fail closed: every condition must hold, a parse error or an empty allowlist rejects, and the decision lists every
 * failed condition. `outlayer_attested` needs real OutLayer provenance AND a QuoteVerifier that accepts the TDX quote.
 * No QuoteVerifier ships in this repository: producing one needs a live OutLayer job (BLK-20261110-003), so nothing
 * here can return `outlayer_attested` without an injected verifier. `synthetic` evidence is test-only and is labelled so.
 */
export interface QuoteResult {
  ok: boolean;
  /** Specific machine-readable reason (a `TdxReason`); absent means the generic QUOTE_NOT_VERIFIED. */
  reason?: string;
  quote?: { mrTd: string; reportData: string; debug: boolean };
  /** Which kind of pinned root the quote chained to. Only `production` can make evidence `live`. */
  rootKind?: "production" | "fixture";
}
export interface QuoteVerifier {
  verifyQuote(evidence: AttestationEvidence): Promise<QuoteResult> | QuoteResult;
}

export interface AttestationContext {
  /** SHA-256 of the WASM component actually built and shipped (recomputed from bytes by the caller). */
  localWasmSha256: string;
  expectedInputSha256: string;
  expectedOutputSha256: string;
  now: Date;
  quoteVerifier?: QuoteVerifier;
  /** The job the caller asked about; evidence for any other job is rejected. */
  expectedJobId?: string;
}

/** Order in which reasons are reported as the primary `reasonCode`. */
const REASON_PRIORITY = [
  "EVIDENCE_MALFORMED",
  "QUOTE_MALFORMED",
  "QUOTE_UNSUPPORTED",
  "QUOTE_DEBUG_MODE",
  "QUOTE_SIGNATURE_INVALID",
  "QUOTE_QE_BINDING_INVALID",
  "QUOTE_QE_SIGNATURE_INVALID",
  "QUOTE_CERT_CHAIN_INVALID",
  "QUOTE_ROOT_NOT_TRUSTED",
  "QUOTE_NOT_VERIFIED",
  "WASM_HASH_NOT_ALLOWED",
  "WASM_HASH_MISMATCH",
  "SIGNER_NOT_ALLOWED",
  "SIGNATURE_INVALID",
  "MEASUREMENT_NOT_ALLOWED",
  "RESPONSE_BINDING_MISSING",
  "RESPONSE_BINDING_MISMATCH",
  "JOB_ID_MISMATCH",
  "INPUT_HASH_MISMATCH",
  "OUTPUT_HASH_MISMATCH",
  "NETWORK_NOT_ALLOWED",
  "EVIDENCE_STALE_OR_FUTURE",
];
export const primaryReason = (reasons: string[]): string | null =>
  reasons.length === 0
    ? null
    : ([...reasons].sort((a, b) => {
        const ia = REASON_PRIORITY.indexOf(a);
        const ib = REASON_PRIORITY.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })[0] ?? null);

/** Canonical payload the TEE signer signs. */
export function attestationPayload(e: AttestationEvidence): string {
  return canonicalJson({
    jobId: e.jobId,
    network: e.network,
    wasmSha256: e.wasmSha256,
    inputSha256: e.inputSha256,
    outputSha256: e.outputSha256,
    issuedAt: e.issuedAt,
  });
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function signatureValid(e: AttestationEvidence): boolean {
  try {
    const raw = Buffer.from(e.signer, "base64url");
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(attestationPayload(e)), key, Buffer.from(e.signature, "base64url"));
  } catch {
    return false;
  }
}

export async function verifyAttestation(
  evidenceRaw: unknown,
  policy: AttestationPolicy,
  ctx: AttestationContext,
): Promise<AttestationDecision> {
  const parsed = AttestationEvidence.safeParse(evidenceRaw);
  if (!parsed.success)
    return {
      decision: "reject",
      reasons: ["EVIDENCE_MALFORMED"],
      proofLabel: "none",
      reasonCode: "EVIDENCE_MALFORMED",
    };
  const e = parsed.data;
  const reasons: string[] = [];

  if (!policy.allowedWasmSha256.includes(e.wasmSha256)) reasons.push("WASM_HASH_NOT_ALLOWED");
  if (e.wasmSha256 !== ctx.localWasmSha256) reasons.push("WASM_HASH_MISMATCH");
  if (!policy.allowedSigners.includes(e.signer)) reasons.push("SIGNER_NOT_ALLOWED");
  if (!signatureValid(e)) reasons.push("SIGNATURE_INVALID");
  if (e.inputSha256 !== ctx.expectedInputSha256) reasons.push("INPUT_HASH_MISMATCH");
  if (e.outputSha256 !== ctx.expectedOutputSha256) reasons.push("OUTPUT_HASH_MISMATCH");

  let rootKind: "production" | "fixture" | null = null;
  let measurement: string | null = null;
  if (ctx.expectedJobId !== undefined && e.jobId !== ctx.expectedJobId) reasons.push("JOB_ID_MISMATCH");
  if (e.provenance === "outlayer") {
    if (e.network === "none" || !policy.allowedNetworks.includes(e.network))
      reasons.push("NETWORK_NOT_ALLOWED");
    if (e.quote === null || ctx.quoteVerifier === undefined) reasons.push("QUOTE_NOT_VERIFIED");
    else {
      const q = await ctx.quoteVerifier.verifyQuote(e);
      if (!q.ok) reasons.push(q.reason ?? "QUOTE_NOT_VERIFIED");
      else {
        rootKind = q.rootKind ?? "fixture";
        measurement = q.quote?.mrTd ?? null;
        if (measurement === null || !policy.allowedMeasurements.includes(measurement))
          reasons.push("MEASUREMENT_NOT_ALLOWED");
        const bound = q.quote?.reportData.slice(0, 64) ?? "";
        if (/^0*$/.test(q.quote?.reportData ?? "")) reasons.push("RESPONSE_BINDING_MISSING");
        else if (bound !== sha256Hex(attestationPayload(e))) reasons.push("RESPONSE_BINDING_MISMATCH");
      }
    }
  }

  const ageMs = ctx.now.getTime() - Date.parse(e.issuedAt);
  if (!(ageMs >= -60_000 && ageMs <= policy.maxAgeSeconds * 1000)) reasons.push("EVIDENCE_STALE_OR_FUTURE");

  if (reasons.length > 0)
    return {
      decision: "reject",
      reasons,
      proofLabel: "none",
      reasonCode: primaryReason(reasons),
      evidenceSource: "fixture",
      measurement,
    };
  // `live` only when the quote chained to a pinned production root. Evidence cannot declare it, and nothing upgrades it.
  const live = e.provenance === "outlayer" && rootKind === "production";
  return {
    decision: "accept",
    reasons: [],
    proofLabel: live
      ? "outlayer_attested"
      : e.provenance === "outlayer"
        ? "fixture_attested"
        : "policy_checked_synthetic",
    evidenceSource: live ? "live" : "fixture",
    reasonCode: null,
    measurement,
  };
}
