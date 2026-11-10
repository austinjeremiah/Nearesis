import { isDeepStrictEqual } from "node:util";
import {
  VerificationError,
  createTdxQuoteVerifier,
  createGpuEvidenceVerifier,
  findModelAttestationForSignature,
  verifyModelAttestation,
  verifyModelResponse,
  type CompletionSignature,
  type GpuEvidenceVerifier,
  type ModelAttestation,
  type TcbStatus,
  type TdxQuoteVerifier,
  type VerifiedModelAttestation,
} from "@nearai/inference-sdk";
import type { AttestationCheck, StructuredResult, VerificationResult } from "@nearesis/contracts";
import { sha256Hex } from "./hash.ts";

/** Written verification policy (ch.05, ch.12). Every field is enforced; there is no "trust the provider" path. */
export interface NearAiVerificationPolicy {
  /** Intel TCB statuses accepted for the TDX quote. */
  acceptedTcbStatuses: readonly TcbStatus[];
  /** Accepted dstack compose-hash values (hex). Must be non-empty unless acceptedOsImageHashes is set. */
  acceptedComposeHashes: readonly string[];
  /** Accepted dstack os-image-hash values (hex). */
  acceptedOsImageHashes: readonly string[];
  /** Max age of preflight attestation relative to the completion request. */
  maxEvidenceAgeMs: number;
  /** Max time between the completion and verification. */
  maxVerifyDelayMs: number;
  gpuEvidence: "if-present" | "required";
}

export const DEFAULT_TCB_STATUSES: readonly TcbStatus[] = ["UpToDate", "OutOfDate"];

export interface NearAiEvidence {
  kind: "near-ai/v1";
  model: string;
  /** Client-generated nonce sent with the model attestation request. */
  nonce: string;
  signingAlgo: "ecdsa" | "ed25519";
  preflight: { fetchedAtMs: number; attestations: ModelAttestation[] };
  completion: {
    completionId: string;
    atMs: number;
    requestBodyB64: string;
    responseBodyB64: string;
  };
  signature: CompletionSignature | null;
}

export interface VerifyDeps {
  tdxQuote?: TdxQuoteVerifier;
  gpuEvidence?: GpuEvidenceVerifier;
  now?: () => number;
}

const NAMES: AttestationCheck["name"][] = [
  "tdx_quote_non_debug",
  "measurement_accepted",
  "signer_match",
  "evidence_fresh",
  "response_binding",
];

function normHex(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/^0x/, "");
}

function isEvidence(e: unknown): e is NearAiEvidence {
  if (!e || typeof e !== "object") return false;
  const x = e as Partial<NearAiEvidence>;
  return (
    x.kind === "near-ai/v1" &&
    typeof x.model === "string" &&
    typeof x.nonce === "string" &&
    typeof x.preflight?.fetchedAtMs === "number" &&
    Array.isArray(x.preflight.attestations) &&
    typeof x.completion?.responseBodyB64 === "string" &&
    typeof x.completion.requestBodyB64 === "string" &&
    typeof x.completion.atMs === "number"
  );
}

function failAll(reason: string): VerificationResult {
  return {
    verified: false,
    status: "failed",
    checks: NAMES.map((name) => ({ name, passed: false, detail: reason })),
    reason,
  };
}

function contentOf(responseBody: Uint8Array): string | null {
  try {
    const j = JSON.parse(Buffer.from(responseBody).toString("utf8")) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const c = j.choices?.[0]?.message?.content;
    return typeof c === "string" ? c : null;
  } catch {
    return null;
  }
}

interface QuoteFacts {
  ran: boolean;
  debugEnabled: boolean | null;
  tcbStatus: string | null;
}

/**
 * Independent verification of a NEAR AI response. verified=true is derived solely from the five checks below; no
 * provider-supplied flag is consulted. Fail-closed: any exception or missing datum fails the relevant check.
 */
