import { HTTP_STATUS_FOR, type ErrorCode, type ErrorResponse } from "@nearesis/contracts";
import { randomUUID } from "node:crypto";
import type { QueryErr } from "./types.ts";

export type ReasonCode =
  | "UNKNOWN_FIELD"
  | "INVALID_TYPE"
  | "INVALID_FORMAT"
  | "INVALID_VALUE"
  | "LIMIT_EXCEEDED"
  | "REQUIRED_FIELD_MISSING"
  | "TIME_RANGE_INVALID"
  | "UNKNOWN_MEMBER"
  | "MEMBER_NOT_VISIBLE"
  | "AGGREGATE_ONLY_BREAKDOWN_REFUSED"
  | "INCOMPATIBLE_VIEWS"
  | "UNIT_MISMATCH"
  | "COST_CAP"
  | "WINDOW_TOO_LARGE"
  | "PERIOD_UNIQUE_SUM_REFUSED"
  | "INCOMPLETE_WINDOW"
  | "STALE_SEMANTIC_VERSION"
  | "UNAPPROVED_DEFINITION"
  | "EXPERIMENTAL_PROMOTION_REFUSED"
  | "CUBE_UNAVAILABLE"
  | "INTERNAL";

export function fail(
  code: ErrorCode,
  reasonCode: ReasonCode,
  message: string,
  extra: { details?: Array<{ path: string; issue: string }>; nextAction?: string; retryable?: boolean } = {},
): QueryErr {
  const error: ErrorResponse = {
    traceId: randomUUID(),
    errorCode: code,
    reasonCode,
    message: message.slice(0, 2000),
    retryable: extra.retryable ?? code === "UPSTREAM_DEGRADED",
    ...(extra.nextAction ? { nextAction: extra.nextAction } : {}),
    ...(extra.details ? { details: extra.details.slice(0, 100) } : {}),
  };
  return { ok: false, status: HTTP_STATUS_FOR[code], error };
}
