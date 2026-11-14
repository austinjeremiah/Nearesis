import type { ClickHouseClient } from "@clickhouse/client";
import type { SchedulerState } from "./state.ts";

type Row = Record<string, unknown>;

interface Spec {
  provider: string;
  newestSql: string;
  /** Beyond this lag the provider is reported `late`. */
  lateAfterS: number;
  scannedAtMs: (s: SchedulerState) => number | null;
}

const SPECS: Spec[] = [
  {
    provider: "near-bigquery",
    newestSql:
      "SELECT toString(toDateTime64(max(d), 3, 'UTC')) AS t FROM (SELECT max(block_date) AS d FROM near_daily_tx FINAL UNION ALL SELECT max(block_date) FROM contract_interactions FINAL)",
    lateAfterS: 72 * 3600,
    scannedAtMs: () => null,
  },
  {
    provider: "coingecko",
    newestSql: "SELECT toString(max(provider_timestamp)) AS t FROM price_candles FINAL",
    lateAfterS: 72 * 3600,
    scannedAtMs: () => null,
  },
  {
    provider: "near-explorer",
    newestSql: "SELECT toString(max(created_at)) AS t FROM intents_swaps FINAL",
    lateAfterS: 3 * 3600,
    scannedAtMs: (s) => s.explorer.lastFullScanAtMs,
  },
  {
    provider: "intents-1click",
    newestSql: "SELECT toString(max(fetched_at)) AS t FROM quote_attempts FINAL WHERE slot = 'observed'",
    lateAfterS: 3 * 3600,
    scannedAtMs: (s) => s.quotes.lastAttemptAtMs,
  },
];

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Writes a fresh `source_watermarks` row per provider (newest event time, gap count, lag, last scan, state). Providers with no
 * data yet are `unavailable`, never fresh. M1's scheduler consumes these rows (higher `version` = newer).
 */
export async function emitWatermarks(ch: ClickHouseClient, s: SchedulerState, nowMs: number): Promise<Row[]> {
  const rows: Row[] = [];
  for (const sp of SPECS) {
    const rs = await ch.query({ query: sp.newestSql, format: "JSONEachRow" });
    const t = ((await rs.json()) as Array<{ t: string | null }>)[0]?.t ?? null;
    const has = t !== null && !t.startsWith("1970");
    const g = await ch.query({
      query: "SELECT count() AS n FROM quality_gaps FINAL WHERE provider_id = {p:String}",
      query_params: { p: sp.provider },
      format: "JSONEachRow",
    });
    const gaps = Number(((await g.json()) as Array<{ n: string }>)[0]?.n ?? 0);
    const lag = has ? (nowMs - Date.parse(`${(t as string).replace(" ", "T")}Z`)) / 1000 : null;
    rows.push({
      provider_id: sp.provider,
      newest_event_time: has ? t : null,
      last_full_scan_at: iso(sp.scannedAtMs(s)),
      gap_count: gaps,
      provider_lag_seconds: lag,
      schema_version: null,
      state: !has ? "unavailable" : lag !== null && lag > sp.lateAfterS ? "late" : "fresh",
      version: nowMs,
    });
  }
  await ch.insert({ table: "source_watermarks", values: rows, format: "JSONEachRow" });
  return rows;
}
