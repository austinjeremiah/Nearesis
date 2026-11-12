/**
 * Virtual clock for long mock-time runs. Time advances only when every registered actor is blocked in `sleep`, so real
 * I/O (Redis, Postgres) in flight is never overtaken: a 10-minute scenario runs in seconds with exact ordering.
 */
import type { Clock } from "../../services/ingestion/src/clock.ts";

export class VirtualClock implements Clock {
  private t: number;
  private timers: Array<{ at: number; resolve: () => void }> = [];
  private actors = 0;
  private blocked = 0;
  constructor(startMs: number) {
    this.t = startMs;
  }
  now(): number {
    return this.t;
  }
  sleep(ms: number): Promise<void> {
    if (!(ms > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      this.blocked++;
      this.timers.push({ at: this.t + ms, resolve });
    });
  }
  /** Registers an actor for the duration of `fn`. */
  async actor<T>(fn: () => Promise<T>): Promise<T> {
    this.actors++;
    try {
      return await fn();
    } finally {
      this.actors--;
    }
  }
  /** Drives time until `done()`; call after the actors were started (not awaited). */
  async drive(done: () => boolean): Promise<void> {
    while (!done()) {
      if (this.actors > 0 && this.blocked >= this.actors && this.timers.length) {
        this.timers.sort((a, b) => a.at - b.at);
        const at = this.timers[0]!.at;
        this.t = Math.max(this.t, at);
        while (this.timers.length && this.timers[0]!.at <= this.t) {
          this.blocked--;
          this.timers.shift()!.resolve();
        }
      } else await new Promise((r) => setTimeout(r, 1));
    }
  }
}
