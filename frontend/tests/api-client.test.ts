import { describe, it, expect } from 'vitest';
import { createApi } from '@/lib/api/client';
import { ApiRequestError } from '@/lib/api/errors';
import { withQuery, type Transport } from '@/lib/api/transport';

type Call = { path: string; init: RequestInit };
function fake(res: () => Response | Promise<Response>): { t: Transport; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    t: async (path, init = {}) => {
      calls.push({ path, init });
      return res();
    },
  };
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('api client', () => {
  it('GETs typed JSON from the right path', async () => {
    const { t, calls } = fake(() => json({ workspaces: [] }));
    const r = await createApi(t).workspaces();
    expect(r.workspaces).toEqual([]);
    expect(calls[0].path).toBe('/v1/workspaces');
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>)['idempotency-key']).toBeUndefined();
  });
  it('sends an idempotency key and body on create, and If-Match when asked', async () => {
    const { t, calls } = fake(() => json({ workspaceId: 'w', version: 1 }, 201));
    const api = createApi(t);
    await api.createWorkspace({ objective: 'o' });
    const hdr = calls[0].init.headers as Record<string, string>;
    expect(hdr['idempotency-key']).toMatch(/.{8,}/);
    expect(hdr['content-type']).toBe('application/json');
    expect(calls[0].init.body).toBe('{"objective":"o"}');
    await api.send('PUT', '/v1/x', {}, { ifMatch: 5, idempotencyKey: 'abcdefgh' });
    const h2 = calls[1].init.headers as Record<string, string>;
    expect(h2['if-match']).toBe('"5"');
    expect(h2['idempotency-key']).toBe('abcdefgh');
  });
  it('encodes the workspace id', async () => {
    const { t, calls } = fake(() => json({}));
    await createApi(t).runs('a/b');
    expect(calls[0].path).toBe('/v1/workspaces/a%2Fb/runs');
  });
  it('throws ApiRequestError carrying the state for refusals', async () => {
    const { t } = fake(() =>
      json({ errorCode: 'BUDGET_EXCEEDED', reasonCode: 'GLOBAL_CEILING', state: 'budget_exhausted', message: 'ceiling', retryable: false, traceId: 'tr' }, 402),
    );
    await expect(createApi(t).workspaces()).rejects.toMatchObject({ name: 'ApiRequestError', state: 'budget_exhausted', traceId: 'tr' });
  });
  it('maps a thrown fetch to a network ApiRequestError', async () => {
    const t: Transport = async () => {
      throw new TypeError('fetch failed');
    };
    const e = await createApi(t).workspaces().catch((x) => x);
    expect(e).toBeInstanceOf(ApiRequestError);
    expect(e.kind).toBe('network');
    expect(e.state).toBe('source_unavailable');
  });
  it('handles 204', async () => {
    const { t } = fake(() => new Response(null, { status: 204 }));
    await expect(createApi(t).send('POST', '/v1/session/revoke')).resolves.toBeUndefined();
  });
  it('builds query strings, skipping empty values', () => {
    expect(withQuery('/v1/x', { a: 1, b: undefined, c: null, d: 'x y' })).toBe('/v1/x?a=1&d=x+y');
    expect(withQuery('/v1/x')).toBe('/v1/x');
  });
});
