import type { SseEventName } from '@/lib/contracts/generated';
import { SSE_EVENT_NAMES } from '@/lib/contracts/generated';

/**
 * One workspace event stream (docs/api/SSE.md), transport-agnostic so it can be
 * unit-tested with a fake EventSource.
 *
 * Behaviour:
 *  - resume: always reconnects with `?cursor=<last applied seq>`; dedupes by seq
 *    (a frame with seq <= lastSeq is dropped).
 *  - first connect with no stored cursor probes the head: a cursor beyond the head
 *    yields `reload_required{currentSeq}`, which becomes the starting cursor, so the
 *    client does not replay the whole retained journal.
 *  - `coalesced` (slow consumer) advances the cursor to toSeq and is surfaced so
 *    the caller can refetch what `byType` names.
 *  - `reload_required` and `session_expired` end the server stream; both are handled
 *    manually (the browser would not retry them).
 *  - `stream_error` is the BFF's way of reporting a refused stream (429, 401, 404, 5xx):
 *    Retry-After is honoured, 401/403 asks the session check, 404 stops for good.
 *  - transport errors back off exponentially with full jitter (1 s .. 30 s).
 */

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed';

export interface EventSourceLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  addEventListener(type: string, listener: (ev: MessageEventLike) => void): void;
  close(): void;
}
export type MessageEventLike = { data: string; lastEventId?: string };

export type DomainEvent = { event: SseEventName; seq: number; data: Record<string, unknown> };

export type StreamHandlers = {
  onStatus?: (s: StreamStatus, detail?: { reason?: string; retryInMs?: number }) => void;
  onEvent?: (e: DomainEvent) => void;
  onCoalesced?: (d: { fromSeq: number; toSeq: number; count: number; byType: Record<string, number> }) => void;
  /** Cursor was invalid/expired and the stream ended; state must be reloaded. Not called for the head probe. */
  onReload?: (d: { reason: string; currentSeq: number }) => void;
  /** Return true if the session is still valid (then the stream resumes), false to stop. */
  checkSession?: () => Promise<boolean>;
  onCursor?: (seq: number) => void;
};

export type StreamOptions = {
  workspaceId: string;
  buildUrl: (cursor: number) => string;
  createEventSource: (url: string) => EventSourceLike;
  initialCursor?: number | null;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
} & StreamHandlers;

const HEAD_PROBE = 2147483647;
const CLOSED = 2;

export class WorkspaceStream {
  private es: EventSourceLike | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private stopped = true;
  private probing = false;
  private _lastSeq: number;
  private _status: StreamStatus = 'idle';
  private readonly o: Required<Pick<StreamOptions, 'random' | 'setTimer' | 'clearTimer' | 'baseDelayMs' | 'maxDelayMs'>> & StreamOptions;

  constructor(opts: StreamOptions) {
    this.o = {
      random: Math.random,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      ...opts,
    };
    this._lastSeq = opts.initialCursor ?? 0;
    this.probing = opts.initialCursor == null;
  }

