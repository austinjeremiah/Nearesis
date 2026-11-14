import { z } from "zod";

/**
 * v1.7.0 (additive): ONE typed state taxonomy for everything the frontend renders (final_master_prompt s21). Exactly these
 * twelve states, no more. A client switches on `state`; `reasonCode` (the existing machine reason) stays for detail.
 *
 *   data envelopes (HTTP 200) : loading, partial, complete, stale, truncated
 *   refusals / degradations   : source_unavailable, permission_denied, rate_limited, insufficient_data,
 *                               metric_uncertified, method_unvalidated, budget_exhausted
 *
 * Nothing here changes an existing field: `ErrorResponse.state` is optional, existing clients that ignore it keep
 * working, and `errorCode` / `reasonCode` / HTTP status mapping are untouched.
 */
export const ApiState = z.enum([
  "loading",
  "partial",
  "complete",
  "stale",
  "truncated",
  "source_unavailable",
  "permission_denied",
  "rate_limited",
  "insufficient_data",
  "metric_uncertified",
  "method_unvalidated",
  "budget_exhausted",
]);
export type ApiState = z.infer<typeof ApiState>;

export const API_STATES = ApiState.options;

/** What the UI should do with each state (documentation that ships with the contract and is asserted in tests). */
export const API_STATE_INFO: Record<
  ApiState,
  { kind: "data" | "refusal"; retryable: boolean; summary: string; frontend: string }
> = {
  loading: {
    kind: "data",
    retryable: false,
    summary: "Work is in progress and no usable result exists yet.",
    frontend: "Show a skeleton; follow the SSE stream or poll the run.",
  },
  partial: {
    kind: "data",
    retryable: false,
    summary: "Some panels, sources or tasks finished; others are still running or failed.",
    frontend: "Render what exists, label the rest; never present as complete.",
  },
  complete: {
    kind: "data",
    retryable: false,
    summary: "Everything requested was produced from current data.",
    frontend: "Render normally.",
  },
  stale: {
    kind: "data",
    retryable: true,
    summary:
      "A result is shown but its source is behind (watermark older than the freshness target, or served from the last finalized snapshot).",
    frontend: "Render with the freshness warning (`asOf`, `staleSeconds`); do not publish as current.",
  },
  truncated: {
    kind: "data",
    retryable: false,
    summary: "The max-rows rule cut the result; `truncation` says how and by how much.",
    frontend: "Label as truncated or downsampled; offer a narrower query.",
  },
  source_unavailable: {
    kind: "refusal",
    retryable: true,
    summary: "The source, semantic layer or breaker is down and there is no snapshot to serve.",
    frontend: "Show the unavailable state with `nextAction`; retry with backoff.",
  },
  permission_denied: {
    kind: "refusal",
    retryable: false,
    summary: "Not signed in, not a member, role too low, origin not allowed or classification denies access.",
    frontend: "Re-authenticate or hide the action; do not retry.",
  },
  rate_limited: {
    kind: "refusal",
    retryable: true,
    summary:
      "Too many requests, queue full or too many streams; `Retry-After` and `retryAfterSeconds` give the wait.",
    frontend: "Back off for Retry-After seconds; keep the same x-client-id.",
  },
  insufficient_data: {
    kind: "refusal",
    retryable: false,
    summary:
      "The data cannot support the answer (CANNOT_COMPUTE, coverage gap, too few observations, vintage missing).",
    frontend: "Say what is missing; never fill with zero.",
  },
  metric_uncertified: {
    kind: "refusal",
    retryable: false,
    summary: "The metric is a draft, validated-only or deprecated and may not be used for a certified claim.",
    frontend: "Label exploratory; block publication.",
  },
  method_unvalidated: {
    kind: "refusal",
    retryable: false,
    summary: "The analysis method has not passed validation (METHOD_NOT_VALIDATED, inference guard).",
    frontend: "Label the finding as unvalidated; require acknowledgement to publish.",
  },
  budget_exhausted: {
    kind: "refusal",
    retryable: false,
    summary:
      "A spend limit stopped paid work: the global USD 5 model ceiling, a workspace cap, a per-resource limit or an unknown price.",
    frontend: "Show the budget card; historical reads still work; the owner must raise a limit.",
  },
};

/**
 * Existing reason codes mapped onto the taxonomy. `reasonCode` wins over `errorCode`. Codes not listed fall back to
 * their `errorCode` mapping; codes that are neither (validation, concurrency conflicts, not found) carry no state.
 */
