/**
 * Structural Cube model definition (SQL, joins-free cubes, rollups, views). Metric *metadata* is NOT here:
 * it lives only in registry/metrics.v<N>.json and is copied into Cube `meta` by scripts/gen-model.ts (S13: meta == registry).
 *
 * Reads are dedup-correct by construction: every cube selects `FROM <table> FINAL`, so results never depend on merge timing (S10).
 * Exact decimals are emitted as `toString(sum(...))` number-type measures so no float path exists through Cube JSON (S15).
 */
export interface MeasureDef {
  name: string;
  type: "count" | "sum" | "avg" | "count_distinct" | "number";
  /** column (sum/avg/count_distinct) or expression (number). `{CUBE}` and `{measure}` references allowed. */
  sql?: string;
  /** Cube filter predicate (SQL) applied to the measure. */
  filter?: string;
  description: string;
  /** Exact decimal measure: value is a decimal string with this scale (S15). */
  exactScale?: number;
}
export interface DimensionDef {
  name: string;
  sql: string;
  type: "string" | "time" | "number";
  description: string;
}
export interface RollupDef {
  name: string;
  measures: string[];
  dimensions: string[];
}
export interface CubeDef {
  name: string;
  table: string;
  /** Full SELECT body; defaults to `SELECT * FROM <table> FINAL`. */
  select?: string;
  view: string;
  timeColumn: string;
  dimensions: DimensionDef[];
  measures: MeasureDef[];
  rollups: RollupDef[];
}

const dim = (
  name: string,
  sql: string,
  description: string,
  type: DimensionDef["type"] = "string",
): DimensionDef => ({
  name,
  sql,
  type,
  description,
});

