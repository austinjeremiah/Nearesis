import { ApiRequestError, errorFromResponse, networkError } from './errors';

/**
 * A transport sends a request to the kernel API. `path` is the API path
 * starting with `/v1/`. Two implementations exist:
 *   - server (lib/api/server.ts): direct to NEARESIS_API_URL with the session cookie as bearer
 *   - browser (lib/api/browser.ts): same-origin BFF at /api/k, cookie sent automatically
 */
export type Transport = (path: string, init?: RequestInit) => Promise<Response>;

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Optimistic concurrency: sent as `If-Match: "<version>"`. */
  ifMatch?: number | string;
  /** Replay-safe writes. Defaults to a fresh key on POST/PUT/PATCH/DELETE. */
  idempotencyKey?: string | false;
  signal?: AbortSignal;
};

export function withQuery(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Perform a request and parse JSON; throws ApiRequestError for every failure. */
export async function requestJson<T>(
  transport: Transport,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  if (opts.ifMatch !== undefined) headers['if-match'] = `"${opts.ifMatch}"`;
  if (method !== 'GET' && opts.idempotencyKey !== false) {
    headers['idempotency-key'] = opts.idempotencyKey ?? newKey();
  }
  let res: Response;
  try {
    res = await transport(withQuery(path, opts.query), { method, headers, body, signal: opts.signal });
  } catch (e) {
    if (e instanceof ApiRequestError) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw networkError(e);
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) throw errorFromResponse(res.status, parsed, res.headers);
  return (res.status === 204 ? undefined : parsed) as T;
}
