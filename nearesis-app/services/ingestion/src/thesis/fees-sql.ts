import { NEAR_DATASET } from "../adapters/bigquery-guard.ts";
import { addDays, monthRanges } from "../backfill/plan.ts";

/**
 * NEAR fee and burn series for the thesis "The Toll Booth Problem": BigQuery SQL builders (pure, no I/O).
 * Every query: SELECT only, finite DECLAREd block_date bounds (>= start, < end), no OR, columns limited to what is needed.
 * tokens_burnt is FLOAT64 yoctoNEAR in the public dataset (exact only to 2^-53 relative per value, see docs/economics/SEMANTICS.md);
 * the stored double is cast to BIGNUMERIC and summed exactly, so aggregation adds no error.
 */
export const FEES_FROM = "2025-11-10";
export const FEES_LAST = "2026-11-13"; // inclusive
export const FEES_TO_EXCLUSIVE = addDays(FEES_LAST, 1);
export const TOP_EXECUTORS_PER_CHUNK = 1000;
export const OMFT_SUFFIX = ".omft.near";
export const OMFT_GROUP = "*.omft.near";
export const NULL_EXECUTOR = "__null_executor__";
export const NULL_RECEIVER = "__null_receiver__";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_RE = /^[a-z0-9._-]{2,64}$/;
const need = (d: string): string => {
  if (!DAY_RE.test(d)) throw new Error("date must be YYYY-MM-DD");
  return d;
};
const lit = (a: string): string => {
  if (!ACCOUNT_RE.test(a)) throw new Error(`bad account literal ${a}`);
  return `'${a}'`;
};
const T = (t: string): string => `\`bigquery-public-data.${NEAR_DATASET}.${t}\``;
const decl = (from: string, to: string): string[] => [
  `DECLARE start_date DATE DEFAULT DATE '${need(from)}';`,
  `DECLARE end_date DATE DEFAULT DATE '${need(to)}';`,
];

export type FeesFamily = "outcomes" | "tx" | "blocks";
export interface FeesChunk {
  id: string; // `${family}:${from}`
  family: FeesFamily;
  from: string;
  to: string;
}

/** Newest month first; the tiny blocks family first of all, then the heavy execution_outcomes scan, then transactions. */
export function planFeesChunks(from = FEES_FROM, last = FEES_LAST): FeesChunk[] {
  const months = monthRanges(from, last).reverse();
  const out: FeesChunk[] = [];
  for (const family of ["blocks", "outcomes", "tx"] as const)
    for (const m of months) out.push({ id: `${family}:${m.from}`, family, from: m.from, to: m.to });
  return out;
}

/** Splits a chunk at its midpoint (>= 1 day each); null for a single day. Used when a month does not fit the remaining quota. */
export function splitFeesChunk(c: FeesChunk): [FeesChunk, FeesChunk] | null {
  const days: string[] = [];
  for (let d = c.from; d < c.to; d = addDays(d, 1)) days.push(d);
  if (days.length < 2) return null;
  const mid = days[Math.floor(days.length / 2)] as string;
  return [
    { ...c, id: `${c.family}:${c.from}`, to: mid },
    { ...c, id: `${c.family}:${mid}`, from: mid },
  ];
}

/** Per-day rank cut: the rows of the executors (receivers) ranked by tokens (conversion tokens) within a day, kept individually. */
export const DAY_RANK_KEEP = 500;
export const TX_DAY_RANK_KEEP = 300;

const IN_LIST = (col: string, accounts: readonly string[]): string =>
  `${col} IN (${accounts.map(lit).join(", ")})`;

export const OUTCOME_COLUMNS = [
  "kind",
  "block_date",
  "account",
  "n",
  "gas",
  "tokens_yocto",
  "null_gas",
  "null_tokens",
  "fractional_gas",
  "day_rank",
];

/**
 * execution_outcomes, one scan per chunk (executor_account_id, gas_burnt, tokens_burnt only; ~0.7 GB per recent day):
 *  kind 'day'  - per day: outcomes, gas, tokens over ALL outcomes (transaction outcomes and receipt outcomes);
 *  kind 'ex'   - per day and executor: the DAY_RANK_KEEP executors with the most tokens that day, plus every `keep` account;
 *                day_rank is the executor's rank within the day (so any executor not listed burnt no more than the last rank);
 *  kind 'omft' - per day: all executors whose name ends in .omft.near summed;
 *  kind 'top'  - per chunk: the TOP_EXECUTORS_PER_CHUNK executors by tokens, block_date NULL.
 * Which accounts count as the Intents footprint is decided afterwards, from the discovery files, never in the SQL.
 */
