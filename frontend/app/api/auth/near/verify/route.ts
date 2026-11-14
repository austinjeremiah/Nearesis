import { API_URL } from '@/lib/api/config';
import { isSecureRequest, sameOrigin, sessionCookieHeader } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Step 2 of NEAR wallet sign-in: sends the wallet's signed challenge to
 * POST /v1/auth/near/verify and stores the kernel token in the HttpOnly
 * session cookie, exactly like the dev login. The token is never returned to
 * the browser. Refusals pass through unchanged so the page can show reasonCode.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ errorCode: 'FORBIDDEN', reasonCode: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed.' }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const body = { challengeId: b.challengeId, accountId: b.accountId, publicKey: b.publicKey, signature: b.signature };
  let r: Response;
  try {
    r = await fetch(`${API_URL}/v1/auth/near/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return Response.json(
      { errorCode: 'UPSTREAM_DEGRADED', state: 'source_unavailable', message: 'The API is not reachable.', retryable: true },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
  if (!r.ok) {
    return new Response(await r.text(), {
      status: r.status,
      headers: { 'content-type': r.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
    });
  }
  const out = (await r.json().catch(() => null)) as { token?: string; userId?: string; accountId?: string; created?: boolean } | null;
  if (!out?.token) {
    return Response.json({ errorCode: 'INTERNAL', message: 'The API returned no session token.' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  const res = Response.json(
    { userId: out.userId ?? null, accountId: out.accountId ?? null, created: out.created === true },
    { headers: { 'cache-control': 'no-store' } },
  );
  res.headers.append('set-cookie', sessionCookieHeader(out.token, isSecureRequest(req)));
  return res;
}
