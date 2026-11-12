import { API_URL, devLoginEnabled } from '@/lib/api/config';
import { isSecureRequest, sameOrigin, sessionCookieHeader } from '@/lib/auth/session';

/**
 * Dev sign-in, behind NEARESIS_DEV_LOGIN=1 (and never in a production build
 * unless NEARESIS_TEST_HOOKS=1). Exchanges a subject for a kernel session
 * token via POST /v1/dev/login and stores it in the HttpOnly cookie.
 * GET reports whether the dev flag is on, so /login can show the button.
 */
export async function GET() {
  return Response.json({ enabled: devLoginEnabled() }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: Request) {
  if (!devLoginEnabled()) return Response.json({ errorCode: 'NOT_FOUND', message: 'Not found.' }, { status: 404 });
  if (!sameOrigin(req)) return Response.json({ errorCode: 'FORBIDDEN', message: 'Origin not allowed.' }, { status: 403 });
  const { subject } = (await req.json().catch(() => ({}))) as { subject?: string };
  const oidcSubject = (subject ?? '').trim() || 'dev-owner';
  let r: Response;
  try {
    r = await fetch(`${API_URL}/v1/dev/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcSubject }),
      cache: 'no-store',
    });
  } catch {
    return Response.json(
      { errorCode: 'UPSTREAM_DEGRADED', state: 'source_unavailable', message: 'The API is not reachable.', retryable: true },
      { status: 503 },
    );
  }
  if (!r.ok) return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  const { token } = (await r.json()) as { token: string };
  const res = new Response(null, { status: 204 });
  res.headers.append('set-cookie', sessionCookieHeader(token, isSecureRequest(req)));
  return res;
}
