import type { Clock } from "../clock.ts";

export type CircuitState = "closed" | "open" | "half_open";

export interface BreakerSnapshot {
  state: CircuitState;
  openedAtMs: number | null;
  failuresMs: number[];
}

export interface BreakerConfig {
  /** Max auth-failure requests (including the confirmation retry and half-open probes) per window. */
  maxFailuresPerWindow: number;
  windowMs: number;
  /** Minimum time the circuit stays open before a half-open probe is allowed. */
  cooldownMs: number;
}
export const DEFAULT_BREAKER: BreakerConfig = {
  maxFailuresPerWindow: 3,
  windowMs: 120_000,
  cooldownMs: 30_000,
};

/**
 * Circuit breaker for 401/403. At most `maxFailuresPerWindow` auth-failed requests are ever issued per window, so the
 * total number of rejected requests (initial + confirmation retry + probes) stays within the probe cap.
 */
export class AuthCircuitBreaker {
  state: CircuitState = "closed";
  openedAtMs: number | null = null;
  failuresMs: number[] = [];
  readonly transitions: Array<{ at: number; from: CircuitState; to: CircuitState }> = [];
  constructor(
    private readonly clock: Clock,
    readonly cfg: BreakerConfig = DEFAULT_BREAKER,
  ) {}

  private set(to: CircuitState): void {
    if (to !== this.state) this.transitions.push({ at: this.clock.now(), from: this.state, to });
    this.state = to;
  }

  private prune(): void {
    const cutoff = this.clock.now() - this.cfg.windowMs;
    this.failuresMs = this.failuresMs.filter((t) => t > cutoff);
  }

  /** Earliest time a request may be attempted while open; null when closed. */
  nextProbeAtMs(): number | null {
    if (this.state === "closed") return null;
    this.prune();
    const cooldownEnd = (this.openedAtMs ?? 0) + this.cfg.cooldownMs;
    // the failure budget frees up when the oldest in-window failure leaves the window
    const budgetFree =
      this.failuresMs.length < this.cfg.maxFailuresPerWindow
        ? 0
        : (this.failuresMs[this.failuresMs.length - this.cfg.maxFailuresPerWindow] ?? 0) +
          this.cfg.windowMs +
          1;
    return Math.max(cooldownEnd, budgetFree);
  }

  /** True if a request may be issued now. Moves open -> half_open when a probe is permitted. */
  allowRequest(): boolean {
    if (this.state === "closed") return true;
    const at = this.nextProbeAtMs();
    if (at !== null && this.clock.now() >= at) {
      this.set("half_open");
      return true;
    }
    return this.state === "half_open" ? false : false;
  }

  recordAuthFailure(): void {
    this.failuresMs.push(this.clock.now());
    this.prune();
  }

  /** Open the circuit (after the confirmation retry also failed, or a half-open probe failed). */
  open(): void {
    this.openedAtMs = this.clock.now();
    this.set("open");
  }

  recordSuccess(): void {
    if (this.state !== "closed") this.set("closed");
    this.openedAtMs = null;
    this.failuresMs = [];
  }

  snapshot(): BreakerSnapshot {
    return { state: this.state, openedAtMs: this.openedAtMs, failuresMs: [...this.failuresMs] };
  }
  restore(s: BreakerSnapshot | undefined): void {
    if (!s) return;
    this.state = s.state === "half_open" ? "open" : s.state;
    this.openedAtMs = s.openedAtMs;
    this.failuresMs = s.failuresMs;
  }
}
