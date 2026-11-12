import 'server-only';
import { cookies } from 'next/headers';
import { API_URL, SESSION_COOKIE } from '@/lib/api/config';
import { sameOrigin } from '@/lib/auth/session';
import { isForwardable } from './forwardable';

const FORWARD_REQUEST_HEADERS = [
  'content-type',
  'if-match',
  'idempotency-key',
  'last-event-id',
  'accept',
  'x-client-id',
  'x-trace-id',
];
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'x-trace-id',
  'cache-control',
  'retry-after',
  'etag',
  'content-disposition',
  'content-security-policy',
  'x-content-type-options',
  'x-capsule-sha256',
];

const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function clientIdFrom(req: Request): string | null {
  const c = req.headers.get('x-client-id') ?? new URL(req.url).searchParams.get('clientId');
  return c && CLIENT_ID.test(c) ? c : null;
}

export function unauthenticated(): Response {
  return Response.json(
    { errorCode: 'UNAUTHENTICATED', reasonCode: 'MISSING_SESSION', state: 'permission_denied', message: 'Not signed in.', retryable: false },
    { status: 401, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Forward a request to the API with the session cookie as bearer. Streams the
 * response body (no buffering, so SSE works) and aborts upstream when the
 * browser disconnects.
 */
export async function forwardToApi(req: Request, subPath: string, search: string): Promise<Response> {
  if (!isForwardable(subPath)) return Response.json({ errorCode: 'NOT_FOUND', message: 'Not found.' }, { status: 404 });
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating && !sameOrigin(req)) return Response.json({ errorCode: 'FORBIDDEN', reasonCode: 'ORIGIN_NOT_ALLOWED', state: 'permission_denied', message: 'Origin not allowed.', retryable: false }, { status: 403 });
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return unauthenticated();

  const headers = new Headers();
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const cid = clientIdFrom(req);
  if (cid) headers.set('x-client-id', cid);
  headers.set('authorization', `Bearer ${token}`);

  const params = new URLSearchParams(search);
  params.delete('clientId');
  const qs = params.toString();

  let r: Response;
  try {
    r = await fetch(`${API_URL}/v1/${subPath}${qs ? `?${qs}` : ''}`, {
      method: req.method,
      headers,
      body: mutating ? await req.text() : undefined,
      cache: 'no-store',
      signal: req.signal,
    });
  } catch {
    return Response.json(
      { errorCode: 'UPSTREAM_DEGRADED', state: 'source_unavailable', message: 'The API is not reachable.', retryable: true },
      { status: 503 },
    );
  }
  const out = new Headers();
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has('cache-control')) out.set('cache-control', 'no-store');
  if ((out.get('content-type') ?? '').startsWith('text/event-stream')) out.set('x-accel-buffering', 'no');
  return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: out });
}
