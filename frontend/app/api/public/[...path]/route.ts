import { API_URL } from '@/lib/api/config';

export const dynamic = 'force-dynamic';

/**
 * Public BFF read: `/api/public/publications/<id>[/exports/<path>]` -> `{API}/v1/public/publications/...`.
 * It never reads or forwards the session cookie or any authorization header, so a publication is exactly as
 * visible here as to an anonymous reader. GET only, and only the public publication and public thesis shapes.
 */
const ALLOWED = /^(publications\/[A-Za-z0-9._-]{1,200}(\/exports\/[A-Za-z0-9._~%/-]{1,400})?|theses\/[A-Za-z0-9._-]{1,200}(\/files\/[A-Za-z0-9._~%/-]{1,400})?)$/;
const FORWARD_RESPONSE_HEADERS = ['content-type', 'x-trace-id', 'cache-control', 'retry-after', 'content-disposition', 'content-security-policy', 'x-content-type-options', 'x-capsule-sha256'];

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const sub = path.join('/');
  if (!ALLOWED.test(sub) || sub.split('/').some((s) => s === '.' || s === '..' || decodeURIComponent(s).includes('..'))) {
    return Response.json({ errorCode: 'NOT_FOUND', message: 'Not found.' }, { status: 404 });
  }
  let r: Response;
  try {
    r = await fetch(`${API_URL}/v1/public/${sub}`, { method: 'GET', cache: 'no-store', credentials: 'omit' });
  } catch {
    return Response.json({ errorCode: 'UPSTREAM_DEGRADED', state: 'source_unavailable', message: 'The API is not reachable.', retryable: true }, { status: 503 });
  }
  const out = new Headers();
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has('cache-control')) out.set('cache-control', 'no-store');
  return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: out });
}
