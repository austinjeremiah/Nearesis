import { describe, it, expect } from 'vitest';
import { WorkspaceStream, type EventSourceLike, type MessageEventLike, type StreamStatus } from '@/lib/sse/stream';

class FakeES implements EventSourceLike {
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  listeners = new Map<string, ((m: MessageEventLike) => void)[]>();
  constructor(public url: string) {}
  addEventListener(t: string, l: (m: MessageEventLike) => void) {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), l]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown, id?: number) {
    for (const l of this.listeners.get(type) ?? []) l({ data: JSON.stringify(data), lastEventId: id === undefined ? undefined : String(id) });
  }
}

function harness(initialCursor: number | null = 5) {
  const sources: FakeES[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const events: { event: string; seq: number }[] = [];
  const coalesced: unknown[] = [];
  const reloads: unknown[] = [];
  const statuses: StreamStatus[] = [];
  const cursors: number[] = [];
  let sessionOk = true;
  const stream = new WorkspaceStream({
    workspaceId: 'w',
    initialCursor,
    buildUrl: (c) => `/api/events/w?cursor=${c}`,
    createEventSource: (u) => {
      const es = new FakeES(u);
      sources.push(es);
      return es;
    },
    random: () => 0.5,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
    onEvent: (e) => events.push({ event: e.event, seq: e.seq }),
    onCoalesced: (d) => coalesced.push(d),
    onReload: (d) => reloads.push(d),
    onStatus: (s) => statuses.push(s),
    onCursor: (s) => cursors.push(s),
    checkSession: async () => sessionOk,
  });
  return { stream, sources, timers, events, coalesced, reloads, statuses, cursors, setSession: (v: boolean) => (sessionOk = v) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('WorkspaceStream', () => {
  it('connects with the stored cursor and goes open', () => {
    const h = harness(5);
    h.stream.start();
    expect(h.sources[0].url).toBe('/api/events/w?cursor=5');
    h.sources[0].onopen?.({});
    expect(h.stream.status).toBe('open');
  });

  it('delivers typed events and dedupes by seq', () => {
    const h = harness(5);
    h.stream.start();
    const es = h.sources[0];
    es.emit('panel.updated', { seq: 6 }, 6);
    es.emit('panel.updated', { seq: 6 }, 6); // replay
    es.emit('run.state_changed', { seq: 5 }, 5); // older than cursor
    es.emit('run.state_changed', { seq: 7 }, 7);
    expect(h.events).toEqual([{ event: 'panel.updated', seq: 6 }, { event: 'run.state_changed', seq: 7 }]);
    expect(h.stream.lastSeq).toBe(7);
  });

  it('probes the head on first connect and does not report a reload', () => {
    const h = harness(null);
    h.stream.start();
    expect(h.sources[0].url).toContain('cursor=2147483647');
    h.sources[0].emit('reload_required', { reason: 'CURSOR_EXPIRED', currentSeq: 68, workspaceVersion: 3 }, 68);
    expect(h.reloads).toHaveLength(0);
    expect(h.sources[0].closed).toBe(true);
    expect(h.sources[1].url).toBe('/api/events/w?cursor=68');
    expect(h.stream.lastSeq).toBe(68);
  });

  it('reports a real reload_required, jumps to currentSeq and reconnects', () => {
    const h = harness(5);
    h.stream.start();
    h.sources[0].emit('reload_required', { reason: 'INVALID_CURSOR', currentSeq: 90, workspaceVersion: null }, 90);
    expect(h.reloads).toEqual([{ reason: 'INVALID_CURSOR', currentSeq: 90 }]);
    expect(h.sources[1].url).toBe('/api/events/w?cursor=90');
  });

  it('handles coalesced: advances the cursor to toSeq and surfaces byType', () => {
    const h = harness(5);
    h.stream.start();
    h.sources[0].emit('coalesced', { fromSeq: 6, toSeq: 200, count: 195, byType: { 'panel.updated': 195 }, workspaceVersion: 1 }, 200);
    expect(h.coalesced).toHaveLength(1);
    expect(h.stream.lastSeq).toBe(200);
    h.sources[0].emit('panel.updated', { seq: 150 }, 150); // inside the coalesced range
    expect(h.events).toHaveLength(0);
  });

  it('reconnects with backoff and a fresh cursor after a transport error', () => {
    const h = harness(5);
    h.stream.start();
    h.sources[0].emit('panel.updated', { seq: 9 }, 9);
    h.sources[0].onerror?.({});
    expect(h.stream.status).toBe('reconnecting');
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBeGreaterThanOrEqual(250);
    expect(h.timers[0].ms).toBeLessThanOrEqual(1500);
    h.timers[0].fn();
    expect(h.sources[1].url).toBe('/api/events/w?cursor=9');
    // consecutive failures grow the ceiling
    h.sources[1].onerror?.({});
    h.sources[1].onerror?.({}); // stale source ignored
    expect(h.timers).toHaveLength(2);
    expect(h.timers[1].ms).toBeGreaterThan(h.timers[0].ms);
  });

  it('honours retryAfterSeconds from a refused stream (429)', async () => {
    const h = harness(5);
    h.stream.start();
    h.sources[0].emit('stream_error', { status: 429, errorCode: 'RATE_LIMITED', retryAfterSeconds: 20 });
    await tick();
    expect(h.timers[0].ms).toBeGreaterThanOrEqual(20000);
  });

  it('stops for good on 404', async () => {
    const h = harness(5);
    h.stream.start();
    h.sources[0].emit('stream_error', { status: 404, errorCode: 'NOT_FOUND' });
    await tick();
    expect(h.stream.status).toBe('failed');
    expect(h.timers).toHaveLength(0);
  });

  it('on session_expired resumes with lastSeq when the session is still valid', async () => {
    const h = harness(5);
    h.stream.start();
    h.sources[0].emit('panel.updated', { seq: 8 }, 8);
    h.sources[0].emit('session_expired', { reason: 'TOKEN_EXPIRED', nextAction: 'x', lastSeq: 8 });
    await tick();
    expect(h.timers).toHaveLength(1);
    h.timers[0].fn();
    expect(h.sources[1].url).toBe('/api/events/w?cursor=8');
  });

  it('on session_expired with a dead session fails and does not reconnect', async () => {
    const h = harness(5);
    h.setSession(false);
    h.stream.start();
    h.sources[0].emit('session_expired', { reason: 'SESSION_REVOKED', nextAction: 'x', lastSeq: 5 });
    await tick();
    expect(h.stream.status).toBe('failed');
    expect(h.timers).toHaveLength(0);
  });

  it('stop() closes the source and prevents reconnects', () => {
    const h = harness(5);
    h.stream.start();
    h.sources[0].onerror?.({});
    h.stream.stop();
    h.timers[0].fn();
    expect(h.sources).toHaveLength(1);
    expect(h.stream.status).toBe('closed');
  });
});
