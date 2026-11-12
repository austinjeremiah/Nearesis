import type { Clock } from "../clock.ts";
import type { BlockAggregate } from "./aggregate.ts";
import type { BlockSource } from "./neardata.ts";
import type { MinuteRow, RtStore, StoredBlockMeta, WatermarkRow } from "./store.ts";

export class FeedIntegrityError extends Error {
  constructor(
    readonly kind: "GAP" | "REORG_PARENT_MISMATCH" | "NON_MONOTONIC" | "HEIGHT_MISMATCH",
    msg: string,
  ) {
    super(msg);
  }
}

export interface FeedOptions {
  maxNullRetries?: number;
  nullRetryMs?: number;
  pollMs?: number;
  watermarkEveryMs?: number;
  openMinuteEveryMs?: number;
  /** Blocks fetched concurrently ahead of the cursor (only heights already known to be final). */
  prefetch?: number;
}
export type StepResult = "ingested" | "caught_up" | "skipped" | "retry";

/**
 * Forward-only follower of `final` blocks. The resume point is derived from the stored blocks themselves (max height), so a
 * restart can neither skip a range nor double-write: replays hit the (height) dedupe key and the state machine returns `noop`.
 * Every block must chain to the stored parent (prev_height/prev_hash); a break stops the feed (the supervisor restarts it and
 * it re-fetches from the stored tip) instead of silently continuing past a gap.
 */
export class RealtimeFeed {
  private cursor: number | null = null;
  private last: StoredBlockMeta | null = null;
  private firstHeight = 0;
  private firstTsMs = 0;
  private skipped = 0;
  private curMinute: number | null = null;
  private head = 0;
  private headAtMs = 0;
  private lastWmAtMs = 0;
  private lastOpenAtMs = 0;
  private nullTries = new Map<number, number>();
  private ahead = new Map<number, Promise<{ ok: BlockAggregate | null } | { err: unknown }>>();
  blocksIngested = 0;
  private waitMs = 0;
  private storeMs = 0;
  stopped = false;
  private readonly o: Required<FeedOptions>;

  constructor(
    private readonly source: BlockSource,
    private readonly store: RtStore,
    private readonly clock: Clock,
    private readonly log: (m: string) => void = () => undefined,
    private readonly onMinute: (m: MinuteRow) => Promise<void> = async () => undefined,
    opts: FeedOptions = {},
  ) {
    this.o = {
      maxNullRetries: opts.maxNullRetries ?? 3,
      nullRetryMs: opts.nullRetryMs ?? 1500,
      pollMs: opts.pollMs ?? 300,
      watermarkEveryMs: opts.watermarkEveryMs ?? 5000,
      openMinuteEveryMs: opts.openMinuteEveryMs ?? 15_000,
      prefetch: opts.prefetch ?? 1,
    };
  }

  private async refreshHead(force = false, maxAgeMs = 20_000): Promise<number> {
    if (force || this.clock.now() - this.headAtMs > maxAgeMs) {
      this.head = await this.source.lastFinalHeight();
      this.headAtMs = this.clock.now();
    }
    return this.head;
  }

  private async init(): Promise<void> {
    this.last = await this.store.lastBlock();
    await this.refreshHead(true);
    const wm = await this.store.getWatermark();
    if (this.last) {
      this.cursor = this.last.height;
      this.firstHeight = wm?.firstHeight ?? this.last.height;
      this.firstTsMs = wm?.firstBlockTsMs ?? this.last.blockTsMs;
      this.skipped = wm?.skippedHeights ?? 0;
      this.curMinute = Math.floor(this.last.blockTsMs / 60_000) * 60_000;
      this.log(`resume from stored tip ${this.last.height} (${new Date(this.last.blockTsMs).toISOString()})`);
    } else {
      const head = this.head;
      this.cursor = head - 1; // forward-only: start at the current final head, no historical fetch
      this.log(`fresh start at final head ${head}`);
    }
  }

  /** Minute rollups run off the ingest path (serialised, idempotent recomputation from stored blocks); errors are logged, never fatal. */
  private bg: Promise<void> = Promise.resolve();
  private scheduleMinute(minuteMs: number, closed: boolean): void {
    this.bg = this.bg
      .then(() => this.closeMinute(minuteMs, closed))
      .catch((e: unknown) =>
        this.log(`minute ${new Date(minuteMs).toISOString()} rollup failed: ${(e as Error).message}`),
      );
  }

  private async closeMinute(minuteMs: number, closed: boolean): Promise<void> {
    const row = await this.store.materializeMinute(minuteMs, closed, this.firstTsMs, this.clock.now());
    if (row && closed) await this.onMinute(row);
  }

  /** Fetches h (and up to `prefetch - 1` heights after it that are already final) concurrently; results are consumed strictly in order. */
  private async fetchHeight(h: number): Promise<BlockAggregate | null> {
    // near the tip the head must be fresh (one cheap poll per second) or the prefetch window collapses to a single block
    if (this.head - h < this.o.prefetch) await this.refreshHead(false, 900);
    for (let k = 0; k < this.o.prefetch; k++) {
      const x = h + k;
      if (k > 0 && x > this.head) break;
      if (!this.ahead.has(x))
        this.ahead.set(
          x,
          this.source.getBlock(x).then(
            (ok) => ({ ok }),
            (err: unknown) => ({ err }),
          ),
        );
    }
    const r = await (this.ahead.get(h) as Promise<{ ok: BlockAggregate | null } | { err: unknown }>);
    this.ahead.delete(h);
    if ("err" in r) throw r.err;
    return r.ok;
  }

