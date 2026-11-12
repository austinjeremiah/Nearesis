import { createHash } from "node:crypto";
import { OverloadError } from "./errors.ts";

export interface SseLimits {
  /** Open event streams one browser (session + client id) may hold. Default 6, the HTTP/1.1 per-host browser limit. */
  maxPerClient?: number;
  /** Open event streams in this process. Default 2000. */
  maxTotal?: number;
  /** A client whose socket takes longer than this to accept a write is "slow" (coalesced). Default 500. */
  slowAfterMs?: number;
  /** A client whose socket stays blocked longer than this is disconnected (it reconnects with Last-Event-ID). Default 30000. */
  slowDrainTimeoutMs?: number;
  /**
   * Once a client has been seen blocked, any backlog longer than this many events is sent as one coalesced aggregate
   * instead of the individual events. Default 20 (a healthy client uses the stream's own, larger, threshold).
   */
  slowMaxLag?: number;
  /** Unflushed bytes on one connection above which the client is treated as slow. Default 65536. */
  maxBufferedBytes?: number;
}

export interface SseStats {
  open: number;
  peakOpen: number;
  refused: number;
  slowEntered: number;
  slowDropped: number;
  coalescedFrames: number;
  peakBufferedBytes: number;
}

/** Browser identity for the per-browser limit: the session credential plus the optional `x-client-id` header. */
export function sseClientKey(authorization: string | undefined, clientId: unknown): string {
  const cred = createHash("sha256")
    .update(String(authorization ?? ""))
    .digest("hex")
    .slice(0, 16);
  const id = typeof clientId === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(clientId) ? clientId : "-";
  return `${cred}:${id}`;
}

/**
 * Per-browser and per-process caps on event streams (ch.13 Backpressure "per-browser SSE limits") plus the counters the
 * overload tests read. Memory is O(open streams): there is no per-connection queue; a connection buffers at most one
 * journal batch because the stream is cursor-driven and waits for the socket to drain.
 */
export class SseConnectionLimiter {
  readonly maxPerClient: number;
  readonly maxTotal: number;
  readonly slowAfterMs: number;
  readonly slowDrainTimeoutMs: number;
  readonly slowMaxLag: number;
  readonly maxBufferedBytes: number;
  private readonly perClient = new Map<string, number>();
  private readonly s: SseStats = {
    open: 0,
    peakOpen: 0,
    refused: 0,
    slowEntered: 0,
    slowDropped: 0,
    coalescedFrames: 0,
    peakBufferedBytes: 0,
  };

  constructor(o: SseLimits = {}) {
    this.maxPerClient = Math.max(1, o.maxPerClient ?? 6);
    this.maxTotal = Math.max(1, o.maxTotal ?? 2000);
    this.slowDrainTimeoutMs = Math.max(1, o.slowDrainTimeoutMs ?? 30_000);
    this.slowAfterMs = Math.min(this.slowDrainTimeoutMs, Math.max(1, o.slowAfterMs ?? 500));
    this.slowMaxLag = Math.max(1, o.slowMaxLag ?? 20);
    this.maxBufferedBytes = Math.max(1024, o.maxBufferedBytes ?? 65_536);
  }

  /** Reserve a stream. Throws `OverloadError` (429, TOO_MANY_STREAMS) when the browser or the process is at its limit. */
  acquire(clientKey: string): () => void {
    const n = this.perClient.get(clientKey) ?? 0;
    if (n >= this.maxPerClient || this.s.open >= this.maxTotal) {
      this.s.refused++;
      throw new OverloadError(
        "TOO_MANY_STREAMS",
        n >= this.maxPerClient
          ? `This browser already has ${this.maxPerClient} open event streams.`
          : "The service is at its event stream limit.",
        5,
      );
    }
    this.perClient.set(clientKey, n + 1);
    this.s.open++;
    this.s.peakOpen = Math.max(this.s.peakOpen, this.s.open);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const m = (this.perClient.get(clientKey) ?? 1) - 1;
      if (m <= 0) this.perClient.delete(clientKey);
      else this.perClient.set(clientKey, m);
      this.s.open--;
    };
  }

  noteBuffered(bytes: number): void {
    if (bytes > this.s.peakBufferedBytes) this.s.peakBufferedBytes = bytes;
  }
  noteSlow(): void {
    this.s.slowEntered++;
  }
  noteDropped(): void {
    this.s.slowDropped++;
  }
  noteCoalesced(): void {
    this.s.coalescedFrames++;
  }
  stats(): SseStats {
    return { ...this.s };
  }
}