export async function verifyNearAiResult(
  result: StructuredResult<unknown>,
  policy: NearAiVerificationPolicy,
  deps: VerifyDeps = {},
): Promise<VerificationResult> {
  const ev = result.evidence;
  if (!isEvidence(ev)) return failAll("EVIDENCE_MISSING_OR_MALFORMED");
  const now = (deps.now ?? Date.now)();
  const baseQuote = deps.tdxQuote ?? createTdxQuoteVerifier();
  const gpu = deps.gpuEvidence ?? createGpuEvidenceVerifier();

  const checks: Record<AttestationCheck["name"], AttestationCheck> = {
    tdx_quote_non_debug: { name: "tdx_quote_non_debug", passed: false, detail: "not evaluated" },
    measurement_accepted: { name: "measurement_accepted", passed: false, detail: "not evaluated" },
    signer_match: { name: "signer_match", passed: false, detail: "not evaluated" },
    evidence_fresh: { name: "evidence_fresh", passed: false, detail: "not evaluated" },
    response_binding: { name: "response_binding", passed: false, detail: "not evaluated" },
  };
  const set = (n: AttestationCheck["name"], passed: boolean, detail: string) => {
    checks[n] = { name: n, passed, detail };
  };

  // ---- candidate attestations: quote, nonce, signer binding, RTMR3 replay, MRCONFIGID ----
  const verified: VerifiedModelAttestation[] = [];
  const facts: QuoteFacts[] = [];
  const failures: string[] = [];
  const failedBy: Partial<Record<AttestationCheck["name"], string>> = {};
  if (ev.preflight.attestations.length === 0) failures.push("NO_MODEL_ATTESTATION_CANDIDATES");
  for (const att of ev.preflight.attestations) {
    const fact: QuoteFacts = { ran: false, debugEnabled: null, tcbStatus: null };
    facts.push(fact);
    const recording: TdxQuoteVerifier = async (quote) => {
      const r = await baseQuote(quote);
      fact.ran = true;
      fact.debugEnabled = r.debugEnabled;
      fact.tcbStatus = r.tcbStatus;
      return r;
    };
    try {
      const v = await verifyModelAttestation({
        attestation: att,
        clientBinding: { nonce: ev.nonce },
        policy: { acceptedTcbStatuses: policy.acceptedTcbStatuses, gpuEvidence: policy.gpuEvidence },
        verifiers: { tdxQuote: recording, gpuEvidence: gpu },
      });
      if (policy.gpuEvidence === "required" && v.gpuEvidence !== "verified") {
        throw new Error("GPU_EVIDENCE_REQUIRED_BUT_NOT_VERIFIED");
      }
      verified.push(v);
    } catch (e) {
      const code = e instanceof VerificationError ? e.failure.code : "verification_error";
      failures.push(code);
      const target: AttestationCheck["name"] =
        code.startsWith("quote.") || code === "policy.debug_enabled"
          ? "tdx_quote_non_debug"
          : code === "binding.nonce_mismatch"
            ? "evidence_fresh"
            : code.startsWith("binding.")
              ? "signer_match"
              : "measurement_accepted";
      failedBy[target] = code;
    }
  }
  const allVerified = failures.length === 0 && verified.length === ev.preflight.attestations.length;

  // 1. tdx_quote_non_debug
  const quoteOk =
    facts.length > 0 &&
    facts.every((f) => f.ran && f.debugEnabled === false) &&
    !failedBy.tdx_quote_non_debug;
  set(
    "tdx_quote_non_debug",
    quoteOk,
    quoteOk
      ? `${facts.length} TDX quote(s) verified by DCAP, debug bit clear, TCB ${facts.map((f) => f.tcbStatus).join(",")}`
      : `quote check failed: ${failedBy.tdx_quote_non_debug ?? (facts.some((f) => f.debugEnabled) ? "debug enabled" : "no verified quote")}`,
  );

  // 2. measurement_accepted (allowlist policy over the measured, quote-authenticated deployment)
  const comp = new Set(policy.acceptedComposeHashes.map(normHex));
  const osi = new Set(policy.acceptedOsImageHashes.map(normHex));
  let measOk = allVerified && (comp.size > 0 || osi.size > 0);
  let measDetail: string;
  if (!allVerified) measDetail = `attestation verification failed: ${failures.join(",") || "none"}`;
  else if (comp.size === 0 && osi.size === 0) measDetail = "no accepted-measurement policy configured";
  else {
    const bad: string[] = [];
    for (const v of verified) {
      const m = v.deployment.runtimeMeasurements;
      if (comp.size > 0 && !comp.has(normHex(m.composeHash)))
        bad.push(`compose-hash ${normHex(m.composeHash).slice(0, 12)} not accepted`);
      if (osi.size > 0 && !osi.has(normHex(m.osImageHash)))
        bad.push(`os-image-hash ${normHex(m.osImageHash).slice(0, 12)} not accepted`);
    }
    measOk = bad.length === 0;
    measDetail = measOk
      ? `compose-hash/os-image-hash on allowlist for ${verified.length} candidate(s); MRCONFIGID and RTMR3 replay verified`
      : bad.join("; ");
  }
  set("measurement_accepted", measOk, measDetail);

  // 3. evidence_fresh (client nonce bound inside verified quote + age policy)
  const age = ev.completion.atMs - ev.preflight.fetchedAtMs;
  const delay = now - ev.completion.atMs;
  const nonceOk = allVerified && !failedBy.evidence_fresh;
  const freshOk =
    nonceOk && age >= 0 && age <= policy.maxEvidenceAgeMs && delay >= 0 && delay <= policy.maxVerifyDelayMs;
  set(
    "evidence_fresh",
    freshOk,
    freshOk
      ? `client nonce bound in verified quote; evidence ${age}ms old at completion; verified ${delay}ms after completion`
      : failedBy.evidence_fresh
        ? `nonce binding failed: ${failedBy.evidence_fresh}`
        : !allVerified
          ? "attestation not verified"
          : `stale or out-of-order evidence (age ${age}ms, delay ${delay}ms)`,
  );

  // ---- response signature ----
  const sig = ev.signature;
  let requestBody: Uint8Array;
  let responseBody: Uint8Array;
  try {
    requestBody = Buffer.from(ev.completion.requestBodyB64, "base64");
    responseBody = Buffer.from(ev.completion.responseBodyB64, "base64");
  } catch {
    return finish(checks, "BODY_DECODE_FAILED");
  }

  // 4. signer_match: provider_tee signer equals exactly one verified candidate (preflight, before completion)
  let matched: VerifiedModelAttestation | null = null;
  if (!sig) set("signer_match", false, "no completion signature available");
  else if (sig.kind !== "provider_tee")
    set("signer_match", false, `signature kind ${sig.kind} does not bind a model TEE`);
  else if (!allVerified) set("signer_match", false, "no verified candidate to match against");
  else {
    try {
      matched = findModelAttestationForSignature({ attestations: verified, signature: sig });
      set(
        "signer_match",
        true,
        `signature signer ${sig.signer.signingAlgo}:${normHex(sig.signer.signingAddress).slice(0, 12)}… matches a verified model attestation`,
      );
    } catch (e) {
      set(
        "signer_match",
        false,
        `no unique verified candidate matches signer: ${e instanceof VerificationError ? e.failure.code : "error"}`,
      );
    }
  }

  // 5. response_binding: signature valid over exact bytes, hashes bound, result.output derived from those bytes
  try {
    if (!sig || !matched) throw new Error("signature or matched attestation unavailable");
    verifyModelResponse({ requestBody, responseBody, signature: sig, attestation: matched });
    const reqModel = (JSON.parse(Buffer.from(requestBody).toString("utf8")) as { model?: string }).model;
    if (reqModel !== ev.model || result.model !== ev.model)
      throw new Error("model mismatch between request, evidence and result");
    if (sha256Hex(responseBody) !== result.rawResponseSha256)
      throw new Error("rawResponseSha256 does not match response bytes");
    const content = contentOf(responseBody);
    if (content === null) throw new Error("response has no message content");
    if (!isDeepStrictEqual(result.output, JSON.parse(content)))
      throw new Error("result.output differs from signed response content");
    set(
      "response_binding",
      true,
      "signature verifies over SHA-256(request) and SHA-256(response) exact bytes; output matches signed content",
    );
  } catch (e) {
    const msg = e instanceof VerificationError ? e.failure.code : e instanceof Error ? e.message : "error";
    set("response_binding", false, `response binding failed: ${msg}`);
  }

  return finish(checks);
}