  async step(): Promise<StepResult> {
    if (this.cursor === null) await this.init();
    const h = (this.cursor as number) + 1;
    const observedAt = this.clock.now();
    const tFetch = Date.now();
    const agg = await this.fetchHeight(h);
    this.waitMs += Date.now() - tFetch;
    await this.refreshHead(); // cached 20 s; keeps the prefetch window and the lag/head figures current
    if (agg === null) {
      const head = await this.refreshHead(true);
      if (h > head) return "caught_up";
      const tries = (this.nullTries.get(h) ?? 0) + 1;
      this.nullTries.set(h, tries);
      if (tries < this.o.maxNullRetries) {
        await this.clock.sleep(this.o.nullRetryMs);
        return "retry";
      }
      // below the final head and absent after retries: a skipped height; the next block's prev_height chain confirms it
      this.nullTries.delete(h);
      this.skipped++;
      this.cursor = h;
      return "skipped";
    }
    if (agg.height !== h)
      throw new FeedIntegrityError("HEIGHT_MISMATCH", `asked for ${h}, got ${agg.height}`);
    const last = this.last;
    if (last) {
      if (agg.prevHeight > last.height) {
        await this.store.anomaly(
          "GAP",
          h,
          `prev_height ${agg.prevHeight} > stored tip ${last.height}`,
          this.clock.now(),
        );
        throw new FeedIntegrityError(
          "GAP",
          `gap after ${last.height}: block ${h} has prev_height ${agg.prevHeight}`,
        );
      }
      if (agg.prevHeight < last.height) {
        await this.store.anomaly(
          "NON_MONOTONIC",
          h,
          `prev_height ${agg.prevHeight} < tip ${last.height}`,
          this.clock.now(),
        );
        throw new FeedIntegrityError("NON_MONOTONIC", `block ${h} does not extend stored tip ${last.height}`);
      }
      if (agg.prevHash !== last.blockHash) {
        await this.store.anomaly(
          "REORG_PARENT_MISMATCH",
          h,
          `parent ${agg.prevHash} != stored ${last.blockHash}`,
          this.clock.now(),
        );
        throw new FeedIntegrityError(
          "REORG_PARENT_MISMATCH",
          `block ${h} parent hash differs from stored final ${last.height}`,
        );
      }
    }
    const ingestedAt = this.clock.now();
    const tStore = Date.now();
    await this.store.putBlock(agg, observedAt, ingestedAt, true);
    this.storeMs += Date.now() - tStore;
    this.blocksIngested++;
    if (this.blocksIngested % 60 === 0) {
      this.log(
        `progress: ${this.blocksIngested} blocks, tip ${h}, head ${this.head}, lag ${((ingestedAt - agg.blockTsMs) / 1000).toFixed(1)}s, fetch-wait ${this.waitMs}ms, store ${this.storeMs}ms`,
      );
      this.waitMs = 0;
      this.storeMs = 0;
    }
    if (!last) {
      this.firstHeight = h;
      this.firstTsMs = agg.blockTsMs;
    }
    this.last = { height: h, blockHash: agg.blockHash, state: "final", blockTsMs: agg.blockTsMs };
    this.cursor = h;
    this.nullTries.delete(h);
    const minute = Math.floor(agg.blockTsMs / 60_000) * 60_000;
    if (this.curMinute !== null && minute > this.curMinute) {
      this.scheduleMinute(this.curMinute, true);
      this.lastOpenAtMs = ingestedAt;
    }
    this.curMinute = minute;
    if (ingestedAt - this.lastOpenAtMs >= this.o.openMinuteEveryMs) {
      this.scheduleMinute(minute, false);
      this.lastOpenAtMs = ingestedAt;
    }
    if (ingestedAt - this.lastWmAtMs >= this.o.watermarkEveryMs)
      await this.writeWatermark(observedAt, ingestedAt);
    return "ingested";
  }

  async writeWatermark(observedAt: number, ingestedAt: number): Promise<void> {
    if (!this.last) return;
    const head = this.head || this.last.height;
    const lag = Math.max(0, (ingestedAt - this.last.blockTsMs) / 1000);
    const w: WatermarkRow = {
      height: this.last.height,
      blockHash: this.last.blockHash,
      blockTsMs: this.last.blockTsMs,
      headHeight: head,
      observedAtMs: observedAt,
      ingestedAtMs: ingestedAt,
      lagSeconds: lag,
      firstHeight: this.firstHeight,
      firstBlockTsMs: this.firstTsMs,
      skippedHeights: this.skipped,
      state: head - this.last.height > 20 ? "catching_up" : lag > 60 ? "stalled" : "live",
    };
    await this.store.putWatermark(w, ingestedAt);
    this.lastWmAtMs = ingestedAt;
  }

  /** Runs until stopped or `shouldStop` returns true. Integrity errors propagate (the supervisor restarts the process). */
  async run(shouldStop: () => boolean = () => false): Promise<void> {
    while (!this.stopped && !shouldStop()) {
      const r = await this.step();
      if (r === "caught_up") await this.clock.sleep(this.o.pollMs);
    }
    await this.bg;
    if (this.last) {
      // flush: the open minute is stored as provisional, the watermark reflects the exact stop point
      if (this.curMinute !== null) await this.closeMinute(this.curMinute, false);
      await this.writeWatermark(this.clock.now(), this.clock.now());
    }
  }
}
