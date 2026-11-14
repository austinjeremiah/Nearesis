import type { ClickHouseClient } from "@clickhouse/client";
import { insertLive } from "../backfill/ch.ts";
import { RT_FEED_ID, RT_PROVIDER, type BlockAggregate, decideWrite } from "./aggregate.ts";

export interface StoredBlockMeta {
  height: number;
  blockHash: string;
  state: "final" | "provisional";
  blockTsMs: number;
}
export interface WatermarkRow {
  height: number;
  blockHash: string;
  blockTsMs: number;
  headHeight: number;
  observedAtMs: number;
  ingestedAtMs: number;
  lagSeconds: number;
  firstHeight: number;
  firstBlockTsMs: number;
  skippedHeights: number;
  state: "live" | "catching_up" | "stalled";
}
export interface MinuteRow {
  minuteMs: number;
  state: "final" | "provisional";
  complete: boolean;
  blockCount: number;
  firstHeight: number;
  lastHeight: number;
  txCount: number;
  receiptCount: number | null;
  gasBurnt: bigint;
  tokensBurntYocto: bigint;
  activeSigners: number;
  topReceivers: Array<{ receiverId: string; tx: number; rc: number | null }>;
}

export interface RtStore {
  lastBlock(): Promise<StoredBlockMeta | null>;
  getBlock(height: number): Promise<StoredBlockMeta | null>;
  /** Applies the finality state machine; returns the decision taken. Idempotent per (height, hash). */
  putBlock(
    b: BlockAggregate,
    observedAtMs: number,
    ingestedAtMs: number,
    /** The caller knows the height is above the stored tip, so no row can exist: skips the existence read. */
    aboveTip?: boolean,
  ): Promise<string>;
  /** Recomputes one minute from stored blocks (idempotent). feedStartMs = first block time of the feed (earlier minutes are partial). */
  materializeMinute(
    minuteMs: number,
    closed: boolean,
    feedStartMs: number,
    nowMs: number,
  ): Promise<MinuteRow | null>;
  putWatermark(w: WatermarkRow, nowMs: number): Promise<void>;
  getWatermark(): Promise<WatermarkRow | null>;
  anomaly(kind: string, height: number, detail: string, nowMs: number): Promise<void>;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace("T", " ").replace("Z", "");

export class ClickHouseRtStore implements RtStore {
  constructor(private readonly ch: ClickHouseClient) {}

  private async rows<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const rs = await this.ch.query({ query, query_params: params, format: "JSONEachRow" });
    return (await rs.json()) as T[];
  }
  private static meta(r: { hs: string; block_hash: string; state: string; ts: string }): StoredBlockMeta {
    return {
      height: Number(r.hs),
      blockHash: r.block_hash,
      state: r.state === "final" ? "final" : "provisional",
      blockTsMs: Number(r.ts),
    };
  }

  async lastBlock(): Promise<StoredBlockMeta | null> {
    const r = await this.rows<{ hs: string; block_hash: string; state: string; ts: string }>(
      `SELECT toString(height) AS hs, block_hash, state, toString(toUnixTimestamp64Milli(block_ts)) AS ts
       FROM rt_blocks WHERE height = (SELECT max(height) FROM rt_blocks) ORDER BY version DESC LIMIT 1`,
    );
    return r[0] ? ClickHouseRtStore.meta(r[0]) : null;
  }
  async getBlock(height: number): Promise<StoredBlockMeta | null> {
    const r = await this.rows<{ hs: string; block_hash: string; state: string; ts: string }>(
      `SELECT toString(height) AS hs, block_hash, state, toString(toUnixTimestamp64Milli(block_ts)) AS ts
       FROM rt_blocks WHERE height = {h:UInt64} ORDER BY version DESC LIMIT 1`,
      { h: height },
    );
    return r[0] ? ClickHouseRtStore.meta(r[0]) : null;
  }

  async putBlock(
    b: BlockAggregate,
    observedAtMs: number,
    ingestedAtMs: number,
    aboveTip = false,
  ): Promise<string> {
    const ex = aboveTip ? null : await this.getBlock(b.height);
    const d = decideWrite(ex, b);
    if (d === "noop") return d;
    if (d === "anomaly_final_conflict") {
      await this.anomaly(
        "FINAL_HASH_CONFLICT",
        b.height,
        `stored ${ex?.blockHash} vs incoming ${b.blockHash}; final row kept`,
        ingestedAtMs,
      );
      return d;
    }
    await insertLive(this.ch, "rt_blocks", [
      {
        height: b.height,
        block_hash: b.blockHash,
        prev_hash: b.prevHash,
        prev_height: b.prevHeight,
        block_ts: iso(b.blockTsMs),
        state: b.state,
        provider: RT_PROVIDER,
        tx_count: b.txCount,
        receipt_count: b.receiptCount,
        gas_burnt: b.gasBurnt.toString(),
        tokens_burnt_yocto: b.tokensBurntYocto.toString(),
        signer_count: b.signers.length,
        chunks_included: b.chunksIncluded,
        observed_at: iso(observedAtMs),
        ingested_at: iso(ingestedAtMs),
        signers: b.signers,
        receiver_ids: b.receiverIds,
        receiver_tx: b.receiverTx,
        receiver_rcpt: b.receiverRcpt,
        source_label: "LIVE",
        version: ingestedAtMs,
      },
    ]);
    return d;
  }