export const REASON_CODE_STATE: Readonly<Record<string, ApiState>> = {
  // permission
  ACCESS_DENIED: "permission_denied",
  INSUFFICIENT_ROLE: "permission_denied",
  ORIGIN_NOT_ALLOWED: "permission_denied",
  ROLE_CANNOT_PUBLISH: "permission_denied",
  ROLE_CANNOT_CLASSIFY: "permission_denied",
  CLASSIFICATION_DENIED: "permission_denied",
  TOOL_NOT_GRANTED: "permission_denied",
  CAPABILITY_ESCALATION: "permission_denied",
  LEASE_INVALID: "permission_denied",
  LEASE_DEPTH_EXCEEDED: "permission_denied",
  PRINCIPAL_KIND: "permission_denied",
  INVALID_SESSION: "permission_denied",
  MISSING_SESSION: "permission_denied",
  SESSION_REVOKED: "permission_denied",
  TOKEN_EXPIRED: "permission_denied",
  NO_MEMBERSHIP: "permission_denied",
  UNKNOWN_SUBJECT: "permission_denied",
  INVALID_GATEWAY_CREDENTIAL: "permission_denied",
  APPROVAL_MISSING: "permission_denied",
  APPROVAL_REQUIRED: "permission_denied",
  APPROVAL_INVALID: "permission_denied",
  APPROVAL_REJECTED: "permission_denied",
  // rate limiting and overload
  TOO_MANY_LOGINS: "rate_limited",
  TOO_MANY_REQUESTS: "rate_limited",
  TENANT_QUEUE_FULL: "rate_limited",
  GLOBAL_QUEUE_FULL: "rate_limited",
  QUEUE_TIMEOUT: "rate_limited",
  QUEUE_EVICTED: "rate_limited",
  TOO_MANY_STREAMS: "rate_limited",
  // budget
  BUDGET_EXCEEDED: "budget_exhausted",
  TOOL_CALL_BUDGET: "budget_exhausted",
  CAP_REACHED: "budget_exhausted",
  DIMENSION_LIMIT: "budget_exhausted",
  HARD_STOPPED: "budget_exhausted",
  PAID_OP_NOT_PERMITTED: "budget_exhausted",
  GLOBAL_CEILING: "budget_exhausted",
  PRICE_UNKNOWN: "budget_exhausted",
  // sources
  SOURCE_UNAVAILABLE: "source_unavailable",
  SOURCE_UNAVAILABLE_NO_SNAPSHOT: "source_unavailable",
  CUBE_UNAVAILABLE: "source_unavailable",
  CATALOG_UNAVAILABLE: "source_unavailable",
  BREAKER_OPEN: "source_unavailable",
  UPSTREAM_DEGRADED: "source_unavailable",
  // stale / degraded but served
  SOURCE_DEGRADED: "stale",
  EVIDENCE_STALE_OR_FUTURE: "stale",
  // truncation
  MAX_ROWS: "truncated",
  TRUNCATED: "truncated",
  // data sufficiency
  CANNOT_COMPUTE: "insufficient_data",
  INSUFFICIENT_DATA: "insufficient_data",
  VINTAGE_UNAVAILABLE: "insufficient_data",
  PRICE_UNAVAILABLE: "insufficient_data",
  // governance (emitted by the metric authoring and research stacks as they land)
  METRIC_UNCERTIFIED: "metric_uncertified",
  METRIC_NOT_CERTIFIED: "metric_uncertified",
  METRIC_DRAFT: "metric_uncertified",
  METRIC_DEPRECATED: "metric_uncertified",
  DEPENDENCY_NOT_CERTIFIED: "metric_uncertified",
  NOT_VALIDATED: "metric_uncertified",
  STALE_VALIDATION: "metric_uncertified",
  CERTIFIER_REQUIRED: "permission_denied",
  HUMAN_PRINCIPAL_REQUIRED: "permission_denied",
  SELF_CERTIFICATION_REFUSED: "permission_denied",
  EXPLORATION_NOT_PERMITTED: "permission_denied",
  COST_CAP: "budget_exhausted",
  COVERAGE_UNKNOWN: "insufficient_data",
  METHOD_NOT_VALIDATED: "method_unvalidated",
  METHOD_UNVALIDATED: "method_unvalidated",
  INFERENCE_CLAIM_GUARD: "method_unvalidated",
  INFERENCE_CLAIM_UNSUPPORTED: "method_unvalidated",
};

/** Fallback by `errorCode` when the reason code is unmapped. Not listed = no state (validation, conflict, not found, internal). */
export const ERROR_CODE_STATE: Readonly<Record<string, ApiState>> = {
  UNAUTHENTICATED: "permission_denied",
  FORBIDDEN: "permission_denied",
  APPROVAL_REQUIRED: "permission_denied",
  RATE_LIMITED: "rate_limited",
  BUDGET_EXCEEDED: "budget_exhausted",
  UPSTREAM_DEGRADED: "source_unavailable",
};

/** The state of an error response, or `undefined` when the error is not one of the twelve (e.g. a validation failure). */
export function stateOfError(errorCode: string, reasonCode?: string | null): ApiState | undefined {
  if (reasonCode && REASON_CODE_STATE[reasonCode]) return REASON_CODE_STATE[reasonCode];
  return ERROR_CODE_STATE[errorCode];
}

/** Everything a data response needs to say how complete it is (used by chart data, query results, panels, findings). */
export const DataStateEnvelope = z.strictObject({
  state: ApiState,
  /** Machine reason for any non-`complete` state, from the existing reason-code vocabulary. */
  reasonCode: z.string().min(1).max(80).optional(),
  /** Panels or tasks finished out of the total, for `loading` and `partial`. */
  progress: z
    .strictObject({ done: z.number().int().nonnegative(), total: z.number().int().positive() })
    .optional(),
  /** Present when `state` is `truncated` (mirrors `ResultTruncation`). */
  truncation: z
    .strictObject({
      reason: z.literal("MAX_ROWS"),
      method: z.enum(["truncate", "min_max_bucket", "lttb"]),
      requestedRows: z.number().int().nonnegative(),
      returnedRows: z.number().int().nonnegative(),
      maxRows: z.number().int().positive(),
    })
    .optional(),
  /** Present when `state` is `stale` (mirrors `FreshnessWarning`). */
  freshness: z
    .strictObject({
      asOf: z.iso.datetime({ offset: true }),
      staleSeconds: z.number().nonnegative(),
      degradedSince: z.iso.datetime({ offset: true }).optional(),
    })
    .optional(),
  nextAction: z.string().max(500).optional(),
  retryAfterSeconds: z.number().int().positive().max(3600).optional(),
});
export type DataStateEnvelope = z.infer<typeof DataStateEnvelope>;
