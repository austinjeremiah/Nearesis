import { cookies } from 'next/headers';
import { API_URL, SESSION_COOKIE } from '@/lib/api/config';
import type { Me } from '@/lib/api/types';
import type { MeResponse } from '@/lib/api/shell';

/** Current identity from the API's GET /v1/me. 401 when there is no session or the API refuses it. */
export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return Response.json({ errorCode: 'UNAUTHENTICATED', state: 'permission_denied', message: 'Not signed in.', retryable: false }, { status: 401 });
  let r: Response;
  try {
    r = await fetch(`${API_URL}/v1/me`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  } catch {
    return Response.json({ errorCode: 'UPSTREAM_DEGRADED', state: 'source_unavailable', message: 'The API is not reachable.', retryable: true }, { status: 503 });
  }
  if (!r.ok) return new Response(await r.text(), { status: r.status, headers: { 'content-type': 'application/json' } });
  const b = (await r.json()) as MeResponse;
  const me: Me = {
    subject: b.principal.userId,
    orgId: b.org.id,
    displayName: b.principal.displayName,
    email: null,
    role: b.role,
    source: 'api',
  };
  return Response.json({ ...me, orgName: b.org.name, permissions: b.permissions }, { headers: { 'cache-control': 'no-store' } });
}
