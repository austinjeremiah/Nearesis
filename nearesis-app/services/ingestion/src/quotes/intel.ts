import { divDec, formatDec, mulDec, parseDec, subDec } from "../decimal.ts";
import { verifyQuoteSignature, type SignatureResult } from "./signature.ts";

/** Provider/source version: the OpenAPI document version checked on 2026-11-13 plus the Nearesis adapter version. */
export const ONECLICK_API_VERSION = "1click-openapi-0.1.10";

export type Availability = "available" | "no_route" | "error" | "not_attempted";
export type ErrorCategory =
  | "none"
  | "no_route"
  | "rate_limited"
  | "auth"
  | "bad_request"
  | "client_error"
  | "provider_5xx"
  | "timeout"
  | "network"
  | "invalid_payload"
  | "not_attempted";
export type RateLimitStatus = "limited" | "not_limited" | "unknown";

/** The slice of a quote_attempts row (and its raw response) that intelligence is derived from. Nothing here is inferred. */
export interface QuoteAttemptFacts {
  routeId: string;
  originAsset: string;
  destinationAsset: string;
  amountBaseUnits: string;
  privacyMode: string;
  scheduledBucketUtc: string;
  attemptNo: number;
  slot: "observed" | "unavailable";
  class: "OK" | "NO_QUOTE" | "NETWORK_ERROR" | "TIMEOUT" | "INVALID_OUTPUT" | null;
  reason: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  fetchedAt: string | null;
  rawObjectHash: string | null;
  adapterVersion?: string;
}

export interface QuoteIntel {
  routeId: string;
  originAsset: string;
  destinationAsset: string;
  amountBaseUnits: string;
  privacyMode: string;
  scheduledBucketUtc: string;
  attemptNo: number;
  availability: Availability;
  errorCategory: ErrorCategory;
  httpStatus: number | null;
  rateLimitStatus: RateLimitStatus;
  rateLimitRemaining: number | null;
  inputAmountBaseUnits: string;
  inputAmountFormatted: string | null;
  inputAmountUsd: string | null;
  estimatedOutputBaseUnits: string | null;
  estimatedOutputFormatted: string | null;
  estimatedOutputUsd: string | null;
  /** amountOutFormatted / amountInFormatted, exact, 18 fractional digits (round half up). Null when either side is absent. */
  quotedEffectiveRate: string | null;
  /** (inUsd - outUsd) / inUsd * 10000, 4 digits. The provider's own USD valuation of both legs; NOT an executed spread. */
  usdImpliedCostBps: string | null;
  timeEstimateS: number | null;
  latencyMs: number | null;
  quoteTimestamp: string | null;
  fetchedAt: string | null;
  providerVersion: string;
  adapterVersion: string | null;
  /** Always `indicative`: a dry quote is never an execution outcome. */
  quoteKind: "indicative";
  signaturePresent: boolean;
  signatureStatus: SignatureResult["status"] | "not_applicable";
  signatureReason: string;
  rawObjectHash: string | null;
}

