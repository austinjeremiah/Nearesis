import { forwardToApi } from '@/lib/auth/bff';

export const dynamic = 'force-dynamic';

/**
 * Same-origin BFF proxy: `/api/k/<path>` -> `{API}/v1/<path>` with the session
 * cookie as bearer. Carries content-type, if-match, idempotency-key,
 * last-event-id, accept, x-client-id and x-trace-id; returns x-trace-id,
 * retry-after, cache-control, CSP and x-capsule-sha256.
 */
type Ctx = { params: Promise<{ path: string[] }> };
async function handle(req: Request, ctx: Ctx) {
  const { path } = await ctx.params;
  return forwardToApi(req, path.join('/'), new URL(req.url).search);
}
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