function finish(
  checks: Record<AttestationCheck["name"], AttestationCheck>,
  reason?: string,
): VerificationResult {
  const list = NAMES.map((n) => checks[n]);
  const ok = list.every((c) => c.passed);
  const out: VerificationResult = { verified: ok, status: ok ? "verified" : "failed", checks: list };
  if (!ok)
    out.reason =
      reason ??
      list
        .filter((c) => !c.passed)
        .map((c) => c.name)
        .join(",");
  return out;
}

export interface PreflightSummary {
  signer: string;
  verified: boolean;
  failure: string | null;
  tcbStatus: string | null;
  debugEnabled: boolean | null;
  gpuEvidence: string | null;
  composeHash: string | null;
  osImageHash: string | null;
  measurementAccepted: boolean;
  nonceBound: boolean;
}

/** Verify raw model attestations (no completion). Same SDK verification path as verifyNearAiResult. */
export async function verifyPreflight(
  attestations: ModelAttestation[],
  nonce: string,
  policy: NearAiVerificationPolicy,
  deps: VerifyDeps = {},
): Promise<PreflightSummary[]> {
  const baseQuote = deps.tdxQuote ?? createTdxQuoteVerifier();
  const gpu = deps.gpuEvidence ?? createGpuEvidenceVerifier();
  const comp = new Set(policy.acceptedComposeHashes.map(normHex));
  const osi = new Set(policy.acceptedOsImageHashes.map(normHex));
  const out: PreflightSummary[] = [];
  for (const att of attestations) {
    let debug: boolean | null = null;
    let tcb: string | null = null;
    const rec: TdxQuoteVerifier = async (q) => {
      const r = await baseQuote(q);
      debug = r.debugEnabled;
      tcb = r.tcbStatus;
      return r;
    };
    const s: PreflightSummary = {
      signer: att.signer.signingAddress,
      verified: false,
      failure: null,
      tcbStatus: null,
      debugEnabled: null,
      gpuEvidence: null,
      composeHash: null,
      osImageHash: null,
      measurementAccepted: false,
      nonceBound: false,
    };
    try {
      const v = await verifyModelAttestation({
        attestation: att,
        clientBinding: { nonce },
        policy: { acceptedTcbStatuses: policy.acceptedTcbStatuses, gpuEvidence: policy.gpuEvidence },
        verifiers: { tdxQuote: rec, gpuEvidence: gpu },
      });
      s.verified = true;
      s.nonceBound = true;
      s.gpuEvidence = v.gpuEvidence;
      s.composeHash = v.deployment.runtimeMeasurements.composeHash ?? null;
      s.osImageHash = v.deployment.runtimeMeasurements.osImageHash ?? null;
      s.measurementAccepted =
        (comp.size > 0 || osi.size > 0) &&
        (comp.size === 0 || comp.has(normHex(s.composeHash ?? ""))) &&
        (osi.size === 0 || osi.has(normHex(s.osImageHash ?? "")));
    } catch (e) {
      s.failure = e instanceof VerificationError ? e.failure.code : "verification_error";
    }
    s.tcbStatus = tcb;
    s.debugEnabled = debug;
    out.push(s);
  }
  return out;
}
