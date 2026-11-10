import { HTTP_STATUS_FOR } from "@nearesis/contracts";
import type { ErrorCode, ErrorResponse } from "@nearesis/contracts";
import { redactString } from "./redact.ts";

export interface KernelErrorOptions {
  retryable?: boolean;
  nextAction?: string;
  lastStableRevision?: number;
  details?: Array<{ path: string; issue: string }>;
}

/** Typed domain error. `code` is the public ErrorCode; `reasonCode` is the machine-readable sub-reason. */
export class KernelError extends Error {
  readonly code: ErrorCode;
  readonly reasonCode: string;
  readonly opts: KernelErrorOptions;
  constructor(code: ErrorCode, reasonCode: string, message: string, opts: KernelErrorOptions = {}) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.reasonCode = reasonCode;
    this.opts = opts;
  }
}

interface PgLikeError {
  code?: string;
}

/** Map any thrown value to a safe ErrorResponse + HTTP status. Raw DB errors are never exposed. */
export function toErrorResponse(err: unknown, traceId: string): { status: number; body: ErrorResponse } {
  if (err instanceof KernelError) {
    const body: ErrorResponse = {
      traceId,
      errorCode: err.code,
      reasonCode: err.reasonCode,
      message: redactString(err.message).slice(0, 2000),
      retryable: err.opts.retryable ?? (err.code === "STALE_VERSION" || err.code === "UPSTREAM_DEGRADED"),
      ...(err.opts.nextAction ? { nextAction: err.opts.nextAction } : {}),
      ...(err.opts.lastStableRevision !== undefined
        ? { lastStableRevision: err.opts.lastStableRevision }
        : {}),
      ...(err.opts.details ? { details: err.opts.details.slice(0, 100) } : {}),
    };
    return { status: HTTP_STATUS_FOR[err.code], body };
  }
  const pg = (err as PgLikeError | null)?.code;
  if (pg === "40001" || pg === "40P01") {
    return toErrorResponse(
      new KernelError(
        "STALE_VERSION",
        "SERIALIZATION_CONFLICT",
        "Concurrent modification; retry the request.",
        {
          retryable: true,
          nextAction: "Re-read the workspace and retry.",
        },
      ),
      traceId,
    );
  }
  return {
    status: HTTP_STATUS_FOR.INTERNAL,
    body: {
      traceId,
      errorCode: "INTERNAL",
      reasonCode: "INTERNAL",
      message: "Internal error.",
      retryable: false,
    },
  };
}

export function isUniqueViolation(err: unknown): boolean {
  return (err as PgLikeError | null)?.code === "23505";
}
