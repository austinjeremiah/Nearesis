import { z } from 'zod';

/**
 * Global error model from Frontend Product Spec v1 section 7.4.
 *
 * Every API failure renders as message + trace id + reason + next action. The
 * spec forbids dumping stack traces or secret-bearing request bodies, so the
 * envelope deliberately has nowhere to put them.
 */

export const ApiErrorCategory = z.enum([
  'unauthenticated', // 401 — sign in
  'forbidden', // 403 — permission
  'not_found', // 404 — missing or private object
  'stale_revision', // 409 — expected revision mismatch
  'too_large', // 413
  'invalid_query', // 422 — invalid query or domain constraint
  'quota', // 429
  'provider_degraded', // 503
  'network', // client-side transport failure
]);
export type ApiErrorCategory = z.infer<typeof ApiErrorCategory>;

export const ApiError = z.object({
  category: ApiErrorCategory,
  httpStatus: z.number().int(),
  /** Stable machine code, e.g. "SEMANTIC_VERSION_MISMATCH". */
  code: z.string().min(1),
  /** One sentence, safe to render. No secrets, no stack. */
  message: z.string().min(1),
  traceId: z.string().min(1),
  retryable: z.boolean(),
  /**
   * What the user can actually do. `null` means nothing, which is itself worth
   * saying rather than showing a Retry button that cannot succeed.
   */
  nextAction: z
    .object({ label: z.string().min(1), href: z.string().optional() })
    .nullable(),
  /** Present on 409 so the client can offer reload-and-reapply. */
  currentRevision: z.number().int().nonnegative().optional(),
  /** Present on 429 so the client backs off instead of hammering a paid API. */
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

/**
 * A 404 is returned for a workspace in another tenant as well as one that does
 * not exist. Spec 1.3: a foreign workspace returns the same protected
 * not-found behavior, so the UI must not distinguish the two in copy either.
 */
export const PROTECTED_NOT_FOUND_MESSAGE =
  'That workspace does not exist, or you do not have access to it.';

/** Spec 7.2: never retry 401/403. Retrying cannot help and may cost money. */
export function isRetryable(error: ApiError): boolean {
  if (error.category === 'unauthenticated' || error.category === 'forbidden') return false;
  return error.retryable;
}