export function outcomesSql(c: Pick<FeesChunk, "from" | "to">, keep: readonly string[]): string {
  return [
    ...decl(c.from, c.to),
    "WITH perex AS (",
    "  SELECT x.block_date AS block_date, IFNULL(x.executor_account_id, '__null_executor__') AS ex, COUNT(*) AS n,",
    "    SUM(CAST(x.gas_burnt AS NUMERIC)) AS g, SUM(CAST(x.tokens_burnt AS BIGNUMERIC)) AS t,",
    "    COUNTIF(x.gas_burnt IS NULL) AS ng, COUNTIF(x.tokens_burnt IS NULL) AS nt,",
    "    COUNTIF(x.gas_burnt != FLOOR(x.gas_burnt)) AS fg",
    `  FROM ${T("execution_outcomes")} x`,
    "  WHERE x.block_date >= start_date AND x.block_date < end_date",
    "  GROUP BY block_date, ex",
    "), ranked AS (",
    "  SELECT *, ROW_NUMBER() OVER (PARTITION BY block_date ORDER BY t DESC, ex) AS rk FROM perex",
    "), chunk_ex AS (",
    "  SELECT ex, SUM(n) AS n, SUM(g) AS g, SUM(t) AS t, ROW_NUMBER() OVER (ORDER BY SUM(t) DESC, ex) AS rk",
    "  FROM perex GROUP BY ex",
    ")",
    "SELECT 'day' AS kind, block_date, CAST(NULL AS STRING) AS account, SUM(n) AS n,",
    "  CAST(IFNULL(SUM(g), 0) AS STRING) AS gas, CAST(IFNULL(SUM(t), 0) AS STRING) AS tokens_yocto,",
    "  SUM(ng) AS null_gas, SUM(nt) AS null_tokens, SUM(fg) AS fractional_gas, CAST(NULL AS INT64) AS day_rank",
    "FROM perex GROUP BY block_date",
    "UNION ALL",
    "SELECT 'ex', block_date, ex, n, CAST(IFNULL(g, 0) AS STRING), CAST(IFNULL(t, 0) AS STRING), ng, nt, fg, rk",
    `FROM ranked WHERE IF(rk <= ${DAY_RANK_KEEP}, TRUE, ${IN_LIST("ex", keep)})`,
    "UNION ALL",
    `SELECT 'omft', block_date, CAST(NULL AS STRING), SUM(n), CAST(IFNULL(SUM(g), 0) AS STRING), CAST(IFNULL(SUM(t), 0) AS STRING),`,
    "  SUM(ng), SUM(nt), SUM(fg), CAST(NULL AS INT64)",
    `FROM perex WHERE ENDS_WITH(ex, ${lit(OMFT_SUFFIX)}) GROUP BY block_date`,
    "UNION ALL",
    "SELECT 'top', CAST(NULL AS DATE), ex, n, CAST(IFNULL(g, 0) AS STRING), CAST(IFNULL(t, 0) AS STRING),",
    "  CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64), rk",
    `FROM chunk_ex WHERE rk <= ${TOP_EXECUTORS_PER_CHUNK}`,
    "ORDER BY 1, 2, 3",
  ].join("\n");
}

export const TX_COLUMNS = [
  "kind",
  "block_date",
  "account",
  "txs",
  "conversion_gas",
  "conversion_tokens_yocto",
  "null_gas",
  "null_tokens",
  "day_rank",
];

/**
 * transactions (receiver_account_id, receipt_conversion_gas_burnt, receipt_conversion_tokens_burnt): the cost of converting the
 * signed transaction into its first receipt (charged at the transaction outcome, executor = signer). kind 'day' = all transactions,
 * 'rcv' = per receiver (the TX_DAY_RANK_KEEP receivers with the most transactions per day plus every `keep` account),
 * 'omft' = all receivers ending in .omft.near summed.
 */
export function txSql(c: Pick<FeesChunk, "from" | "to">, keep: readonly string[]): string {
  return [
    ...decl(c.from, c.to),
    "WITH r AS (",
    "  SELECT t.block_date AS block_date, IFNULL(t.receiver_account_id, '__null_receiver__') AS rcv, COUNT(*) AS n,",
    "    SUM(CAST(t.receipt_conversion_gas_burnt AS NUMERIC)) AS g, SUM(CAST(t.receipt_conversion_tokens_burnt AS BIGNUMERIC)) AS k,",
    "    COUNTIF(t.receipt_conversion_gas_burnt IS NULL) AS ng, COUNTIF(t.receipt_conversion_tokens_burnt IS NULL) AS nk",
    `  FROM ${T("transactions")} t`,
    "  WHERE t.block_date >= start_date AND t.block_date < end_date",
    "  GROUP BY block_date, rcv",
    "), ranked AS (",
    "  SELECT *, ROW_NUMBER() OVER (PARTITION BY block_date ORDER BY n DESC, rcv) AS rk FROM r",
    ")",
    "SELECT 'day' AS kind, block_date, CAST(NULL AS STRING) AS account, SUM(n) AS txs,",
    "  CAST(IFNULL(SUM(g), 0) AS STRING) AS conversion_gas, CAST(IFNULL(SUM(k), 0) AS STRING) AS conversion_tokens_yocto,",
    "  SUM(ng) AS null_gas, SUM(nk) AS null_tokens, CAST(NULL AS INT64) AS day_rank",
    "FROM r GROUP BY block_date",
    "UNION ALL",
    "SELECT 'rcv', block_date, rcv, n, CAST(IFNULL(g, 0) AS STRING), CAST(IFNULL(k, 0) AS STRING), ng, nk, rk",
    `FROM ranked WHERE IF(rk <= ${TX_DAY_RANK_KEEP}, TRUE, ${IN_LIST("rcv", keep)})`,
    "UNION ALL",
    "SELECT 'omft', block_date, CAST(NULL AS STRING), SUM(n), CAST(IFNULL(SUM(g), 0) AS STRING), CAST(IFNULL(SUM(k), 0) AS STRING),",
    "  SUM(ng), SUM(nk), CAST(NULL AS INT64)",
    `FROM r WHERE ENDS_WITH(rcv, ${lit(OMFT_SUFFIX)}) GROUP BY block_date`,
    "ORDER BY 1, 2, 3",
  ].join("\n");
}

