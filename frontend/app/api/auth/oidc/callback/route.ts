import { API_URL } from '@/lib/api/config';
import { isSecureRequest, sessionCookieHeader } from '@/lib/auth/session';
import { clearStateCookieHeader, readStateCookie, redirectTo, safeNext, sameState, toLogin } from '@/lib/auth/oidc';

export const dynamic = 'force-dynamic';

/**
 * The redirect URI registered with the identity provider. The `state` the
 * provider returns must equal the one bound to this browser at /start; only
 * then are `code` and `state` forwarded to the API (server to server) in
 * exchange for the session token, which goes into the HttpOnly session cookie.
 */
export async function GET(req: Request) {
  const secure = isSecureRequest(req);
  const clear = { 'set-cookie': clearStateCookieHeader(secure) };
  const q = new URL(req.url).searchParams;
  const bound = readStateCookie(req.headers.get('cookie'));
  const state = q.get('state');
  const code = q.get('code');
  if (q.get('error')) return toLogin(req, 'oidc_refused', clear);
  if (!bound || !state || !code || !sameState(bound.s, state)) return toLogin(req, 'oidc_state', clear);

  let r: Response;
  try {
    r = await fetch(`${API_URL}/v1/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    return toLogin(req, 'oidc_unreachable', clear);
  }
  if (!r.ok) {
    const b = (await r.json().catch(() => ({}))) as { reasonCode?: string };
    const code2 = b.reasonCode === 'OIDC_USER_NOT_PROVISIONED' ? 'oidc_not_provisioned' : b.reasonCode === 'OIDC_PROVIDER_REFUSED' ? 'oidc_refused' : 'oidc_failed';
    return toLogin(req, code2, clear);
  }
  const { token, returnTo } = (await r.json()) as { token?: string; returnTo?: string };
  if (!token) return toLogin(req, 'oidc_failed', clear);
  const h = new Headers();
  h.append('set-cookie', sessionCookieHeader(token, secure));
  h.append('set-cookie', clearStateCookieHeader(secure));
  h.set('cache-control', 'no-store');
  return redirectTo(req, safeNext(bound.n || returnTo), h);
}
