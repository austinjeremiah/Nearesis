import { z } from "zod";
import { IsoDateTime } from "./common.ts";

/**
 * v1.6.0 (additive): overload protection and graceful degradation (ch.13 "Backpressure", ch.16b PERF09).
 * Nothing here changes an existing shape; every field added to an older schema is optional.
 */

/** Machine reasons an overload refusal can carry in `ErrorResponse.reasonCode` (always HTTP 429 + `Retry-After`). */
export const OverloadReason = z.enum([
  "TENANT_QUEUE_FULL",
  "GLOBAL_QUEUE_FULL",
  "QUEUE_TIMEOUT",
  "QUEUE_EVICTED",
  "TOO_MANY_STREAMS",
]);
export type OverloadReason = z.infer<typeof OverloadReason>;

/** Priority of a submitted investigation. A caller may only lower it: `high` is reserved for server-originated work. */
export const SubmissionPriority = z.enum(["normal", "low"]);
export type SubmissionPriority = z.infer<typeof SubmissionPriority>;

/**
 * Explicit truncation metadata for a result that was cut by the max-rows rule. A UI must label a truncated or
 * downsampled result with this, never present it as complete. `requestedRows` is the number of rows or points the
 * query produced before the rule applied; `returnedRows` is what was returned.
 */
export const ResultTruncation = z.strictObject({
  truncated: z.literal(true),
  reason: z.literal("MAX_ROWS"),
  /** `truncate` keeps the first rows in order; the other two are the shared downsamplers (spikes survive). */
  method: z.enum(["truncate", "min_max_bucket", "lttb"]),
  requestedRows: z.number().int().nonnegative(),
  /** True when the producer stopped counting once the limit was exceeded, so `requestedRows` is a lower bound. */
  requestedRowsIsLowerBound: z.boolean().optional(),
  returnedRows: z.number().int().nonnegative(),
  maxRows: z.number().int().positive(),
});
export type ResultTruncation = z.infer<typeof ResultTruncation>;

/** Freshness warning attached to anything served while its source is degraded. */
export const FreshnessWarning = z.strictObject({
  code: z.enum(["SOURCE_DEGRADED", "SOURCE_UNAVAILABLE", "BREAKER_OPEN"]),
  message: z.string().max(500),
  /** Watermark (event time) of the snapshot actually being shown. */
  asOf: IsoDateTime,
  /** Seconds the shown snapshot is behind now. */
  staleSeconds: z.number().nonnegative(),
  /** When the source was first seen degraded in this episode. */
  degradedSince: IsoDateTime,
});
export type FreshnessWarning = z.infer<typeof FreshnessWarning>;

/** Circuit breaker states. `half_open` admits exactly one cautious probe. */
export const BreakerState = z.enum(["closed", "open", "half_open"]);
export type BreakerState = z.infer<typeof BreakerState>;

/**
 * A source read served by the degradation guard. `servedFrom: "last_finalized_snapshot"` always carries a warning and
 * `currentPublicationAllowed: false`: values from it must never be published as current.
 */
export const SourceServe = z.strictObject({
  sourceId: z.string().min(1).max(200),
  servedFrom: z.enum(["live", "last_finalized_snapshot"]),
  asOf: IsoDateTime,
  breaker: BreakerState,
  currentPublicationAllowed: z.boolean(),
  warning: FreshnessWarning.optional(),
});
export type SourceServe = z.infer<typeof SourceServe>;