  async materializeMinute(
    minuteMs: number,
    closed: boolean,
    feedStartMs: number,
    nowMs: number,
  ): Promise<MinuteRow | null> {
    const p = { f: iso(minuteMs), t: iso(minuteMs + 60_000) };
    const where = `FROM rt_blocks FINAL WHERE block_ts >= toDateTime64({f:String}, 3, 'UTC') AND block_ts < toDateTime64({t:String}, 3, 'UTC')`;
    const [a] = await this.rows<Record<string, string>>(
      `SELECT toString(count()) AS n, toString(min(height)) AS h0, toString(max(height)) AS h1, toString(sum(tx_count)) AS tx,
              toString(if(countIf(receipt_count IS NULL) > 0, NULL, sum(receipt_count))) AS rc, toString(sum(gas_burnt)) AS gas, toString(sum(tokens_burnt_yocto)) AS tok,
              toString(countIf(state != 'final')) AS prov ${where}`,
      p,
    );
    if (!a || a.n === "0") return null;
    const [sg] = await this.rows<{ n: string }>(
      `SELECT toString(uniqExact(s)) AS n FROM (SELECT arrayJoin(signers) AS s ${where})`,
      p,
    );
    const top = await this.rows<{ r: string; tx: string; rc: string | null }>(
      `SELECT r, toString(sum(t)) AS tx, toString(if(countIf(c IS NULL) > 0, NULL, sum(c))) AS rc FROM
         (SELECT arrayJoin(arrayZip(receiver_ids, receiver_tx, receiver_rcpt)) AS z, z.1 AS r, z.2 AS t, z.3 AS c ${where})
       GROUP BY r ORDER BY sum(t) DESC, r ASC LIMIT 100`,
      p,
    );
    const feedFullFrom = Math.ceil(feedStartMs / 60_000) * 60_000;
    const row: MinuteRow = {
      minuteMs,
      state: closed && a.prov === "0" ? "final" : "provisional",
      complete: closed && minuteMs >= feedFullFrom,
      blockCount: Number(a.n),
      firstHeight: Number(a.h0),
      lastHeight: Number(a.h1),
      txCount: Number(a.tx),
      receiptCount: a.rc === null || a.rc === undefined ? null : Number(a.rc),
      gasBurnt: BigInt(a.gas ?? "0"),
      tokensBurntYocto: BigInt(a.tok ?? "0"),
      activeSigners: Number(sg?.n ?? 0),
      topReceivers: top.map((t) => ({
        receiverId: t.r,
        tx: Number(t.tx),
        rc: t.rc === null ? null : Number(t.rc),
      })),
    };
    await insertLive(this.ch, "rt_minutes", [
      {
        minute: iso(minuteMs).slice(0, 19),
        state: row.state,
        complete: row.complete ? 1 : 0,
        block_count: row.blockCount,
        first_height: row.firstHeight,
        last_height: row.lastHeight,
        tx_count: row.txCount,
        receipt_count: row.receiptCount,
        gas_burnt: row.gasBurnt.toString(),
        tokens_burnt_yocto: row.tokensBurntYocto.toString(),
        active_signers: row.activeSigners,
        provider: RT_PROVIDER,
        computed_at: iso(nowMs),
        source_label: "LIVE",
        version: nowMs,
      },
    ]);
    await insertLive(
      this.ch,
      "rt_minute_receivers",
      row.topReceivers.map((t) => ({
        minute: iso(minuteMs).slice(0, 19),
        receiver_id: t.receiverId,
        tx_count: t.tx,
        receipt_count: t.rc,
        state: row.state,
        source_label: "LIVE",
        version: nowMs,
      })),
    );
    return row;
  }