  get lastSeq() {
    return this._lastSeq;
  }
  get status() {
    return this._status;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer != null) this.o.clearTimer(this.timer);
    this.timer = null;
    this.closeEs();
    this.setStatus('closed');
  }

  /** Delay for the nth consecutive failure: full jitter over min(max, base * 2^n). */
  backoffMs(attempt: number): number {
    const cap = Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** attempt);
    return Math.floor(this.o.random() * cap) + Math.min(250, cap);
  }

  private setStatus(s: StreamStatus, detail?: { reason?: string; retryInMs?: number }) {
    this._status = s;
    this.o.onStatus?.(s, detail);
  }

  private closeEs() {
    if (this.es) {
      this.es.onopen = null;
      this.es.onerror = null;
      this.es.close();
    }
    this.es = null;
  }

  private connect() {
    if (this.stopped) return;
    this.closeEs();
    this.setStatus(this.attempt > 0 ? 'reconnecting' : 'connecting');
    const cursor = this.probing ? HEAD_PROBE : this._lastSeq;
    const es = this.o.createEventSource(this.o.buildUrl(cursor));
    this.es = es;
    es.onopen = () => {
      if (this.es !== es) return;
      this.attempt = 0;
      this.setStatus('open');
    };
    es.onerror = () => {
      if (this.es !== es) return;
      // Manual reconnect with a fresh cursor instead of the browser's own retry.
      this.closeEs();
      this.retryLater('transport error');
    };
    for (const name of SSE_EVENT_NAMES) {
      if (name === 'coalesced' || name === 'reload_required' || name === 'session_expired') continue;
      es.addEventListener(name, (m) => this.onDomain(es, name, m));
    }
    es.addEventListener('coalesced', (m) => this.onCoalesced(es, m));
    es.addEventListener('reload_required', (m) => this.onReload(es, m));
    es.addEventListener('session_expired', (m) => this.onExpired(es, m));
    es.addEventListener('stream_error', (m) => this.onStreamError(es, m));
  }

  private parse(m: MessageEventLike): Record<string, unknown> | null {
    try {
      const v = JSON.parse(m.data);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private advance(seq: number) {
    if (seq > this._lastSeq) {
      this._lastSeq = seq;
      this.o.onCursor?.(seq);
    }
  }

  private onDomain(es: EventSourceLike, name: SseEventName, m: MessageEventLike) {
    if (this.es !== es) return;
    const data = this.parse(m);
    if (!data) return;
    const seq = Number(m.lastEventId ?? data.seq);
    if (!Number.isFinite(seq)) return;
    if (seq <= this._lastSeq) return; // dedupe replayed frames
    this.advance(seq);
    this.o.onEvent?.({ event: name, seq, data });
  }

  private onCoalesced(es: EventSourceLike, m: MessageEventLike) {
    if (this.es !== es) return;
    const d = this.parse(m);
    if (!d) return;
    const toSeq = Number(d.toSeq);
    if (Number.isFinite(toSeq)) this.advance(toSeq);
    this.o.onCoalesced?.({
      fromSeq: Number(d.fromSeq),
      toSeq,
      count: Number(d.count),
      byType: (d.byType as Record<string, number>) ?? {},
    });
  }

  private onReload(es: EventSourceLike, m: MessageEventLike) {
    if (this.es !== es) return;
    const d = this.parse(m);
    this.closeEs();
    const currentSeq = Number(d?.currentSeq);
    if (Number.isFinite(currentSeq)) {
      // Jump to the head. After the probe there is nothing to reload; otherwise the caller must refetch.
      this._lastSeq = currentSeq;
      this.o.onCursor?.(currentSeq);
    }
    const wasProbe = this.probing;
    this.probing = false;
    if (!wasProbe) this.o.onReload?.({ reason: String(d?.reason ?? 'INVALID_CURSOR'), currentSeq });
    this.attempt = 0;
    this.connect();
  }

  private async onExpired(es: EventSourceLike, m: MessageEventLike) {
    if (this.es !== es) return;
    const d = this.parse(m);
    this.closeEs();
    if (typeof d?.lastSeq === 'number') this.advance(d.lastSeq);
    await this.afterAuthLoss(String(d?.reason ?? 'TOKEN_EXPIRED'));
  }

  private async afterAuthLoss(reason: string) {
    const ok = this.o.checkSession ? await this.o.checkSession().catch(() => false) : false;
    if (this.stopped) return;
    if (!ok) {
      this.setStatus('failed', { reason });
      return;
    }
    this.retryLater(reason);
  }

  private async onStreamError(es: EventSourceLike, m: MessageEventLike) {
    if (this.es !== es) return;
    const d = this.parse(m) ?? {};
    this.closeEs();
    const status = Number(d.status);
    if (status === 404) {
      this.setStatus('failed', { reason: 'not_found' });
      return;
    }
    if (status === 401 || status === 403) {
      await this.afterAuthLoss('permission_denied');
      return;
    }
    const retryAfter = typeof d.retryAfterSeconds === 'number' ? d.retryAfterSeconds * 1000 : 0;
    this.retryLater(String(d.errorCode ?? 'stream_error'), retryAfter);
  }

  private retryLater(reason: string, minMs = 0) {
    if (this.stopped) return;
    const delay = Math.max(minMs, this.backoffMs(this.attempt));
    this.attempt += 1;
    this.setStatus('reconnecting', { reason, retryInMs: delay });
    if (this.timer != null) this.o.clearTimer(this.timer);
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }
}

export { CLOSED as EVENT_SOURCE_CLOSED };
