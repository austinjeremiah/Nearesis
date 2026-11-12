import { cookies } from 'next/headers';
import { API_URL, SESSION_COOKIE } from '@/lib/api/config';
import { clearCookieHeader, isSecureRequest, sameOrigin } from '@/lib/auth/session';

/** Sign out: revoke the token upstream (POST /v1/session/revoke, 204) then clear the cookie. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ errorCode: 'FORBIDDEN', message: 'Origin not allowed.' }, { status: 403 });
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await fetch(`${API_URL}/v1/session/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      });
    } catch {
      /* the cookie is cleared regardless; an expired token stops working on its own */
    }
  }
  const res = new Response(null, { status: 204 });
  res.headers.append('set-cookie', clearCookieHeader(isSecureRequest(req)));
  return res;
}
