import type { BreakerState } from "@nearesis/contracts";

export interface BreakerOptions {
  /** Consecutive failures that open the breaker. Default 3. */
  failureThreshold?: number;
  /** First open interval before a probe is allowed (ms). Default 30000. */
  openMs?: number;
  /** A failed probe doubles the open interval up to this (ms). Default 300000. */
  maxOpenMs?: number;
  now?: () => number;
}

/**
 * Circuit breaker with a single cautious probe (ch.13: "circuit breakers reopen with cautious probes; no infinite
 * retries against 401/403").
 *  - closed: calls pass; `failureThreshold` consecutive failures open it.
 *  - open: calls are refused until the interval passes; then exactly ONE caller becomes the probe (half_open).
 *  - half_open: every other caller is refused while the probe is in flight. Probe success closes the breaker; probe
 *    failure reopens it with a doubled interval.
 *  - an authentication/authorisation failure (401/403) opens it with `requiresIntervention`: no automatic probe ever.
 */
export class CircuitBreaker {
  private st: BreakerState = "closed";
  private failures = 0;
  private openedAt = 0;
  private interval: number;
  private probing = false;
  private fatal = false;
  private since: number | null = null;
  private probes = 0;
  private readonly threshold: number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;

  constructor(o: BreakerOptions = {}) {
    this.threshold = Math.max(1, o.failureThreshold ?? 3);
    this.baseMs = Math.max(1, o.openMs ?? 30_000);
    this.maxMs = Math.max(this.baseMs, o.maxOpenMs ?? 300_000);
    this.interval = this.baseMs;
    this.now = o.now ?? Date.now;
  }

  get state(): BreakerState {
    return this.st;
  }
  /** Epoch ms when the current degraded episode began (breaker first opened), or null while healthy. */
  get degradedSince(): number | null {
    return this.since;
  }
  get requiresIntervention(): boolean {
    return this.fatal;
  }
  get probeCount(): number {
    return this.probes;
  }

  /** May a call go out now? In half_open this returns true at most once until the probe resolves. */
  allow(): boolean {
    if (this.st === "closed") return true;
    if (this.fatal) return false;
    if (this.st === "open" && this.now() - this.openedAt >= this.interval) {
      this.st = "half_open";
      this.probing = true;
      this.probes++;
      return true;
    }
    return false;
  }

  success(): void {
    this.st = "closed";
    this.failures = 0;
    this.probing = false;
    this.fatal = false;
    this.since = null;
    this.interval = this.baseMs;
  }

  failure(httpStatus?: number): void {
    const auth = httpStatus === 401 || httpStatus === 403;
    if (auth) this.fatal = true;
    if (this.st === "half_open") {
      this.interval = Math.min(this.maxMs, this.interval * 2);
      this.open();
      return;
    }
    this.failures++;
    if (auth || this.failures >= this.threshold) this.open();
  }

  private open(): void {
    this.st = "open";
    this.probing = false;
    this.openedAt = this.now();
    this.since ??= this.openedAt;
  }

  /** Open immediately on trusted evidence (the health registry says the source is down): no failure threshold. */
  trip(): void {
    if (this.st === "closed") this.open();
  }

  /** Operator action after fixing credentials. */
  reset(): void {
    this.success();
  }
}
