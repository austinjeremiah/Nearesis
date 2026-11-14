import type { WatermarkEvent } from "@nearesis/contracts";

/** One row of nearesis_live.source_watermarks (the scheduler's per-provider freshness record). */
export interface WatermarkRow {
  providerId: string;
  /** Newest event time the provider has delivered (ISO). Null when the provider has no data. */
  newestEventTime: string | null;
  state: string;
  /** Monotonic: higher is newer. */
  version: number;
}

/** The slice of `DegradationGuard` the feeder uses (apps/api/src/overload). */
export interface FeederDegradation {
  markUnhealthy(sourceId: string): void;
  markHealthy(sourceId: string): void;
  isDegraded(sourceId: string): boolean;
  tryProbe(sourceId: string): boolean;
  recordFinalized(sourceId: string, values: Record<string, number>, watermark: string): void;
}

export interface FeederDeps {
  /**
   * Graceful degradation (ch.13 Backpressure). While a provider is `unavailable`, no watermark of it is published as a
   * current value; after recovery exactly one cautious probe publishes first, and its success restores normal flow.
   * Finalized values are kept as the snapshot to show, with a warning, in the meantime.
   */
  degradation?: FeederDegradation;
  /** Rows with `version > afterVersion`, oldest first. */
  readWatermarks(afterVersion: number): Promise<WatermarkRow[]>;
  /** Registry metric ids fed by this provider. */
  metricIdsFor(providerId: string): string[];
  /**
   * The metric's observed value at the watermark, obtained through the semantic gateway. Returns null when the gateway
   * has no observation (unavailable coverage, null cell, rejected or failed query). It must never fabricate a number.
   */
  metricValue(metricId: string, watermarkIso: string): Promise<number | null>;
  /** Clock seam (tests). */
  now?(): number;
  enqueue(event: WatermarkEvent): Promise<{ enqueued: boolean }>;
  log?(m: string): void;
}

export interface FeederPass {
  rowsRead: number;
  /** (provider, watermark) pairs handed to the scheduler this pass. */
  enqueued: Array<{
    sourceId: string;
    watermark: string;
    maturity: "final" | "provisional";
    values: Record<string, number>;
    missing: string[];
  }>;
  skippedNoWatermark: number;
  failures: number;
  /** Watermarks not published because their provider is degraded (retried once it recovers). */
  blockedDegraded?: number;
}

/**
 * Bridges scheduler watermarks to monitors. Each new `source_watermarks` row with a real newest-event time becomes one
 * `WatermarkEvent` (mode `live`) for `kernel.monitorScheduler().enqueue`, carrying the metric values the gateway reports.
 *
 * - A metric the gateway cannot observe is left OUT of `values` (the monitor evaluates it as unknown), never 0.
 * - A provider without data has no watermark and produces no event.
 * - The scheduler writes a row per task run, many with an unchanged watermark; (provider, watermark) is processed once and
 *   `enqueue` is idempotent per (source, watermark, mode) in Postgres, so restarts and duplicates are harmless.
 * - A failed enqueue does not advance the cursor, so the row is retried on the next pass.
 */
export class MonitorFeeder {
  private cursor = 0;
  private readonly done = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(private readonly d: FeederDeps) {}

  get cursorVersion(): number {
    return this.cursor;
  }

  async pollOnce(): Promise<FeederPass> {
    const pass: FeederPass = {
      rowsRead: 0,
      enqueued: [],
      skippedNoWatermark: 0,
      failures: 0,
      blockedDegraded: 0,
    };
    const deg = this.d.degradation;
    const rows = await this.d.readWatermarks(this.cursor);
    pass.rowsRead = rows.length;
    // Newest row per (provider, watermark) carries the freshest state; older duplicates are dropped.
    const latest = new Map<string, WatermarkRow>();
    for (const r of rows) {
      if (r.newestEventTime === null) {
        pass.skippedNoWatermark++;
        continue;
      }
      latest.set(`${r.providerId}|${r.newestEventTime}`, r);
    }
    let maxSafe = this.cursor;
    let blocked = false;
    for (const r of [...rows].sort((a, b) => a.version - b.version)) {
      const key = r.newestEventTime === null ? null : `${r.providerId}|${r.newestEventTime}`;
      if (deg && r.state === "unavailable") deg.markUnhealthy(r.providerId);
      let probing = false;
      if (
        key !== null &&
        !this.done.has(key) &&
        latest.get(key) === r &&
        !blocked &&
        deg?.isDegraded(r.providerId)
      ) {
        if (r.state === "unavailable" || !deg.tryProbe(r.providerId)) {
          pass.blockedDegraded!++;
          this.d.log?.(`feeder: ${r.providerId} is degraded; watermark ${key} not published as current`);
          if (!blocked) maxSafe = Math.max(maxSafe, r.version);
          continue;
        }
        probing = true;
      }
      if (key !== null && !this.done.has(key) && latest.get(key) === r && !blocked) {
        const watermark = new Date(`${r.newestEventTime!.replace(" ", "T")}Z`).toISOString();
        try {
          // Final only for a fresh provider whose watermark day has already ended; anything newer (a rolling intraday feed,
          // a late provider) is provisional and is ignored by finalized_only rules.
          const today = Math.floor((this.d.now?.() ?? Date.now()) / 86_400_000);
          const maturity =
            r.state === "fresh" && Math.floor(Date.parse(watermark) / 86_400_000) < today
              ? "final"
              : "provisional";
          const values: Record<string, number> = {};
          const missing: string[] = [];
          for (const id of this.d.metricIdsFor(r.providerId)) {
            const v = await this.d.metricValue(id, watermark);
            if (v === null || !Number.isFinite(v)) missing.push(id);
            else values[id] = v;
          }
          await this.d.enqueue({ sourceId: r.providerId, watermark, mode: "live", values, maturity });
          this.done.add(key);
          if (probing) deg!.markHealthy(r.providerId);
          if (maturity === "final") deg?.recordFinalized(r.providerId, values, watermark);
          pass.enqueued.push({ sourceId: r.providerId, watermark, maturity, values, missing });
        } catch (e) {
          pass.failures++;
          if (probing) deg!.markUnhealthy(r.providerId);
          blocked = true;
          this.d.log?.(
            `feeder: ${r.providerId} @ ${watermark} not enqueued (${(e as Error).name}); will retry`,
          );
        }
      }
      if (!blocked) maxSafe = Math.max(maxSafe, r.version);
    }
    this.cursor = maxSafe;
    return pass;
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    const tick = (): void => {
      if (this.busy) return;
      this.busy = true;
      this.pollOnce()
        .catch((e) => this.d.log?.(`feeder poll failed: ${(e as Error).name}`))
        .finally(() => (this.busy = false));
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.busy) await new Promise((r) => setTimeout(r, 20));
  }
}
