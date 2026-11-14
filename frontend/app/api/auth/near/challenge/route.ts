import { API_URL } from '@/lib/api/config';
import { sameOrigin } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Step 1 of NEAR wallet sign-in: asks the API for a single-use NEP-413
 * challenge (POST /v1/auth/near/challenge). Public on the API side, so no
 * session is needed; the origin check still applies.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return Response.json({ errorCode: 'FORBIDDEN', reasonCode: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed.' }, { status: 403 });
  let r: Response;
  try {
    r = await fetch(`${API_URL}/v1/auth/near/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
  } catch {
    return Response.json(
      { errorCode: 'UPSTREAM_DEGRADED', state: 'source_unavailable', message: 'The API is not reachable.', retryable: true },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
  return new Response(await r.text(), {
    status: r.status,
    headers: { 'content-type': r.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
  });
}
