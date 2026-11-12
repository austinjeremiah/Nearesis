import type { IntentsWindow } from "./types.ts";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function assertDb(db: string): string {
  if (!IDENT.test(db)) throw new Error("invalid database name");
  return db;
}

export function assertWindow(w: IntentsWindow): IntentsWindow {
  if (
    !DAY.test(w.from) ||
    !DAY.test(w.to) ||
    Number.isNaN(Date.parse(`${w.from}T00:00:00Z`)) ||
    Number.isNaN(Date.parse(`${w.to}T00:00:00Z`))
  )
    throw new Error("window must be YYYY-MM-DD..YYYY-MM-DD");
  if (w.from > w.to) throw new Error("window.from is after window.to");
  return w;
}

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Chain of one asset id: the registry's `blockchain` (1Click token list) first, then the documented id grammar, else 'unknown'. */
const chainExpr = (a: string, reg: string, hot: string): string => `multiIf(
  ${reg}.chain != '', ${reg}.chain,
  match(${a}, '^nep141:[a-z0-9]+(-[^.]+)?\\\\.(omft|omdep)\\\\.near$'), extract(${a}, '^nep141:([a-z0-9]+)'),
  match(${a}, '^1cs_v1:[a-z0-9]+:'), extract(${a}, '^1cs_v1:([a-z0-9]+):'),
  match(${a}, '^nep245:v2_1\\\\.omni\\\\.hot\\\\.tg:[0-9]+_') AND ${hot}.chain != '', ${hot}.chain,
  match(${a}, '^nep141:[^:]+$'), 'near',
  'unknown')`;

const chainSourceExpr = (a: string, reg: string, hot: string): string => `multiIf(
  ${reg}.chain != '', 'registry',
  match(${a}, '^nep141:[a-z0-9]+(-[^.]+)?\\\\.(omft|omdep)\\\\.near$') OR match(${a}, '^1cs_v1:[a-z0-9]+:') OR (match(${a}, '^nep245:v2_1\\\\.omni\\\\.hot\\\\.tg:[0-9]+_') AND ${hot}.chain != '') OR match(${a}, '^nep141:[^:]+$'), 'asset_id_grammar',
  'unknown')`;

/**
 * `sw`: deduplicated swaps (FINAL) in the window with both chains resolved. All numeric columns stay exact:
 * USD amounts are Decimal256(18) in the source and are summed as Decimals by ClickHouse.
 *
 * `do_not_merge_across_partitions_select_final`: intents_swaps is partitioned by toYYYYMM(created_day) and ordered by swap_key,
 * and created_day is the day of the swap's immutable created_at, so every version of one swap lives in ONE partition (checked on
 * all 11.4M rows: no swap_key spans two partitions). FINAL then deduplicates each partition on its own instead of merging the
 * whole table: a 30-day summary went from 3.5 s to 0.3 s with identical counts and sums.
 */
export function swapsCte(db: string, era: boolean): string {
  assertDb(db);
  return `WITH
ac AS (SELECT provider_asset_id AS a, argMax(blockchain, version) AS chain FROM ${db}.asset_registry GROUP BY a),
hot AS (SELECT extract(provider_asset_id, 'hot\\\\.tg:([0-9]+)_') AS id, any(blockchain) AS chain FROM ${db}.asset_registry WHERE provider_asset_id LIKE 'nep245:v2_1.omni.hot.tg:%' GROUP BY id),
sw AS (
  SELECT s.swap_key AS swap_key, s.status AS status, s.created_day AS day, s.origin_asset AS origin_asset, s.destination_asset AS destination_asset,
         s.canonical_origin_asset AS canon_o, s.canonical_destination_asset AS canon_d,
         s.amount_in_usd AS usd_in, s.amount_out_usd AS usd_out, s.deposit_type AS deposit_type, s.recipient_type AS recipient_type, s.referral AS referral, s.privacy_era AS era,
         ${chainExpr("s.origin_asset", "o", "oh")} AS chain_o, ${chainExpr("s.destination_asset", "d", "dh")} AS chain_d,
         ${chainSourceExpr("s.origin_asset", "o", "oh")} AS chain_src_o, ${chainSourceExpr("s.destination_asset", "d", "dh")} AS chain_src_d
  FROM ${db}.intents_swaps AS s FINAL
  LEFT JOIN ac AS o ON o.a = s.origin_asset
  LEFT JOIN ac AS d ON d.a = s.destination_asset
  LEFT JOIN hot AS oh ON oh.id = extract(s.origin_asset, 'hot\\\\.tg:([0-9]+)_')
  LEFT JOIN hot AS dh ON dh.id = extract(s.destination_asset, 'hot\\\\.tg:([0-9]+)_')
  WHERE s.created_day >= {from:Date} AND s.created_day <= {to:Date}${era ? " AND s.privacy_era = {era:String}" : ""}
  SETTINGS do_not_merge_across_partitions_select_final = 1
)`;
}

/** Asset label: canonical symbol when the registry verified one, else the provider id (explicitly unmapped). */
export const assetLabel = (side: "o" | "d"): string =>
  `coalesce(canon_${side}, concat('unmapped:', ${side === "o" ? "origin_asset" : "destination_asset"}))`;

export const TERMINAL = `status IN ('SUCCESS','REFUNDED','FAILED')`;
/** Settled volume: SUCCESS swaps with a provider USD value. Unknown USD is a separate count, never zero. */
export const VOL = `sumIf(usd_in, status = 'SUCCESS' AND usd_in IS NOT NULL)`;
export const UNK = `countIf(status = 'SUCCESS' AND usd_in IS NULL)`;
