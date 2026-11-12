import { z } from "zod";

/** Contract family version. Breaking change => major bump + ADR (CONTRACT_REGISTRY.md). */
export const CONTRACTS_VERSION = "1.6.0";

export const Uuid = z.uuid();
export const IsoDateTime = z.iso.datetime({ offset: true });
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex sha256");
export const PrefixedSha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const SemVer = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
/** Exact decimal amount carried as a string (ch.07: never IEEE754 for smallest units). */
export const DecimalString = z.string().regex(/^-?\d+(?:\.\d+)?$/);

export const ErrorCode = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "STALE_VERSION",
  "VALIDATION_FAILED",
  "DOMAIN_INVARIANT",
  "RATE_LIMITED",
  "UPSTREAM_DEGRADED",
  "BUDGET_EXCEEDED",
  "APPROVAL_REQUIRED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** ch.11: every error has traceId, safe error_code, retryable, next action, last stable revision. */
export const ErrorResponse = z.strictObject({
  traceId: z.string().min(1),
  errorCode: ErrorCode,
  /** Machine-readable sub-reason, e.g. TOOL_NOT_GRANTED, ABI_MAJOR_CHANGE_REQUIRES_MIGRATION. */
  reasonCode: z.string().min(1).max(80).optional(),
  message: z.string().max(2000),
  retryable: z.boolean(),
  nextAction: z.string().max(500).optional(),
  lastStableRevision: z.number().int().nonnegative().optional(),
  details: z
    .array(z.strictObject({ path: z.string(), issue: z.string() }))
    .max(100)
    .optional(),
  /** v1.6.0 (additive): seconds to wait before retrying; mirrors the `Retry-After` header on 429 overload refusals. */
  retryAfterSeconds: z.number().int().positive().max(3600).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export const HTTP_STATUS_FOR: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  STALE_VERSION: 409,
  VALIDATION_FAILED: 422,
  DOMAIN_INVARIANT: 422,
  RATE_LIMITED: 429,
  UPSTREAM_DEGRADED: 503,
  BUDGET_EXCEEDED: 402,
  APPROVAL_REQUIRED: 403,
  INTERNAL: 500,
};

export const Visibility = z.enum(["public", "aggregate_only", "restricted"]);
export type Visibility = z.infer<typeof Visibility>;
export const SourceMode = z.enum(["fixture_synthetic", "fixture_recorded", "live"]);
export type SourceMode = z.infer<typeof SourceMode>;
