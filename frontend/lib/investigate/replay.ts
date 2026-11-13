/**
 * One-shot read of a workspace's recorded event stream (cursor 0) for the `query.completed` frames of one run.
 *
 * The live stream folds a burst of events into a single `coalesced` frame, so a run view that only listens live can
 * miss panels that were in fact added (the canvas holds them, the run page showed none). The API's event log is the
 * durable record, so this reads it from the start on a short-lived connection (its own client id, so the page's
 * live stream is untouched) and stops once it goes quiet.
 */
export type ReplayedPanel = { panelId: string; status: string; index: number; total: number; reasonCode?: string };

export async function replayRunPanels(wid: string, runId: string, signal?: AbortSignal): Promise<ReplayedPanel[]> {
  const ctl = new AbortController();
  signal?.addEventListener('abort', () => ctl.abort());
  const cid = `replay-${Math.random().toString(36).slice(2, 10)}`;
  const out = new Map<string, ReplayedPanel>();
  const hard = setTimeout(() => ctl.abort(), 6000);
  let idle: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await fetch(`/api/events/${encodeURIComponent(wid)}?cursor=0&clientId=${cid}`, { signal: ctl.signal, credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok || !r.body) return [];
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const bump = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => ctl.abort(), 800);
    };
    bump();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!/^event: query\.completed$/m.test(frame)) continue;
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const env = JSON.parse(line.slice(6)) as { data?: Record<string, unknown> };
          const d = env.data ?? {};
          if (d.runId === runId && typeof d.panelId === 'string' && typeof d.status === 'string')
            out.set(d.panelId, { panelId: d.panelId, status: d.status, index: Number(d.index ?? 0), total: Number(d.total ?? 0), reasonCode: typeof d.reasonCode === 'string' ? d.reasonCode : undefined });
        } catch {
          /* a malformed frame is skipped */
        }
      }
    }
  } catch {
    /* aborted on idle or deadline: what was read is the answer */
  } finally {
    clearTimeout(hard);
    if (idle) clearTimeout(idle);
  }
  return [...out.values()];
}
