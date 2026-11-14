import { forwardToApi } from '@/lib/auth/bff';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Workspace event stream (SSE), proxied with streaming. Differences from the
 * generic proxy: EventSource cannot set headers, so the stable client id comes
 * as `?clientId=` and is forwarded as `x-client-id`; and when the API refuses
 * the stream (429 TOO_MANY_STREAMS, 401, 404, 5xx) the browser would only see an
 * opaque connection error, so the refusal is delivered as a final
 * `stream_error` frame that carries state, status and retryAfterSeconds.
 */
function streamError(status: number, body: Record<string, unknown>, retryAfter: string | null): Response {
  const payload = JSON.stringify({
    status,
    errorCode: body.errorCode ?? `HTTP_${status}`,
    reasonCode: body.reasonCode ?? null,
    state: body.state ?? null,
    message: body.message ?? 'The event stream could not be opened.',
    retryAfterSeconds: typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds : retryAfter ? Number(retryAfter) : null,
  });
  return new Response(`event: stream_error\ndata: ${payload}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ wid: string }> }) {
  const { wid } = await ctx.params;
  if (!UUID.test(wid)) return Response.json({ errorCode: 'NOT_FOUND', message: 'Not found.' }, { status: 404 });

  // Respond immediately and connect upstream inside the stream: the API sends no bytes (not even
  // headers) until the first event or heartbeat, up to 15 s, and EventSource only fires `open`
  // once bytes arrive. Refusals become a `stream_error` frame instead of an HTTP error.
  const enc = new TextEncoder();
  let cancel: (() => void) | null = null;
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(enc.encode(': connected\n\n'));
      try {
        const r = await forwardToApi(req, `workspaces/${wid}/events`, new URL(req.url).search);
        if (r.status !== 200 || !r.body || !(r.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
          const b = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          const err = streamError(r.status, b, r.headers.get('retry-after'));
          c.enqueue(enc.encode(await err.text()));
          c.close();
          return;
        }
        const reader = r.body.getReader();
        cancel = () => void reader.cancel().catch(() => {});
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          c.enqueue(value);
        }
        c.close();
      } catch {
        try {
          c.close();
        } catch {
          /* already closed by the client going away */
        }
      }
    },
    cancel() {
      cancel?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
