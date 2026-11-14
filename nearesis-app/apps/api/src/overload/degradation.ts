import { KernelError } from "@nearesis/kernel";
import type { FreshnessWarning, SourceServe } from "@nearesis/contracts";
import { CircuitBreaker } from "./breaker.ts";
import type { BreakerOptions } from "./breaker.ts";

export interface LiveRead<T> {
  value: T;
  /** Event-time watermark of the read (ISO). */
  watermark: string;
  /** True when the watermark is final (its period has ended and the provider is fresh). Only final reads become snapshots. */
  finalized: boolean;
}

export interface ServedRead<T> {
  value: T;
  serve: SourceServe;
}

export interface DegradationOptions extends BreakerOptions {
  /** HTTP status of an upstream failure, when the error carries one (401/403 stop automatic probing). */
  statusOf?: (e: unknown) => number | undefined;
  now?: () => number;
}

interface Source<T> {
  breaker: CircuitBreaker;
  snapshot: { value: T; watermark: string } | null;
  /** The latest call failed or the health registry says degraded; cleared by the next successful read. */
  unhealthy: boolean;
}

const unavailable = (sourceId: string, why: string) =>
  new KernelError(
    "UPSTREAM_DEGRADED",
    "SOURCE_UNAVAILABLE_NO_SNAPSHOT",
    `Source ${sourceId} is unavailable (${why}) and no finalized snapshot exists; nothing is shown as current.`,
    { retryable: true, nextAction: "Retry later." },
  );

/**
 * Graceful degradation for one data source family (ch.13 Backpressure). While a source is unhealthy:
 *  - reads are answered with the LAST FINALIZED snapshot plus an explicit freshness warning (never silently stale);
 *  - publication of "current" values is blocked (`assertCanPublishCurrent` throws, `currentPublicationAllowed` is false);
 *  - the breaker lets exactly one cautious probe through after its interval; success restores live reads.
 * With no finalized snapshot nothing is invented: the read fails with UPSTREAM_DEGRADED.
 */
export class DegradationGuard<T = unknown> {
  private readonly sources = new Map<string, Source<T>>();
  private readonly now: () => number;

  constructor(private readonly o: DegradationOptions = {}) {
    this.now = o.now ?? Date.now;
  }

  private src(id: string): Source<T> {
    let s = this.sources.get(id);
    if (!s) {
      s = { breaker: new CircuitBreaker({ ...this.o, now: this.now }), snapshot: null, unhealthy: false };
      this.sources.set(id, s);
    }
    return s;
  }

  breakerOf(id: string): CircuitBreaker {
    return this.src(id).breaker;
  }

  /** Record a finalized read from outside `read` (e.g. the ingestion watermark feed). */
  recordFinalized(id: string, value: T, watermark: string): void {
    this.src(id).snapshot = { value, watermark };
  }

  /** The source is degraded or unavailable by an external signal (health registry): count it like a failed call. */
  markUnhealthy(id: string, httpStatus?: number): void {
    const s = this.src(id);
    s.unhealthy = true;
    if (s.breaker.state === "closed") s.breaker.trip();
    else s.breaker.failure(httpStatus);
  }

  /**
   * Recovery gate for feed-driven sources: true when the source is healthy, or when this caller is the single cautious
   * probe (the breaker's interval has passed and nobody else is probing). Report the probe's outcome with `markHealthy`
   * or `markUnhealthy`.
   */
  tryProbe(id: string): boolean {
    const s = this.src(id);
    if (!s.unhealthy && s.breaker.state === "closed") return true;
    return s.breaker.allow();
  }

  /** The last finalized snapshot with its freshness warning, or null when the source has none. Never fabricates. */
  lastFinalized(id: string): ServedRead<T> | null {
    const s = this.src(id);
    return s.snapshot ? this.stale(id, s, "served on request") : null;
  }

  /** The external health signal cleared: close the breaker without a probe. */
  markHealthy(id: string): void {
    const s = this.src(id);
    s.unhealthy = false;
    s.breaker.success();
  }

  isDegraded(id: string): boolean {
    const s = this.src(id);
    return s.unhealthy || s.breaker.state !== "closed";
  }

  /** Publication of values as "current" is refused while the source is not healthy. */
  assertCanPublishCurrent(id: string): void {
    if (this.isDegraded(id))
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "STALE_PUBLICATION_BLOCKED",
        `Source ${id} is degraded; values cannot be published as current.`,
        {
          retryable: true,
          nextAction:
            "Wait for the source to recover, or publish the last finalized snapshot with its warning.",
        },
      );
  }

  async read(id: string, fetchLive: () => Promise<LiveRead<T>>): Promise<ServedRead<T>> {
    const s = this.src(id);
    if (s.breaker.allow()) {
      try {
        const live = await fetchLive();
        s.breaker.success();
        s.unhealthy = false;
        if (live.finalized) s.snapshot = { value: live.value, watermark: live.watermark };
        return {
          value: live.value,
          serve: {
            sourceId: id,
            servedFrom: "live",
            asOf: live.watermark,
            breaker: s.breaker.state,
            currentPublicationAllowed: true,
          },
        };
      } catch (e) {
        s.unhealthy = true;
        s.breaker.failure(this.o.statusOf?.(e));
        // fall through to the snapshot
        return this.stale(id, s, (e as Error).name);
      }
    }
    return this.stale(id, s, "breaker open");
  }

  private stale(id: string, s: Source<T>, why: string): ServedRead<T> {
    if (!s.snapshot) throw unavailable(id, why);
    const t = this.now();
    const warning: FreshnessWarning = {
      code: s.breaker.state === "closed" ? "SOURCE_DEGRADED" : "BREAKER_OPEN",
      message: `Source ${id} is degraded; showing the last finalized snapshot, not current values.`,
      asOf: s.snapshot.watermark,
      staleSeconds: Math.max(0, (t - Date.parse(s.snapshot.watermark)) / 1000),
      degradedSince: new Date(s.breaker.degradedSince ?? t).toISOString(),
    };
    return {
      value: s.snapshot.value,
      serve: {
        sourceId: id,
        servedFrom: "last_finalized_snapshot",
        asOf: s.snapshot.watermark,
        breaker: s.breaker.state,
        currentPublicationAllowed: false,
        warning,
      },
    };
  }
}
