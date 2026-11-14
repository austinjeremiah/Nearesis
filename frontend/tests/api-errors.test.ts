import { describe, it, expect } from 'vitest';
import { API_STATES, REASON_STATE, STATE_INFO } from '@/lib/contracts/generated';
import { STATE_UI } from '@/lib/api/states';
import { errorFromResponse, networkError, stateOfEnvelope, stateOfError, stateForReason } from '@/lib/api/errors';

const h = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });

describe('12-state taxonomy (generated from STATES.md)', () => {
  it('has exactly twelve states and a UI entry for each', () => {
    expect(API_STATES).toHaveLength(12);
    for (const s of API_STATES) {
      expect(STATE_UI[s].title.length).toBeGreaterThan(0);
      expect(STATE_INFO[s].meaning.length).toBeGreaterThan(0);
    }
  });
  it('maps every reason code to a known state', () => {
    for (const [code, state] of Object.entries(REASON_STATE)) expect(API_STATES, code).toContain(state);
    expect(Object.keys(REASON_STATE).length).toBeGreaterThan(60);
  });
});

describe('errorFromResponse', () => {
  it('prefers the explicit state', () => {
    const e = errorFromResponse(429, { errorCode: 'RATE_LIMITED', reasonCode: 'TOO_MANY_STREAMS', state: 'rate_limited', message: 'm', retryable: true, retryAfterSeconds: 7, traceId: 't1' });
    expect(e.state).toBe('rate_limited');
    expect(e.kind).toBe('rate_limited');
    expect(e.retryAfterSeconds).toBe(7);
    expect(e.retryable).toBe(true);
    expect(e.traceId).toBe('t1');
  });
  it('falls back to the reason code, then the HTTP status', () => {
    expect(errorFromResponse(402, { errorCode: 'BUDGET_EXCEEDED', reasonCode: 'GLOBAL_CEILING', message: 'x', retryable: false }).state).toBe('budget_exhausted');
    expect(errorFromResponse(422, { errorCode: 'DOMAIN_INVARIANT', reasonCode: 'METHOD_NOT_VALIDATED', message: 'x', retryable: false }).state).toBe('method_unvalidated');
    expect(errorFromResponse(503, null).state).toBe('source_unavailable');
    expect(errorFromResponse(401, { errorCode: 'UNAUTHENTICATED', message: 'x', retryable: false }).state).toBe('permission_denied');
  });
  it('leaves non-refusals without a state', () => {
    for (const [status, errorCode, kind] of [
      [404, 'NOT_FOUND', 'not_found'],
      [409, 'STALE_VERSION', 'stale_version'],
      [422, 'VALIDATION_FAILED', 'validation'],
      [500, 'INTERNAL', 'internal'],
    ] as const) {
      const e = errorFromResponse(status, { errorCode, message: 'x', retryable: false });
      expect(e.state, errorCode).toBeNull();
      expect(e.kind).toBe(kind);
    }
  });
  it('never retries 401/403 even if the body says retryable', () => {
    expect(errorFromResponse(401, { errorCode: 'UNAUTHENTICATED', message: 'x', retryable: true }).retryable).toBe(false);
    expect(errorFromResponse(403, { errorCode: 'FORBIDDEN', message: 'x', retryable: true }).retryable).toBe(false);
  });
  it('reads Retry-After from the header when the body has none', () => {
    expect(errorFromResponse(429, { errorCode: 'RATE_LIMITED', message: 'x', retryable: true }, h({ 'retry-after': '12' })).retryAfterSeconds).toBe(12);
  });
  it('survives garbage bodies', () => {
    const e = errorFromResponse(500, 'oops');
    expect(e.message).toMatch(/500/);
  });
  it('treats transport failure as source_unavailable and retryable', () => {
    const e = networkError(new Error('boom'));
    expect(e.state).toBe('source_unavailable');
    expect(e.retryable).toBe(true);
    expect(stateOfError(e)).toBe('source_unavailable');
    expect(stateOfError(new Error('x'))).toBeNull();
  });
  it('exposes stateForReason', () => {
    expect(stateForReason('TOO_MANY_STREAMS')).toBe('rate_limited');
    expect(stateForReason('NOPE')).toBeNull();
  });
});

describe('stateOfEnvelope', () => {
  it('maps data envelopes onto states', () => {
    expect(stateOfEnvelope({ state: 'stale' })).toBe('stale');
    expect(stateOfEnvelope({ status: 'CANNOT_COMPUTE' })).toBe('insufficient_data');
    expect(stateOfEnvelope({ cannotCompute: { missing: [] } })).toBe('insufficient_data');
    expect(stateOfEnvelope({ truncation: { truncated: true } })).toBe('truncated');
    expect(stateOfEnvelope({ freshnessWarning: { reason: 'SOURCE_DEGRADED' } })).toBe('stale');
    expect(stateOfEnvelope({ partial: true })).toBe('partial');
    expect(stateOfEnvelope({})).toBe('complete');
    expect(stateOfEnvelope(undefined)).toBe('loading');
  });
});