export const BLOCKS_COLUMNS = [
  "block_date",
  "blocks",
  "min_gas_price",
  "max_gas_price",
  "sum_gas_price",
  "null_price_rows",
];

/** blocks.gas_price (yoctoNEAR per gas): block count, min, max and the exact sum per day (mean = sum / blocks). */
export function blocksSql(c: Pick<FeesChunk, "from" | "to">): string {
  return [
    ...decl(c.from, c.to),
    "SELECT b.block_date AS block_date, COUNT(*) AS blocks, CAST(MIN(b.gas_price) AS STRING) AS min_gas_price,",
    "  CAST(MAX(b.gas_price) AS STRING) AS max_gas_price, CAST(SUM(CAST(b.gas_price AS NUMERIC)) AS STRING) AS sum_gas_price,",
    "  COUNTIF(b.gas_price IS NULL) AS null_price_rows",
    `FROM ${T("blocks")} b`,
    "WHERE b.block_date >= start_date AND b.block_date < end_date",
    "GROUP BY block_date ORDER BY block_date",
  ].join("\n");
}

export function feesSql(c: FeesChunk, keep: readonly string[]): string {
  if (c.family === "outcomes") return outcomesSql(c, keep);
  if (c.family === "tx") return txSql(c, keep);
  return blocksSql(c);
}

export const DISCOVERY_COLUMNS = [
  "executor_account_id",
  "tokens_yocto",
  "gas",
  "outcomes",
  "transactions",
  "rank",
];
export const DISCOVERY_ALL = "__all_executors__";

/**
 * Discovery of the Intents footprint on one day: for transactions whose receiver is `intents.near`, every RECEIPT outcome that
 * originated from them (receipt_origin_transaction join, same day only: receipts delayed past midnight are not seen), grouped by
 * executor account: the top 40 by tokens burnt plus one row DISCOVERY_ALL with the total over every executor (so the share of the
 * top 40 is measurable). Transaction outcomes (executor = signer) are not receipts and are not in this join.
 */
export function discoverySql(day: string): string {
  return [
    ...decl(day, addDays(day, 1)),
    "WITH tx AS (",
    "  SELECT t.transaction_hash AS h",
    `  FROM ${T("transactions")} t`,
    "  WHERE t.block_date >= start_date AND t.block_date < end_date AND t.receiver_account_id = 'intents.near'",
    "), o AS (",
    "  SELECT r.originated_from_transaction_hash AS h, x.executor_account_id AS ex, x.tokens_burnt AS tk, x.gas_burnt AS g",
    `  FROM ${T("execution_outcomes")} x JOIN ${T("receipt_origin_transaction")} r ON r.receipt_id = x.receipt_id`,
    "    AND r.block_date >= start_date AND r.block_date < end_date",
    "  WHERE x.block_date >= start_date AND x.block_date < end_date",
    "), gx AS (",
    "  SELECT o.ex AS ex, SUM(CAST(o.tk AS BIGNUMERIC)) AS t, SUM(CAST(o.g AS NUMERIC)) AS g, COUNT(*) AS n, COUNT(DISTINCT o.h) AS txs",
    "  FROM o JOIN tx ON tx.h = o.h GROUP BY ex",
    "), r AS (",
    "  SELECT *, ROW_NUMBER() OVER (ORDER BY t DESC, ex) AS rk FROM gx",
    ")",
    "SELECT ex AS executor_account_id, CAST(t AS STRING) AS tokens_yocto, CAST(g AS STRING) AS gas, n AS outcomes, txs AS transactions, rk AS rank",
    "FROM r WHERE rk <= 40",
    "UNION ALL",
    "SELECT '__all_executors__', CAST(IFNULL(SUM(t), 0) AS STRING), CAST(IFNULL(SUM(g), 0) AS STRING), IFNULL(SUM(n), 0), CAST(NULL AS INT64), CAST(NULL AS INT64)",
    "FROM gx",
    "ORDER BY 6, 1",
  ].join("\n");
}
