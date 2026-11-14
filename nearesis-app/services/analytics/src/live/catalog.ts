import { createCh, queryRows, type ClickHouseClient } from "../ch.ts";
import { LIVE_DATABASE, LIVE_WINDOW } from "./definition.ts";
import { LIVE_METRICS } from "./registry.ts";

export interface LiveDataset {
  view: string;
  label: "LIVE";
  table: string;
  provider: string;
  coverageDataset: string;
  metrics: string[];
  requestedWindow: { from: string; to: string };
  /** First and last day that actually has rows, and how many distinct days are loaded. */
  dataWindow: { from: string | null; to: string | null; days: number };
  /** Days covered per source_coverage, by state; days with no coverage row are unknown, never zero. */
  coverage: { complete: number; partial: number; unavailable: number };
  gaps: number;
}

const SPECS = [
  ["near_daily_tx_live", "near_daily_tx", "near-bigquery", "block_date"],
  ["contract_interactions_live", "contract_interactions", "near-bigquery", "block_date"],
  ["price_candles_live", "price_candles", "coingecko", "day"],
  ["intents_swaps_live", "intents_swaps", "near-explorer", "created_day"],
] as const;

/** Real data windows of the LIVE datasets, read from nearesis_live (parameterized; identifiers come from the constant table above). */
export async function liveCatalog(
  ch: ClickHouseClient = createCh({ database: LIVE_DATABASE }),
): Promise<LiveDataset[]> {
  const out: LiveDataset[] = [];
  for (const [view, table, provider, col] of SPECS) {
    const w = (
      await queryRows<{ lo: string; hi: string; d: string; n: string }>(
        ch,
        `SELECT toString(min(${col})) AS lo, toString(max(${col})) AS hi, toString(uniqExact(${col})) AS d, toString(count()) AS n FROM ${table} FINAL`,
      )
    )[0];
    const cov = await queryRows<{ state: string; n: string }>(
      ch,
      "SELECT state, toString(count()) AS n FROM source_coverage FINAL WHERE provider_id = {p:String} AND dataset = {d:String} GROUP BY state",
      { p: provider, d: table },
    );
    const gaps = await queryRows<{ n: string }>(
      ch,
      "SELECT toString(count()) AS n FROM quality_gaps FINAL WHERE provider_id = {p:String} AND dataset = {d:String}",
      { p: provider, d: table },
    );
    const has = Number(w?.n ?? 0) > 0;
    const c = (s: string) => Number(cov.find((x) => x.state === s)?.n ?? 0);
    out.push({
      view,
      label: "LIVE",
      table,
      provider,
      coverageDataset: table,
      metrics: LIVE_METRICS.filter((m) => m.cubeMember.startsWith(`${view}.`)).map((m) => m.id),
      requestedWindow: { ...LIVE_WINDOW },
      dataWindow: {
        from: has ? (w?.lo ?? null) : null,
        to: has ? (w?.hi ?? null) : null,
        days: Number(w?.d ?? 0),
      },
      coverage: { complete: c("complete"), partial: c("partial"), unavailable: c("unavailable") },
      gaps: Number(gaps[0]?.n ?? 0),
    });
  }
  return out;
}
