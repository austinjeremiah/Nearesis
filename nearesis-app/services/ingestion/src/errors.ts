export type IngestionErrorCode =
  | "ARCHIVE_IMMUTABLE"
  | "EGRESS_DENIED"
  | "ENDPOINT_NOT_ALLOWLISTED"
  | "DRY_REQUIRED"
  | "QUOTE_ONLY_WIRE_VIOLATION"
  | "BQ_REJECTED"
  | "AUTH_REJECTED"
  | "RATE_LIMITED"
  | "QUARANTINED"
  | "PRICE_UNAVAILABLE"
  | "SEGMENT_UNVERIFIED"
  | "INVALID_INPUT";

/** Typed ingestion error. `detail` must never contain secret values. */
export class IngestionError extends Error {
  readonly code: IngestionErrorCode;
  readonly retryable: boolean;
  readonly detail: Record<string, unknown>;
  constructor(
    code: IngestionErrorCode,
    retryable: boolean,
    detail: Record<string, unknown> = {},
    message?: string,
  ) {
    super(message ?? `${code}${detail.reason ? `: ${String(detail.reason)}` : ""}`);
    this.name = "IngestionError";
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}