export function categorize(
  cls: QuoteAttemptFacts["class"],
  httpStatus: number | null,
): { availability: Availability; errorCategory: ErrorCategory } {
  if (cls === null) return { availability: "not_attempted", errorCategory: "not_attempted" };
  if (cls === "OK") return { availability: "available", errorCategory: "none" };
  if (cls === "NO_QUOTE") return { availability: "no_route", errorCategory: "no_route" };
  if (cls === "TIMEOUT") return { availability: "error", errorCategory: "timeout" };
  if (cls === "NETWORK_ERROR")
    return {
      availability: "error",
      errorCategory: httpStatus !== null && httpStatus >= 500 ? "provider_5xx" : "network",
    };
  // INVALID_OUTPUT: the HTTP status says why.
  const s = httpStatus;
  const errorCategory: ErrorCategory =
    s === 429
      ? "rate_limited"
      : s === 401 || s === 403
        ? "auth"
        : s === 400
          ? "bad_request"
          : s !== null && s >= 400 && s < 500
            ? "client_error"
            : "invalid_payload";
  return { availability: "error", errorCategory };
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const decStr = (v: unknown): string | null => (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? v : null);

export function effectiveRate(outFormatted: string | null, inFormatted: string | null): string | null {
  if (!outFormatted || !inFormatted) return null;
  const i = parseDec(inFormatted);
  if (i.int <= 0n) return null;
  return formatDec(divDec(parseDec(outFormatted), i, 18));
}

export function usdImpliedCostBps(inUsd: string | null, outUsd: string | null): string | null {
  if (!inUsd || !outUsd) return null;
  const i = parseDec(inUsd);
  if (i.int <= 0n) return null;
  return formatDec(divDec(mulDec(subDec(i, parseDec(outUsd)), { int: 10000n, scale: 0 }), i, 4));
}

/**
 * Builds the intelligence record of one attempt from its row facts, its raw response body and (when the transport archived them)
 * its response headers. Headers are optional: the live sampler archives only the body, so rate-limit status then rests on the
 * HTTP status alone (429 = limited) and `rateLimitRemaining` stays null.
 */
export function buildQuoteIntel(
  f: QuoteAttemptFacts,
  payload: Uint8Array | null,
  headers: Record<string, string> = {},
  verifyKey?: string,
): QuoteIntel {
  const { availability, errorCategory } = categorize(f.class, f.httpStatus);
  let json: Record<string, unknown> | null = null;
  if (payload) {
    try {
      const j: unknown = JSON.parse(new TextDecoder().decode(payload));
      if (j && typeof j === "object" && !Array.isArray(j)) json = j as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  const q = (json?.quote ?? null) as Record<string, unknown> | null;
  const ok = f.class === "OK" && q !== null;
  const inF = ok ? decStr(q.amountInFormatted) : null;
  const outF = ok ? decStr(q.amountOutFormatted) : null;
  const inUsd = ok ? decStr(q.amountInUsd) : null;
  const outUsd = ok ? decStr(q.amountOutUsd) : null;
  const sigPresent = typeof json?.signature === "string" && json.signature !== "";
  const sig: SignatureResult | null = ok ? verifyQuoteSignature(json, verifyKey) : null;
  const remaining = num(headers["x-ratelimit-remaining"]);
  const rateLimitStatus: RateLimitStatus =
    f.httpStatus === 429 || (remaining !== null && remaining <= 0)
      ? "limited"
      : f.httpStatus !== null
        ? "not_limited"
        : "unknown";
  const ts =
    typeof json?.timestamp === "string" && !Number.isNaN(Date.parse(json.timestamp)) ? json.timestamp : null;
  return {
    routeId: f.routeId,
    originAsset: f.originAsset,
    destinationAsset: f.destinationAsset,
    amountBaseUnits: f.amountBaseUnits,
    privacyMode: f.privacyMode,
    scheduledBucketUtc: f.scheduledBucketUtc,
    attemptNo: f.attemptNo,
    availability,
    errorCategory,
    httpStatus: f.httpStatus,
    rateLimitStatus,
    rateLimitRemaining: remaining,
    inputAmountBaseUnits: f.amountBaseUnits,
    inputAmountFormatted: inF,
    inputAmountUsd: inUsd,
    estimatedOutputBaseUnits: ok && typeof q.amountOut === "string" ? q.amountOut : null,
    estimatedOutputFormatted: outF,
    estimatedOutputUsd: outUsd,
    quotedEffectiveRate: effectiveRate(outF, inF),
    usdImpliedCostBps: usdImpliedCostBps(inUsd, outUsd),
    timeEstimateS: ok ? num(q.timeEstimate) : null,
    latencyMs: f.latencyMs,
    quoteTimestamp: ts,
    fetchedAt: f.fetchedAt,
    providerVersion: ONECLICK_API_VERSION,
    adapterVersion: f.adapterVersion ?? null,
    quoteKind: "indicative",
    signaturePresent: sigPresent,
    signatureStatus: sig ? sig.status : "not_applicable",
    signatureReason: sig ? sig.reason : "no quote payload to verify",
    rawObjectHash: f.rawObjectHash,
  };
}
