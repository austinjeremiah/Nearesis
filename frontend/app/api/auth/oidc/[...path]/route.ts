import { API_URL } from '@/lib/api/config';
import { isSecureRequest, sessionCookieHeader } from '@/lib/auth/session';

/**
 * OIDC plug-in point. The backend (worker BE1) serves `/v1/auth/*`; this route
 * forwards `/api/auth/oidc/<path>` to `/v1/auth/<path>` (start, callback) and:
 *   - passes redirects through (to the identity provider, then back to the app);
 *   - when the API answers with JSON `{ token }`, stores it in the HttpOnly
 *     session cookie and redirects to `next` (default /home).
 * The upstream contract is not final, so adjust here only; no page changes.
 * Disabled unless NEARESIS_OIDC=1.
 */
async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  if (process.env.NEARESIS_OIDC !== '1') return Response.json({ errorCode: 'NOT_FOUND', message: 'Not found.' }, { status: 404 });
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const r = await fetch(`${API_URL}/v1/auth/${path.map(encodeURIComponent).join('/')}${url.search}`, {
    method: req.method,
    headers: { accept: 'application/json', 'content-type': req.headers.get('content-type') ?? 'application/json' },
    body: req.method === 'GET' ? undefined : await req.text(),
    redirect: 'manual',
    cache: 'no-store',
  });
  if (r.status >= 300 && r.status < 400) {
    const out = new Headers();
    const loc = r.headers.get('location');
    if (loc) out.set('location', loc);
    return new Response(null, { status: r.status, headers: out });
  }
  const text = await r.text();
  if (r.ok) {
    try {
      const { token } = JSON.parse(text) as { token?: string };
      if (token) {
        const next = url.searchParams.get('next');
        const res = new Response(null, { status: 303, headers: { location: next?.startsWith('/') ? next : '/home' } });
        res.headers.append('set-cookie', sessionCookieHeader(token, isSecureRequest(req)));
        return res;
      }
    } catch {
      /* not JSON: pass through */
    }
  }
  return new Response(text, { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' } });
}
export { forward as GET, forward as POST };
