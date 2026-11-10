/**
 * Client event store for the workspace SSE stream (C15, ch.11 "SSE and cursor replay").
 * - Applies events strictly in `seq` order exactly once; duplicates (same eventId or seq <= lastSeq) are ignored.
 * - Out-of-order arrivals wait in a bounded reorder buffer; overflow or a `reload_required` frame triggers a reload.
 * - Delivery to the UI is coalesced in a window (default 250 ms) so bursts cause one render, not one per event.
 */
import type { DomainEvent } from "@nearesis/contracts";

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/** Incremental SSE parser (text/event-stream framing). */
export class SseParser {
  private buf = "";
  push(chunk: string): SseFrame[] {
    this.buf += chunk;
    const frames: SseFrame[] = [];
    let idx: number;
    while ((idx = this.buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx).replace(/^\r?\n\r?\n/, "");
      const f: SseFrame = { data: "" };
      const data: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        const c = line.indexOf(":");
        const k = c < 0 ? line : line.slice(0, c);
        const v = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
        if (k === "id") f.id = v;
        else if (k === "event") f.event = v;
        else if (k === "data") data.push(v);
      }
      f.data = data.join("\n");
      if (f.data || f.event) frames.push(f);
    }
    return frames;
  }
}

export interface EventStoreOptions {
  coalesceMs?: number;
  maxPending?: number;
  onBatch: (events: DomainEvent[]) => void;
  onReloadRequired: (info: { currentRevision: number | null; reason: string }) => void;
  schedule?: (fn: () => void, ms: number) => unknown;
}

export class EventStore {
  lastSeq = 0;
  readonly appliedIds = new Set<string>();
  readonly appliedSeqs: number[] = [];
  duplicatesIgnored = 0;
  maxPendingObserved = 0;
  private pending = new Map<number, DomainEvent>();
  private outbox: DomainEvent[] = [];
  private timer: unknown = null;
  private readonly opts: Required<Omit<EventStoreOptions, "schedule">> & Pick<EventStoreOptions, "schedule">;

  constructor(opts: EventStoreOptions) {
    this.opts = { coalesceMs: 250, maxPending: 1000, ...opts };
  }

  /** Cursor for reconnects (`Last-Event-ID`). */
  get lastEventId(): string {
    return String(this.lastSeq);
  }

  reset(toSeq: number): void {
    this.lastSeq = toSeq;
    this.pending.clear();
    this.outbox = [];
  }

  handleFrame(f: SseFrame): void {
    if (f.event === "reload_required") {
      let info: { currentRevision: number | null; reason: string } = {
        currentRevision: null,
        reason: "retention_expired",
      };
      try {
        const d = JSON.parse(f.data) as { currentRevision?: number; reason?: string };
        info = { currentRevision: d.currentRevision ?? null, reason: d.reason ?? info.reason };
      } catch {
        /* keep defaults */
      }
      this.flush();
      this.opts.onReloadRequired(info);
      return;
    }
    if (!f.data) return;
    let ev: DomainEvent;
    try {
      ev = JSON.parse(f.data) as DomainEvent;
    } catch {
      return; // malformed frames are dropped, never applied
    }
    this.receive(ev);
  }

  receive(ev: DomainEvent): void {
    if (this.appliedIds.has(ev.eventId) || ev.seq <= this.lastSeq || this.pending.has(ev.seq)) {
      this.duplicatesIgnored += 1;
      return;
    }
    this.pending.set(ev.seq, ev);
    this.maxPendingObserved = Math.max(this.maxPendingObserved, this.pending.size);
    if (this.pending.size > this.opts.maxPending) {
      this.pending.clear();
      this.opts.onReloadRequired({ currentRevision: null, reason: "client_buffer_overflow" });
      return;
    }
    while (this.pending.has(this.lastSeq + 1)) {
      const next = this.pending.get(this.lastSeq + 1)!;
      this.pending.delete(next.seq);
      this.lastSeq = next.seq;
      this.appliedIds.add(next.eventId);
      this.appliedSeqs.push(next.seq);
      this.outbox.push(next);
    }
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.timer !== null || !this.outbox.length) return;
    const sched = this.opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = sched(() => {
      this.timer = null;
      this.flush();
    }, this.opts.coalesceMs);
  }

  flush(): void {
    if (!this.outbox.length) return;
    const batch = this.outbox;
    this.outbox = [];
    this.opts.onBatch(batch);
  }
}

/** Connects to `GET <url>` as an SSE stream with Last-Event-ID resume. Returns a disposer. */
export function connectSse(
  url: string,
  store: EventStore,
  init: { headers?: Record<string, string> } = {},
): () => void {
  const ctrl = new AbortController();
  let stopped = false;
  const run = async (attempt: number): Promise<void> => {
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream", "Last-Event-ID": store.lastEventId, ...(init.headers ?? {}) },
        signal: ctrl.signal,
        credentials: "same-origin",
      });
      if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
      const parser = new SseParser();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const f of parser.push(value)) store.handleFrame(f);
      }
      attempt = 0;
    } catch {
      if (stopped) return;
    }
    if (!stopped) setTimeout(() => void run(attempt + 1), Math.min(10_000, 500 * 2 ** attempt));
  };
  void run(0);
  return () => {
    stopped = true;
    ctrl.abort();
  };
}
