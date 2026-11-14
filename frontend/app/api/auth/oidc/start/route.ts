import { API_URL } from '@/lib/api/config';
import { isSecureRequest } from '@/lib/auth/session';
import { safeNext, stateCookieHeader, toLogin } from '@/lib/auth/oidc';

export const dynamic = 'force-dynamic';

/**
 * Start single sign-on. Asks the API for the provider URL (it keeps the PKCE
 * verifier and nonce per `state`), binds that `state` to this browser in our
 * own HttpOnly cookie, then redirects to the provider. 404 OIDC_NOT_CONFIGURED
 * means no provider is configured yet: the login page says so.
 */
export async function GET(req: Request) {
  if (process.env.NEARESIS_OIDC !== '1') return toLogin(req, 'oidc_not_configured');
  const next = safeNext(new URL(req.url).searchParams.get('next'));
  let r: Response;
  try {
    r = await fetch(`${API_URL}/v1/auth/oidc/login?mode=json&returnTo=${encodeURIComponent(next)}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    return toLogin(req, 'oidc_unreachable');
  }
  if (!r.ok) {
    const b = (await r.json().catch(() => ({}))) as { reasonCode?: string };
    return toLogin(req, b.reasonCode === 'OIDC_NOT_CONFIGURED' ? 'oidc_not_configured' : r.status === 429 ? 'oidc_rate_limited' : 'oidc_failed');
  }
  const b = (await r.json()) as { authorizationUrl?: string; state?: string };
  if (!b.authorizationUrl || !b.state) return toLogin(req, 'oidc_failed');
  return new Response(null, {
    status: 303,
    headers: {
      location: b.authorizationUrl,
      'set-cookie': stateCookieHeader(b.state, next, isSecureRequest(req)),
      'cache-control': 'no-store',
    },
  });
}
