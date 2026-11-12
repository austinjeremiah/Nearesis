import { cookies } from 'next/headers';
import { API_URL, SESSION_COOKIE } from '@/lib/api/config';
import { tokenClaims } from '@/lib/auth/session';
import type { Me } from '@/lib/api/types';

/**
 * Current identity. Uses the backend's GET /v1/me when it exists (worker BE1).
 * Until then it answers from the session token's own claims (subject and org),
 * and says so in `source`. 401 when there is no session or the API refuses it.
 */
export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return Response.json({ errorCode: 'UNAUTHENTICATED', state: 'permission_denied', message: 'Not signed in.', retryable: false }, { status: 401 });
  let r: Response | null = null;
  try {
    r = await fetch(`${API_URL}/v1/me`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  } catch {
    return Response.json({ errorCode: 'UPSTREAM_DEGRADED', state: 'source_unavailable', message: 'The API is not reachable.', retryable: true }, { status: 503 });
  }
  if (r.status === 401) return new Response(await r.text(), { status: 401, headers: { 'content-type': 'application/json' } });
  if (r.ok) {
    const b = (await r.json()) as Record<string, unknown>;
    const me: Me = {
      subject: String(b.subject ?? b.userId ?? b.id ?? ''),
      orgId: (b.orgId as string) ?? null,
      displayName: (b.displayName as string) ?? (b.name as string) ?? null,
      email: (b.email as string) ?? null,
      role: (b.role as string) ?? null,
      source: 'api',
    };
    return Response.json(me, { headers: { 'cache-control': 'no-store' } });
  }
  // /v1/me not available yet: validate the token with a cheap authenticated read, then answer from claims.
  const probe = await fetch(`${API_URL}/v1/workspaces`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' }).catch(() => null);
  if (!probe) return Response.json({ errorCode: 'UPSTREAM_DEGRADED', state: 'source_unavailable', message: 'The API is not reachable.', retryable: true }, { status: 503 });
  if (probe.status === 401) return new Response(await probe.text(), { status: 401, headers: { 'content-type': 'application/json' } });
  const c = tokenClaims(token);
  const me: Me = { subject: c.sub ?? '', orgId: c.org ?? null, displayName: null, email: null, role: null, source: 'token' };
  return Response.json(me, { headers: { 'cache-control': 'no-store' } });
}
