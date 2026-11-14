import type { ClickHouseClient } from "@clickhouse/client";
import { createCh, queryRows } from "@nearesis/analytics";

/** NEAR -> USD: the latest daily mainnet close held locally (`price_candles`, the series the app shows). */
export interface NearUsdRate {
  /** USD per NEAR, an exact decimal string as stored (never a float). */
  rate: string;
  /** UTC day of that close, YYYY-MM-DD. */
  date: string;
}
/** Returns null when no price is held (callers answer 503 PRICE_UNAVAILABLE: a rate is never guessed). */
export type NearUsdRateReader = () => Promise<NearUsdRate | null>;

const TTL_MS = 5 * 60_000;

export function validRate(r: { rate?: unknown; date?: unknown } | null | undefined): NearUsdRate | null {
  if (!r || typeof r.rate !== "string" || typeof r.date !== "string") return null;
  if (!/^\d+(\.\d+)?$/.test(r.rate) || !/[1-9]/.test(r.rate)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return null;
  return { rate: r.rate, date: r.date };
}

/** Production reader: one ClickHouse read of `nearesis_live.price_candles` (daily NEAR/USD close), cached for 5 minutes. */
export function clickhouseNearUsdRate(): { read: NearUsdRateReader; close(): Promise<void> } {
  let ch: ClickHouseClient | null = null;
  let hit: { at: number; value: NearUsdRate } | null = null;
  return {
    async read() {
      if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
      try {
        ch ??= createCh({ database: process.env.NEARESIS_CH_LIVE_DATABASE ?? "nearesis_live" });
        const rows = await queryRows<{ d: string; rate: string }>(
          ch,
          `SELECT toString(day) AS d, argMax(close_raw, bucket_start) AS rate
             FROM price_candles FINAL
            WHERE \`interval\` = '1d' AND symbol = 'NEAR' AND quote_currency = 'usd'
            GROUP BY day ORDER BY day DESC LIMIT 1`,
        );
        const v = validRate({ rate: rows[0]?.rate, date: rows[0]?.d });
        if (v) hit = { at: Date.now(), value: v };
        return v ?? hit?.value ?? null;
      } catch {
        return hit?.value ?? null;
      }
    },
    async close() {
      await ch?.close();
      ch = null;
    },
  };
}