export const CUBES: CubeDef[] = [
  {
    name: "near_daily_usage",
    table: "near_daily_usage",
    view: "near_usage",
    timeColumn: "block_date",
    dimensions: [dim("source_label", "source_label", "SYNTHETIC | RECORDED | LIVE provenance label")],
    measures: [
      {
        name: "daily_successful_tx_count",
        type: "sum",
        sql: "successful_tx_count",
        description: "Confirmed successful transactions per UTC day",
      },
      {
        name: "function_call_action_count",
        type: "sum",
        sql: "function_call_actions",
        description: "Function call actions per UTC day",
      },
      {
        name: "distinct_signer_proxy",
        type: "sum",
        sql: "distinct_signer_proxy",
        description:
          "Daily distinct signers (a proxy, not humans). NEVER summed across days: the gateway refuses period grains",
      },
      {
        name: "active_contract_count",
        type: "sum",
        sql: "active_contract_count",
        description: "Daily distinct active contracts. Not summable across days",
      },
    ],
    rollups: [
      {
        name: "daily_usage_rollup",
        measures: [
          "daily_successful_tx_count",
          "function_call_action_count",
          "distinct_signer_proxy",
          "active_contract_count",
        ],
        dimensions: ["source_label"],
      },
    ],
  },
  {
    name: "near_signer_days",
    table: "near_signer_days",
    view: "near_signers",
    timeColumn: "block_date",
    dimensions: [dim("source_label", "source_label", "Provenance label")],
    measures: [
      {
        name: "period_unique_signers",
        type: "count_distinct",
        sql: "signer_account_id",
        description:
          "Distinct signer accounts over the selected period (exact count over signer-day pairs; never a sum of daily uniques)",
      },
    ],
    rollups: [],
  },
  {
    name: "contract_interactions",
    table: "contract_interactions",
    view: "taxonomy",
    timeColumn: "block_date",
    dimensions: [
      dim(
        "category",
        "taxonomy",
        "Taxonomy of the receiver contract (verified mappings only; otherwise uncategorized/unverified)",
      ),
      dim("segment_state", "segment_state", "verified | unverified | ambiguous | uncategorized"),
    ],
    measures: [
      {
        name: "contract_interactions_by_taxonomy",
        type: "sum",
        sql: "interactions",
        description: "Interactions with contracts, group by taxonomy",
      },
      {
        name: "uncategorized_interaction_count",
        type: "sum",
        sql: "interactions",
        filter: "{CUBE}.segment_state = 'uncategorized'",
        description: "Interactions with contracts that have no verified taxonomy mapping",
      },
      {
        name: "verified_interaction_count",
        type: "sum",
        sql: "interactions",
        filter: "{CUBE}.segment_state = 'verified'",
        description: "Interactions with contracts having a verified mapping",
      },
      {
        name: "uncategorized_share",
        type: "number",
        sql: "{uncategorized_interaction_count} / nullIf({contract_interactions_by_taxonomy}, 0)",
        description: "Share of interactions that are uncategorized",
      },
    ],
    rollups: [
      {
        name: "daily_taxonomy_rollup",
        measures: [
          "contract_interactions_by_taxonomy",
          "uncategorized_interaction_count",
          "verified_interaction_count",
        ],
        dimensions: ["category", "segment_state"],
      },
    ],
  },
  {
    name: "intents_swaps",
    table: "intents_swaps",
    view: "intents",
    timeColumn: "created_day",
    dimensions: [
      dim("status", "status", "1Click swap status"),
      dim("privacy_era", "privacy_era", "public | private_settlement (D09)"),
      dim(
        "canonical_origin_asset",
        "canonical_origin_asset",
        "Origin asset resolved by effective-dated alias",
      ),
      dim(
        "canonical_destination_asset",
        "canonical_destination_asset",
        "Destination asset resolved by effective-dated alias",
      ),
      dim("deposit_type", "deposit_type", "Deposit type"),
      dim("reconciliation_level", "reconciliation_level", "On-chain reconciliation level"),
      dim("referral", "referral", "Referral code (restricted)"),
    ],
    measures: [
      {
        name: "oneclick_total_swap_count",
        type: "count",
        description: "All observed 1Click swaps of any status",
      },
      {
        name: "oneclick_completed_swap_count",
        type: "count",
        filter: "{CUBE}.status = 'SUCCESS'",
        description: "1Click swaps with status SUCCESS",
      },
      {
        name: "oneclick_failed_swap_count",
        type: "count",
        filter: "{CUBE}.status = 'FAILED'",
        description: "1Click swaps with status FAILED",
      },
      {
        name: "oneclick_refunded_swap_count",
        type: "count",
        filter: "{CUBE}.status = 'REFUNDED'",
        description: "1Click swaps with status REFUNDED",
      },
      {
        name: "oneclick_private_settlement_swap_count",
        type: "count",
        filter: "{CUBE}.status = 'SUCCESS' AND {CUBE}.privacy_era = 'private_settlement'",
        description: "Completed swaps in the private settlement era",
      },
      {
        name: "oneclick_volume_usd",
        type: "number",
        sql: "toString(sumIf({CUBE}.amount_in_usd, {CUBE}.status = 'SUCCESS' AND {CUBE}.amount_final = 1))",
        exactScale: 18,
        description: "USD value of final-amount completed swaps (exact decimal string, scale 18)",
      },
      {
        name: "oneclick_amount_in_smallest_unit",
        type: "number",
        sql: "toString(sumIf({CUBE}.amount_in, {CUBE}.status = 'SUCCESS' AND {CUBE}.amount_final = 1))",
        exactScale: 0,
        description:
          "Sum of origin amounts in smallest units (exact integer string); only meaningful per canonical origin asset",
      },
      {
        name: "oneclick_completion_rate",
        type: "number",
        sql: "{oneclick_completed_swap_count} / nullIf({oneclick_total_swap_count}, 0)",
        description: "Completed swaps divided by all swaps",
      },
    ],
    rollups: [
      {
        name: "daily_status_rollup",
        measures: [
          "oneclick_total_swap_count",
          "oneclick_completed_swap_count",
          "oneclick_failed_swap_count",
          "oneclick_refunded_swap_count",
          "oneclick_private_settlement_swap_count",
        ],
        dimensions: ["status", "privacy_era"],
      },
    ],
  },
  {
    name: "quote_attempts",
    table: "quote_attempts",
    view: "quotes",
    timeColumn: "day",
    dimensions: [
      dim("route_id", "route_id", "Route identifier"),
      dim("privacy_mode", "privacy_mode", "public | basic | advanced"),
      dim("attempt_class", "attempt_class", "OK | NO_QUOTE | NETWORK_ERROR | TIMEOUT | INVALID_OUTPUT"),
      dim("origin_asset", "origin_asset", "Origin asset"),
      dim("destination_asset", "destination_asset", "Destination asset"),
    ],
    measures: [
      { name: "slot_count", type: "count", description: "All grid slots (observed and unavailable)" },
      {
        name: "route_quote_attempt_count",
        type: "count",
        filter: "{CUBE}.slot = 'observed'",
        description: "Observed dry quote attempts",
      },
      {
        name: "route_quote_ok_count",
        type: "count",
        filter: "{CUBE}.attempt_class = 'OK'",
        description: "Dry quote attempts with class OK",
      },
      {
        name: "route_quote_unavailable_slot_count",
        type: "count",
        filter: "{CUBE}.slot = 'unavailable'",
        description: "Missed grid slots (never backfilled)",
      },
      {
        name: "route_quote_availability",
        type: "number",
        sql: "{route_quote_ok_count} / nullIf({slot_count}, 0)",
        description: "OK attempts divided by all grid slots",
      },
      {
        name: "route_quote_cost_bps",
        type: "avg",
        sql: "quote_cost_bps",
        filter: "{CUBE}.attempt_class = 'OK'",
        description: "Mean quote cost in bps against the declared benchmark (OK attempts)",
      },
    ],
    rollups: [
      {
        name: "daily_route_rollup",
        measures: [
          "slot_count",
          "route_quote_attempt_count",
          "route_quote_ok_count",
          "route_quote_unavailable_slot_count",
        ],
        dimensions: ["route_id", "privacy_mode"],
      },
    ],
  },
  {
    name: "price_candles",
    table: "price_candles",
    select:
      "SELECT * FROM price_candles FINAL ORDER BY update_vintage DESC LIMIT 1 BY provider, coin_id, quote_currency, `interval`, bucket_start",
    view: "prices",
    timeColumn: "day",
    dimensions: [dim("coin_id", "coin_id", "Coin identifier"), dim("symbol", "symbol", "Ticker symbol")],
    measures: [
      {
        name: "daily_close_price_usd",
        type: "avg",
        sql: "close",
        filter: "{CUBE}.quote_currency = 'usd'",
        description: "Mean daily close price in USD (latest vintage per candle)",
      },
      {
        name: "daily_volume_usd",
        type: "number",
        sql: "toString(sumIf({CUBE}.volume, {CUBE}.quote_currency = 'usd'))",
        exactScale: 18,
        description: "Provider-reported daily volume in USD (exact decimal string)",
      },
    ],
    rollups: [],
  },
  {
    name: "economics_reports",
    table: "economics_reports",
    view: "economics",
    timeColumn: "report_day",
    dimensions: [dim("report_source", "report_source", "Reporting source")],
    measures: [
      {
        name: "externally_reported_revenue_usd",
        type: "number",
        sql: "toString(sum({CUBE}.revenue_usd))",
        exactScale: 18,
        description: "Revenue reported by an external party in USD (exact decimal string)",
      },
    ],
    rollups: [],
  },
  {
    name: "agent_market_jobs",
    table: "agent_market_jobs",
    view: "agent_market",
    timeColumn: "job_day",
    dimensions: [dim("market", "market", "Agent market")],
    measures: [
      {
        name: "jobs_completed_if_public",
        type: "sum",
        sql: "completed_jobs",
        filter: "{CUBE}.is_public = 1",
        description: "Completed jobs, only where the market publishes them",
      },
    ],
    rollups: [],
  },
];

/** Views are the only public Cube surface: one per source-limited domain. Cubes are `public: false`. */
export const VIEW_NAMES = [...new Set(CUBES.map((c) => c.view))];

/** Dimensions exposed through views, with workspace visibility (registry `dimensions`). */
export const RESTRICTED_DIMENSIONS = new Set(["intents.referral"]);

export function cubeOfView(view: string): CubeDef {
  const c = CUBES.find((x) => x.view === view);
  if (!c) throw new Error(`unknown view ${view}`);
  return c;
}
