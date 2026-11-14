import { KernelError } from "@nearesis/kernel";
import type { OverloadReason } from "@nearesis/contracts";

/**
 * A 429 refusal caused by overload protection. `retryAfterS` becomes the `Retry-After` header and
 * `ErrorResponse.retryAfterSeconds`; callers must wait at least that long.
 */
export class OverloadError extends KernelError {
  readonly retryAfterS: number;
  constructor(reason: OverloadReason, message: string, retryAfterS: number) {
    const s = Math.min(3600, Math.max(1, Math.ceil(retryAfterS)));
    super("RATE_LIMITED", reason, message, { retryable: true, nextAction: `Retry after ${s} seconds.` });
    this.name = "OverloadError";
    this.retryAfterS = s;
  }
}
