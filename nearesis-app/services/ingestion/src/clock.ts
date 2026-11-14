/** Injectable clock so rate limiting, backoff and circuit breakers can be tested with simulated time. */
export interface Clock {
  now(): number; // epoch ms
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Deterministic clock: sleep advances time instantly. */
export class FakeClock implements Clock {
  constructor(private t: number = Date.parse("2026-11-10T12:00:00Z")) {}
  now(): number {
    return this.t;
  }
  sleep(ms: number): Promise<void> {
    this.t += Math.max(0, ms);
    return Promise.resolve();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
