import { createPublicKey, verify } from "node:crypto";
import { AttestationEvidence } from "@nearesis/contracts";
import type { AttestationDecision, AttestationPolicy } from "@nearesis/contracts";
import { canonicalJson } from "./canonical.ts";

/**
 * Attestation proof policy (ch.14 "never claim verified unless cryptographic verification succeeds").
 *
 * Fail closed: every condition must hold, a parse error or an empty allowlist rejects, and the decision lists every
 * failed condition. `outlayer_attested` needs real OutLayer provenance AND a QuoteVerifier that accepts the TDX quote.
 * No QuoteVerifier ships in this repository: producing one needs a live OutLayer job (BLK-20261110-003), so nothing
 * here can return `outlayer_attested` without an injected verifier. `synthetic` evidence is test-only and is labelled so.
 */
export interface QuoteVerifier {
  verifyQuote(
    evidence: AttestationEvidence,
  ): Promise<{ ok: boolean; reason?: string }> | { ok: boolean; reason?: string };
}

export interface AttestationContext {
  /** SHA-256 of the WASM component actually built and shipped (recomputed from bytes by the caller). */
  localWasmSha256: string;
  expectedInputSha256: string;
  expectedOutputSha256: string;
  now: Date;
  quoteVerifier?: QuoteVerifier;
}

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
  if (!parsed.success) return { decision: "reject", reasons: ["EVIDENCE_MALFORMED"], proofLabel: "none" };
  const e = parsed.data;
  const reasons: string[] = [];

  if (!policy.allowedWasmSha256.includes(e.wasmSha256)) reasons.push("WASM_HASH_NOT_ALLOWED");
  if (e.wasmSha256 !== ctx.localWasmSha256) reasons.push("WASM_HASH_MISMATCH");
  if (!policy.allowedSigners.includes(e.signer)) reasons.push("SIGNER_NOT_ALLOWED");
  if (!signatureValid(e)) reasons.push("SIGNATURE_INVALID");
  if (e.inputSha256 !== ctx.expectedInputSha256) reasons.push("INPUT_HASH_MISMATCH");
  if (e.outputSha256 !== ctx.expectedOutputSha256) reasons.push("OUTPUT_HASH_MISMATCH");

  if (e.provenance === "outlayer") {
    if (e.network === "none" || !policy.allowedNetworks.includes(e.network))
      reasons.push("NETWORK_NOT_ALLOWED");
    if (e.quote === null || ctx.quoteVerifier === undefined) reasons.push("QUOTE_NOT_VERIFIED");
    else {
      const q = await ctx.quoteVerifier.verifyQuote(e);
      if (!q.ok) reasons.push("QUOTE_NOT_VERIFIED");
    }
  }

  const ageMs = ctx.now.getTime() - Date.parse(e.issuedAt);
  if (!(ageMs >= -60_000 && ageMs <= policy.maxAgeSeconds * 1000)) reasons.push("EVIDENCE_STALE_OR_FUTURE");

  if (reasons.length > 0) return { decision: "reject", reasons, proofLabel: "none" };
  return {
    decision: "accept",
    reasons: [],
    proofLabel: e.provenance === "outlayer" ? "outlayer_attested" : "policy_checked_synthetic",
  };
}
