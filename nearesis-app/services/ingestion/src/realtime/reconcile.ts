import type { ClickHouseClient } from "@clickhouse/client";
import { insertLive } from "../backfill/ch.ts";

export type ReconStatus = "MATCH" | "WITHIN_TOLERANCE" | "DIFF" | "PARTIAL_COVERAGE" | "PENDING_BQ";
export interface DayRecon {
  day: string;
  status: ReconStatus;
  bqTxCount: number | null;
  rtTxCount: number;
  diff: number | null;
  diffPct: number | null;
  rtBlocks: number;
  rtContiguous: boolean;
  note: string;
}
/** Relative tolerance for WITHIN_TOLERANCE (0.01 %). Anything above is a DIFF to investigate; BigQuery stays authoritative. */
export const RECON_TOLERANCE_PCT = 0.01;

export interface DayInputs {
  day: string;
  bqTxCount: number | null;
  rtTxCount: number;
  rtBlocks: number;
  /** sum(height - prev_height) == max(height) - min(prev_height): telescopes only for an unbroken parent chain. */
  rtContiguous: boolean;
  /** The feed has a stored block at or before the day start (the first block of the day has its parent stored) and one at/after the day end. */
  rtCoversDay: boolean;
}

/** Pure decision for one UTC day. Never compares a partially covered feed day against a full BigQuery day. */
export function reconcileDay(i: DayInputs): DayRecon {
  const base = {
    day: i.day,
    bqTxCount: i.bqTxCount,
    rtTxCount: i.rtTxCount,
    rtBlocks: i.rtBlocks,
    rtContiguous: i.rtContiguous,
  };
  if (!i.rtCoversDay || !i.rtContiguous)
    return {
      ...base,
      status: "PARTIAL_COVERAGE",
      diff: null,
      diffPct: null,
      note: !i.rtCoversDay
        ? "feed does not cover the whole UTC day (started or stopped inside it); not compared"
        : "feed has a gap inside the day; not compared",
    };
  if (i.bqTxCount === null)
    return {
      ...base,
      status: "PENDING_BQ",
      diff: null,
      diffPct: null,
      note: "BigQuery day total not loaded yet",
    };
  const diff = i.rtTxCount - i.bqTxCount;
  const pct = i.bqTxCount === 0 ? (diff === 0 ? 0 : 100) : (Math.abs(diff) / i.bqTxCount) * 100;
  const status: ReconStatus = diff === 0 ? "MATCH" : pct <= RECON_TOLERANCE_PCT ? "WITHIN_TOLERANCE" : "DIFF";
  return {
    ...base,
    status,
    diff,
    diffPct: pct,
    note: status === "DIFF" ? "real-time total differs from BigQuery; BigQuery remains authoritative" : "",
  };
}

async function rows<T>(ch: ClickHouseClient, query: string, p: Record<string, unknown> = {}): Promise<T[]> {
  const rs = await ch.query({ query, query_params: p, format: "JSONEachRow" });
  return (await rs.json()) as T[];
}

/** Days (UTC) strictly before today's partial day that have rt blocks. */
export async function reconcileDays(ch: ClickHouseClient, nowMs: number, write = true): Promise<DayRecon[]> {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const days = await rows<{ d: string }>(
    ch,
    `SELECT toString(toDate(block_ts)) AS d FROM rt_blocks FINAL GROUP BY d HAVING d < {t:String} ORDER BY d`,
    { t: today },
  );
  const [fb] = await rows<{ first_ts: string; last_ts: string }>(
    ch,
    `SELECT toString(toUnixTimestamp64Milli(min(block_ts))) AS first_ts, toString(toUnixTimestamp64Milli(max(block_ts))) AS last_ts FROM rt_blocks FINAL`,
  );
  const out: DayRecon[] = [];
  for (const { d } of days) {
    const [a] = await rows<Record<string, string>>(
      ch,
      `SELECT toString(count()) AS n, toString(sum(tx_count)) AS tx, toString(sum(toInt64(height) - toInt64(prev_height))) AS span,
              toString(max(height) - min(prev_height)) AS chain
       FROM rt_blocks FINAL WHERE toDate(block_ts) = toDate({d:String})`,
      { d },
    );
    const bq = await rows<{ n: string }>(
      ch,
      `SELECT toString(tx_count) AS n FROM near_daily_tx FINAL WHERE block_date = toDate({d:String}) LIMIT 1`,
      { d },
    );
    const dayStart = Date.parse(`${d}T00:00:00Z`);
    const covers =
      fb !== undefined && Number(fb.first_ts) <= dayStart && Number(fb.last_ts) >= dayStart + 86_400_000;
    const r = reconcileDay({
      day: d,
      bqTxCount: bq[0] ? Number(bq[0].n) : null,
      rtTxCount: Number(a?.tx ?? 0),
      rtBlocks: Number(a?.n ?? 0),
      rtContiguous: a?.span === a?.chain,
      rtCoversDay: covers,
    });
    out.push(r);
    if (write)
      await insertLive(ch, "rt_reconciliation", [
        {
          day: r.day,
          status: r.status,
          bq_tx_count: r.bqTxCount,
          rt_tx_count: r.rtTxCount,
          diff: r.diff,
          diff_pct: r.diffPct,
          rt_blocks: r.rtBlocks,
          rt_contiguous: r.rtContiguous ? 1 : 0,
          note: r.note,
          checked_at: new Date(nowMs).toISOString().replace("T", " ").replace("Z", ""),
          source_label: "LIVE",
          version: nowMs,
        },
      ]);
  }
  return out;
}