  async putWatermark(w: WatermarkRow, nowMs: number): Promise<void> {
    await insertLive(this.ch, "rt_watermark", [
      {
        feed_id: RT_FEED_ID,
        provider: RT_PROVIDER,
        height: w.height,
        block_hash: w.blockHash,
        block_ts: iso(w.blockTsMs),
        head_height: w.headHeight,
        observed_at: iso(w.observedAtMs),
        ingested_at: iso(w.ingestedAtMs),
        lag_seconds: w.lagSeconds,
        finality: "final",
        first_height: w.firstHeight,
        first_block_ts: iso(w.firstBlockTsMs),
        skipped_heights: w.skippedHeights,
        state: w.state,
        source_label: "LIVE",
        version: nowMs,
      },
    ]);
  }
  async getWatermark(): Promise<WatermarkRow | null> {
    const r = await this.rows<Record<string, string | number>>(
      `SELECT height, block_hash, toUnixTimestamp64Milli(block_ts) AS ts, head_height, toUnixTimestamp64Milli(observed_at) AS obs,
              toUnixTimestamp64Milli(ingested_at) AS ing, lag_seconds, first_height, toUnixTimestamp64Milli(first_block_ts) AS fts,
              skipped_heights, state FROM rt_watermark FINAL WHERE feed_id = {f:String} LIMIT 1`,
      { f: RT_FEED_ID },
    );
    const x = r[0];
    if (!x) return null;
    return {
      height: Number(x.height),
      blockHash: String(x.block_hash),
      blockTsMs: Number(x.ts),
      headHeight: Number(x.head_height),
      observedAtMs: Number(x.obs),
      ingestedAtMs: Number(x.ing),
      lagSeconds: Number(x.lag_seconds),
      firstHeight: Number(x.first_height),
      firstBlockTsMs: Number(x.fts),
      skippedHeights: Number(x.skipped_heights),
      state: String(x.state) as WatermarkRow["state"],
    };
  }
  async anomaly(kind: string, height: number, detail: string, nowMs: number): Promise<void> {
    await insertLive(this.ch, "rt_anomalies", [
      {
        at: iso(nowMs),
        feed_id: RT_FEED_ID,
        kind,
        height,
        detail: detail.slice(0, 500),
        source_label: "LIVE",
      },
    ]);
  }
}

/** In-memory store with the same semantics, used by tests (restart simulation, finality). */
export class MemoryRtStore implements RtStore {
  blocks = new Map<number, BlockAggregate & { observedAtMs: number; ingestedAtMs: number }>();
  minutes = new Map<number, MinuteRow>();
  watermark: WatermarkRow | null = null;
  anomalies: Array<{ kind: string; height: number; detail: string }> = [];
  writes = 0;
  async lastBlock(): Promise<StoredBlockMeta | null> {
    const hs = [...this.blocks.keys()];
    return hs.length ? this.getBlock(Math.max(...hs)) : null;
  }
  async getBlock(height: number): Promise<StoredBlockMeta | null> {
    const b = this.blocks.get(height);
    return b ? { height, blockHash: b.blockHash, state: b.state, blockTsMs: b.blockTsMs } : null;
  }
  async putBlock(b: BlockAggregate, observedAtMs: number, ingestedAtMs: number): Promise<string> {
    const ex = this.blocks.get(b.height);
    const d = decideWrite(ex ?? null, b);
    if (d === "anomaly_final_conflict")
      this.anomalies.push({ kind: "FINAL_HASH_CONFLICT", height: b.height, detail: "" });
    if (d !== "noop" && d !== "anomaly_final_conflict") {
      this.blocks.set(b.height, { ...b, observedAtMs, ingestedAtMs });
      this.writes++;
    }
    return d;
  }
  async materializeMinute(minuteMs: number, closed: boolean, feedStartMs: number): Promise<MinuteRow | null> {
    const bs = [...this.blocks.values()].filter(
      (b) => b.blockTsMs >= minuteMs && b.blockTsMs < minuteMs + 60_000,
    );
    if (!bs.length) return null;
    const signers = new Set(bs.flatMap((b) => b.signers));
    const recv = new Map<string, { tx: number; rc: number | null }>();
    for (const b of bs)
      b.receiverIds.forEach((id, i) => {
        const e = recv.get(id) ?? { tx: 0, rc: 0 as number | null };
        e.tx += b.receiverTx[i] ?? 0;
        const r = b.receiverRcpt[i] ?? null;
        e.rc = e.rc === null || r === null ? null : e.rc + r;
        recv.set(id, e);
      });
    const row: MinuteRow = {
      minuteMs,
      state: closed && bs.every((b) => b.state === "final") ? "final" : "provisional",
      complete: closed && minuteMs >= Math.ceil(feedStartMs / 60_000) * 60_000,
      blockCount: bs.length,
      firstHeight: Math.min(...bs.map((b) => b.height)),
      lastHeight: Math.max(...bs.map((b) => b.height)),
      txCount: bs.reduce((s, b) => s + b.txCount, 0),
      receiptCount: bs.some((b) => b.receiptCount === null)
        ? null
        : bs.reduce((s, b) => s + (b.receiptCount ?? 0), 0),
      gasBurnt: bs.reduce((s, b) => s + b.gasBurnt, 0n),
      tokensBurntYocto: bs.reduce((s, b) => s + b.tokensBurntYocto, 0n),
      activeSigners: signers.size,
      topReceivers: [...recv.entries()]
        .map(([receiverId, v]) => ({ receiverId, tx: v.tx, rc: v.rc }))
        .sort((a, b) => b.tx - a.tx || a.receiverId.localeCompare(b.receiverId))
        .slice(0, 100),
    };
    this.minutes.set(minuteMs, row);
    return row;
  }
  async putWatermark(w: WatermarkRow): Promise<void> {
    this.watermark = w;
  }
  async getWatermark(): Promise<WatermarkRow | null> {
    return this.watermark;
  }
  async anomaly(kind: string, height: number, detail: string): Promise<void> {
    this.anomalies.push({ kind, height, detail });
  }
}
