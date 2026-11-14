import { REASON_STATE, STATE_INFO, API_STATES, type ApiState } from '@/lib/contracts/generated';

/**
 * Error model for every API failure. Built from the backend's ErrorResponse
 * (docs/api/STATES.md): refusals map onto the 12-state taxonomy through
 * `state` (preferred) or `reasonCode`; errors that are none of the twelve
 * (validation, stale version, not found, internal) keep `state === null`
 * and are described by `kind`.
 */

export type ApiErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'stale_version'
  | 'validation'
  | 'rate_limited'
  | 'unavailable'
  | 'budget'
  | 'internal'
  | 'network'
  | 'unknown';

export type ErrorBody = {
  traceId?: string;
  errorCode?: string;
  reasonCode?: string;
  message?: string;
  retryable?: boolean;
  nextAction?: string;
  lastStableRevision?: number;
  details?: { path: string; issue: string }[] | Record<string, unknown>;
  retryAfterSeconds?: number;
  state?: string;
};

export class ApiRequestError extends Error {
  readonly status: number;
  readonly errorCode: string;
  readonly reasonCode: string | null;
  /** One of the 12 states, or null when the error is not a state-bearing refusal. */
  readonly state: ApiState | null;
  readonly kind: ApiErrorKind;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly traceId: string | null;
  readonly nextAction: string | null;
  readonly lastStableRevision: number | null;
  readonly details: { path: string; issue: string }[];
  /** Object-shaped `details` (for example the credits figures of a CREDITS_EXHAUSTED refusal); null when absent. */
  readonly detailsObject: Record<string, unknown> | null;

  constructor(init: {
    status: number;
    errorCode: string;
    reasonCode?: string | null;
    state?: ApiState | null;
    kind: ApiErrorKind;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number | null;
    traceId?: string | null;
    nextAction?: string | null;
    lastStableRevision?: number | null;
    details?: { path: string; issue: string }[];
    detailsObject?: Record<string, unknown> | null;
  }) {
    super(init.message);
    this.name = 'ApiRequestError';
    this.status = init.status;
    this.errorCode = init.errorCode;
    this.reasonCode = init.reasonCode ?? null;
    this.state = init.state ?? null;
    this.kind = init.kind;
    this.retryable = init.retryable;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.traceId = init.traceId ?? null;
    this.nextAction = init.nextAction ?? null;
    this.lastStableRevision = init.lastStableRevision ?? null;
    this.details = init.details ?? [];
    this.detailsObject = init.detailsObject ?? null;
  }
}

export function isApiState(v: unknown): v is ApiState {
  return typeof v === 'string' && (API_STATES as readonly string[]).includes(v);
}

/** The state a reason code maps to (STATES.md), or null. */
export function stateForReason(reasonCode: string | null | undefined): ApiState | null {
  if (!reasonCode) return null;
  return REASON_STATE[reasonCode] ?? null;
}

function kindFor(status: number, errorCode: string, state: ApiState | null): ApiErrorKind {
  switch (errorCode) {
    case 'UNAUTHENTICATED':
      return 'unauthenticated';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'NOT_FOUND':
      return 'not_found';
    case 'STALE_VERSION':
      return 'stale_version';
    case 'VALIDATION_FAILED':
    case 'DOMAIN_INVARIANT':
      return 'validation';
    case 'RATE_LIMITED':
      return 'rate_limited';
    case 'UPSTREAM_DEGRADED':
      return 'unavailable';
    case 'BUDGET_EXCEEDED':
      return 'budget';
    case 'INTERNAL':
      return 'internal';
  }
  if (state === 'rate_limited') return 'rate_limited';
  if (state === 'budget_exhausted') return 'budget';
  if (state === 'source_unavailable') return 'unavailable';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'stale_version';
  if (status === 422 || status === 400) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  if (status >= 500) return 'internal';
  return 'unknown';
}

/** HTTP status fallback when the body carries neither `state` nor a mapped reason code. */
function stateForStatus(status: number): ApiState | null {
  if (status === 401 || status === 403) return 'permission_denied';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 504) return 'source_unavailable';
  return null;
}

/** Build an ApiRequestError from a non-2xx response. Never throws. */
export function errorFromResponse(
  status: number,
  body: unknown,
  headers?: { get(name: string): string | null },
): ApiRequestError {
  const b: ErrorBody = body && typeof body === 'object' ? (body as ErrorBody) : {};
  const errorCode = typeof b.errorCode === 'string' ? b.errorCode : `HTTP_${status}`;
  const reasonCode = typeof b.reasonCode === 'string' ? b.reasonCode : null;
  const state: ApiState | null = isApiState(b.state)
    ? b.state
    : (stateForReason(reasonCode) ?? stateForStatus(status));
  const headerRetry = Number(headers?.get('retry-after'));
  const retryAfter =
    typeof b.retryAfterSeconds === 'number'
      ? b.retryAfterSeconds
      : Number.isFinite(headerRetry) && headerRetry > 0
        ? headerRetry
        : null;
  const kind = kindFor(status, errorCode, state);
  // Never retry 401/403: it cannot help and may cost money.
  const neverRetry = kind === 'unauthenticated' || kind === 'forbidden';
  const retryable = neverRetry
    ? false
    : typeof b.retryable === 'boolean'
      ? b.retryable
      : state
        ? STATE_INFO[state].retryable
        : status >= 500;
  return new ApiRequestError({
    status,
    errorCode,
    reasonCode,
    state,
    kind,
    message: typeof b.message === 'string' && b.message ? b.message : `Request failed (${status}).`,
    retryable,
    retryAfterSeconds: retryAfter,
    traceId: b.traceId ?? headers?.get('x-trace-id') ?? null,
    nextAction: b.nextAction ?? null,
    lastStableRevision: b.lastStableRevision ?? null,
    details: Array.isArray(b.details) ? b.details : undefined,
    detailsObject: b.details && typeof b.details === 'object' && !Array.isArray(b.details) ? (b.details as Record<string, unknown>) : null,
  });
}

/** Transport failure (fetch threw): treated as the source being unavailable. */
export function networkError(cause: unknown): ApiRequestError {
  return new ApiRequestError({
    status: 0,
    errorCode: 'NETWORK',
    state: 'source_unavailable',
    kind: 'network',
    message: cause instanceof Error ? cause.message : 'The network request failed.',
    retryable: true,
  });
}

/** The 12-state mapping for an arbitrary thrown value. */
export function stateOfError(e: unknown): ApiState | null {
  return e instanceof ApiRequestError ? e.state : null;
}

/** Shape of any data envelope that carries completeness information. */
export type EnvelopeLike = {
  state?: string | null;
  status?: string | null;
  truncation?: { truncated?: boolean } | null;
  truncated?: boolean | null;
  freshnessWarning?: unknown;
  cannotCompute?: unknown;
  partial?: boolean | null;
};

/**
 * Map a data response onto its state. CANNOT_COMPUTE is HTTP 200 and renders as
 * insufficient_data; an explicit `state` wins; otherwise completeness hints decide.
 */
export function stateOfEnvelope(env: EnvelopeLike | null | undefined): ApiState {
  if (!env) return 'loading';
  if (isApiState(env.state)) return env.state;
  if (env.status === 'CANNOT_COMPUTE' || env.cannotCompute) return 'insufficient_data';
  if (env.truncation?.truncated || env.truncated === true) return 'truncated';
  if (env.freshnessWarning) return 'stale';
  if (env.partial === true) return 'partial';
  return 'complete';
}
