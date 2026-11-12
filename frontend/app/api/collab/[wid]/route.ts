import { API_URL } from '@/lib/api/config';
import { createApi } from '@/lib/api/client';
import { ApiRequestError } from '@/lib/api/errors';
import { serverTransport } from '@/lib/api/server';
import { sameOrigin } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

type Ticket = { ticket: string; expiresAt: string; ttlSeconds: number; workspaceId: string; scope: string | null; wsPath: string; subprotocol: string };

/**
 * Collaboration socket ticket. The bearer stays on the server: this asks the API for a single-use
 * 30 second ticket and hands the browser only that, plus the socket URL it is valid for.
 * `NEARESIS_WS_URL` overrides the socket origin when the API is behind a different public host.
 */
export async function POST(req: Request, ctx: { params: Promise<{ wid: string }> }) {
  if (!sameOrigin(req)) return Response.json({ errorCode: 'FORBIDDEN', message: 'Origin not allowed.' }, { status: 403 });
  const { wid } = await ctx.params;
  const { scope } = (await req.json().catch(() => ({}))) as { scope?: string };
  try {
    const api = createApi(serverTransport);
    const t = await api.send<Ticket>('POST', `/v1/workspaces/${encodeURIComponent(wid)}/collab/ticket`, scope ? { scope } : {});
    const origin = (process.env.NEARESIS_WS_URL ?? API_URL).replace(/^http/, 'ws').replace(/\/$/, '');
    return Response.json({ ticket: t.ticket, subprotocol: t.subprotocol, expiresAt: t.expiresAt, scope: t.scope, wsUrl: `${origin}${t.wsPath}` }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    if (e instanceof ApiRequestError) return Response.json({ errorCode: e.errorCode, reasonCode: e.reasonCode, message: e.message, state: e.state, retryable: e.retryable }, { status: e.status });
    throw e;
  }
}
