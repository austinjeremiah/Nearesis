import { IngestionError } from "../errors.ts";
import { NEAR_DATASET } from "../adapters/bigquery-guard.ts";
import { addDays, monthRanges, WINDOW_FROM, WINDOW_TO } from "../backfill/plan.ts";

/**
 * NEAR transaction economics: BigQuery SQL (A18). Version the rules together with the SQL; a change needs a reload.
 *
 * Source semantics (docs/economics/SEMANTICS.md):
 *  - gas_burnt is gas UNITS (INT-valued FLOAT64 <= 3e14, exact in FLOAT64). tokens_burnt is yoctoNEAR stored as FLOAT64 in the
 *    public dataset: it is NOT exact above 2^53 yocto. We cast the stored double to BIGNUMERIC (exact conversion of the
 *    double's value) and sum in BIGNUMERIC, so aggregation adds no further error; the source-level error bound is
 *    carried to the metrics layer (relative 2^-53 per value).
 *  - execution_outcomes has one row per transaction outcome AND per receipt outcome. Rows without a receipt_details row are
 *    transaction outcomes (or receipts outside the join window): kind NO_RECEIPT_ROW. Refund receipts have predecessor
 *    'system' and report gas but burn no tokens.
 *  - Large integers leave BigQuery as STRING (never FLOAT64/INT64 sums that could overflow).
 */
export const ECONOMICS_RULE_VERSION = 1;
/** Named executor / receiver rows need at least this many outcomes (or transactions) in a day; the rest fold, totals exact. */
export const ECONOMICS_FOLD_THRESHOLD = 100;
export const FOLDED_ACCOUNT = "__below_threshold__";
export const TOP_TX_PER_DAY = 20;
/** Receipts of a transaction can execute after the transaction's own day; the tx-cost query looks this many days ahead. */
export const RECEIPT_LOOKAHEAD_DAYS = 2;
/** Quantile resolution of APPROX_QUANTILES (1000 -> permille offsets); the result is approximate and labelled so. */
export const QUANTILE_BUCKETS = 1000;

export type EconomicsFamily = "outcomes" | "tx_cost" | "gas_price";
export const ECONOMICS_FAMILIES: readonly EconomicsFamily[] = ["outcomes", "tx_cost", "gas_price"];

export interface EconomicsChunk {
  id: string; // `${family}:${from}`
  family: EconomicsFamily;
  from: string; // inclusive
  to: string; // exclusive
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const need = (d: string): string => {
  if (!DAY_RE.test(d))
    throw new IngestionError("INVALID_INPUT", false, { reason: "date must be YYYY-MM-DD" });
  return d;
};
const T = (t: string): string => `\`bigquery-public-data.${NEAR_DATASET}.${t}\``;
const win = (col: string, from: string, to: string): string =>
  `${col} >= DATE '${need(from)}' AND ${col} < DATE '${need(to)}'`;

/** Newest month first (recent data is the most valuable if quota runs out); gas_price (tiny) before the big families. */
export function planEconomicsChunks(
  from = WINDOW_FROM,
  to = WINDOW_TO,
  families: readonly EconomicsFamily[] = ECONOMICS_FAMILIES,
): EconomicsChunk[] {
  const months = monthRanges(from, to).reverse();
  const out: EconomicsChunk[] = [];
  for (const family of families)
    for (const m of months) out.push({ id: `${family}:${m.from}`, family, from: m.from, to: m.to });
  return out;
}

/** Splits a chunk at its midpoint day (>= 1 day each); null when it is a single day. Used when a month exceeds one quota day. */
export function splitChunk(c: EconomicsChunk): [EconomicsChunk, EconomicsChunk] | null {
  const days: string[] = [];
  for (let d = c.from; d < c.to; d = addDays(d, 1)) days.push(d);
  if (days.length < 2) return null;
  const mid = days[Math.floor(days.length / 2)] as string;
  return [
    { ...c, id: `${c.family}:${c.from}`, to: mid },
    { ...c, id: `${c.family}:${mid}`, from: mid },
  ];
}

/**
 * Per (day, executor account, outcome kind, status class): outcome count, gas units, tokens (yoctoNEAR as exact STRING of the
 * stored double). Executors under the fold threshold are folded into FOLDED_ACCOUNT with exact totals. execution_outcomes is
 * scanned once; receipt_details contributes only receipt_id, predecessor and kind (no `receipt` JSON column).
 */
export function outcomesSql(c: Pick<EconomicsChunk, "from" | "to">): string {
  return [
    "WITH det AS (",
    "  SELECT d.receipt_id AS receipt_id, MIN(d.predecessor_account_id) AS pred, MIN(d.receipt_kind) AS kind, COUNT(*) AS c",
    `  FROM ${T("receipt_details")} d`,
    `  WHERE ${win("d.block_date", c.from, c.to)}`,
    "  GROUP BY d.receipt_id",
    "), o AS (",
    "  SELECT x.block_date AS block_date, x.executor_account_id AS executor,",
    "    CASE WHEN d.receipt_id IS NULL THEN 'NO_RECEIPT_ROW'",
    "      WHEN d.pred = 'system' THEN 'REFUND'",
    "      WHEN d.kind = 'ACTION' THEN 'ACTION'",
    "      ELSE 'DATA' END AS outcome_kind,",
    "    CASE WHEN STARTS_WITH(x.status, 'SUCCESS') THEN 'SUCCESS' WHEN x.status = 'FAILURE' THEN 'FAILURE' ELSE 'OTHER' END AS status_class,",
    "    CAST(x.gas_burnt AS NUMERIC) AS g, CAST(x.tokens_burnt AS BIGNUMERIC) AS t,",
    "    x.gas_burnt != FLOOR(x.gas_burnt) AS frac, IFNULL(d.c, 1) - 1 AS dup",
    `  FROM ${T("execution_outcomes")} x LEFT JOIN det d ON d.receipt_id = x.receipt_id`,
    `  WHERE ${win("x.block_date", c.from, c.to)}`,
    "), a AS (",
    "  SELECT block_date, executor, outcome_kind, status_class, COUNT(*) AS n, SUM(g) AS g, SUM(t) AS t,",
    "    COUNTIF(frac) AS frac_rows, COUNTIF(t = 0) AS zero_token_rows, SUM(dup) AS dup_rows",
    "  FROM o GROUP BY block_date, executor, outcome_kind, status_class",
    "), f AS (",
    `  SELECT *, IF(SUM(n) OVER (PARTITION BY block_date, executor) >= ${ECONOMICS_FOLD_THRESHOLD}, executor, '${FOLDED_ACCOUNT}') AS ex`,
    "  FROM a",
    ")",
    "SELECT block_date, ex AS executor_account_id, outcome_kind, status_class, SUM(n) AS outcomes,",
    "  CAST(SUM(g) AS STRING) AS gas_burnt, CAST(SUM(t) AS STRING) AS tokens_burnt_yocto,",
    "  SUM(frac_rows) AS fractional_gas_rows, SUM(zero_token_rows) AS zero_token_rows, SUM(dup_rows) AS duplicate_receipt_rows",
    "FROM f GROUP BY block_date, ex, outcome_kind, status_class",
    "ORDER BY 1, 2, 3, 4",
  ].join("\n");
}

/**
 * Per-transaction cost = transaction->receipt conversion burn (transactions table) + every receipt outcome that originated
 * from the transaction (receipt_origin_transaction), looking RECEIPT_LOOKAHEAD_DAYS ahead for delayed receipts.
 * kind 'day' | 'receiver' | 'top_tx'. Percentiles are APPROX_QUANTILES (labelled approximate). Receipt gas here is every
 * reported outcome gas incl. refund-receipt executions (reported_gas); tokens are unaffected by that (refunds burn none).
 */
export function txCostSql(c: Pick<EconomicsChunk, "from" | "to">): string {
  const tail = addDays(need(c.to), RECEIPT_LOOKAHEAD_DAYS);
  const q = (col: string, k: number): string =>
    `CAST(APPROX_QUANTILES(${col}, ${QUANTILE_BUCKETS})[OFFSET(${k})] AS STRING)`;
  return [
    "WITH tx AS (",
    "  SELECT t.block_date AS block_date, t.transaction_hash AS h, t.signer_account_id AS signer, t.receiver_account_id AS receiver,",
    "    CAST(t.receipt_conversion_gas_burnt AS NUMERIC) AS g0, CAST(t.receipt_conversion_tokens_burnt AS BIGNUMERIC) AS t0",
    `  FROM ${T("transactions")} t`,
    `  WHERE ${win("t.block_date", c.from, c.to)}`,
    "), rc AS (",
    "  SELECT r.originated_from_transaction_hash AS h, COUNT(*) AS n, SUM(CAST(x.gas_burnt AS NUMERIC)) AS g,",
    "    SUM(CAST(x.tokens_burnt AS BIGNUMERIC)) AS t, COUNTIF(x.status = 'FAILURE') AS nf",
    `  FROM ${T("execution_outcomes")} x JOIN ${T("receipt_origin_transaction")} r ON r.receipt_id = x.receipt_id`,
    `    AND ${win("r.block_date", c.from, tail)}`,
    `  WHERE ${win("x.block_date", c.from, tail)}`,
    "  GROUP BY h",
    "), p AS (",
    "  SELECT tx.block_date, tx.h, tx.signer, tx.receiver, tx.g0, tx.t0, IFNULL(rc.n, 0) AS n, IFNULL(rc.g, 0) AS rg,",
    "    IFNULL(rc.t, 0) AS rt, IFNULL(rc.nf, 0) AS nf, rc.h IS NULL AS no_receipts,",
    "    tx.g0 + IFNULL(rc.g, 0) AS g, tx.t0 + IFNULL(rc.t, 0) AS t",
    "  FROM tx LEFT JOIN rc ON rc.h = tx.h",
    "), dayagg AS (",
    "  SELECT 'day' AS kind, block_date, CAST(NULL AS STRING) AS account, CAST(NULL AS STRING) AS tx_hash, CAST(NULL AS STRING) AS signer_id,",
    "    COUNT(*) AS txs, SUM(n) AS receipts, COUNTIF(nf > 0) AS txs_with_failed_receipt, COUNTIF(no_receipts) AS txs_without_receipt_rows,",
    "    CAST(SUM(g0) AS STRING) AS conversion_gas, CAST(SUM(t0) AS STRING) AS conversion_tokens_yocto,",
    "    CAST(SUM(rg) AS STRING) AS receipt_gas, CAST(SUM(rt) AS STRING) AS receipt_tokens_yocto,",
    "    CAST(SUM(g) AS STRING) AS total_gas, CAST(SUM(t) AS STRING) AS total_tokens_yocto,",
    "    CAST(MAX(g) AS STRING) AS max_gas, CAST(MAX(t) AS STRING) AS max_tokens_yocto,",
    `    ${q("t", 500)} AS tokens_p50, ${q("t", 900)} AS tokens_p90, ${q("t", 990)} AS tokens_p99, ${q("t", 999)} AS tokens_p999,`,
    `    ${q("g", 500)} AS gas_p50, ${q("g", 900)} AS gas_p90, ${q("g", 990)} AS gas_p99, ${q("g", 999)} AS gas_p999,`,
    "    CAST(NULL AS STRING) AS tx_gas, CAST(NULL AS STRING) AS tx_tokens_yocto, CAST(NULL AS INT64) AS tx_receipts",
    "  FROM p GROUP BY block_date",
    "), recv AS (",
    "  SELECT block_date, IF(SUM(1) OVER (PARTITION BY block_date, receiver) >= " +
      `${ECONOMICS_FOLD_THRESHOLD}, receiver, '${FOLDED_ACCOUNT}') AS account, g0, t0, n, rg, rt, nf, no_receipts, g, t FROM p`,
    "), recvagg AS (",
    "  SELECT 'receiver', block_date, account, CAST(NULL AS STRING), CAST(NULL AS STRING),",
    "    COUNT(*), SUM(n), COUNTIF(nf > 0), COUNTIF(no_receipts),",
    "    CAST(SUM(g0) AS STRING), CAST(SUM(t0) AS STRING), CAST(SUM(rg) AS STRING), CAST(SUM(rt) AS STRING),",
    "    CAST(SUM(g) AS STRING), CAST(SUM(t) AS STRING), CAST(MAX(g) AS STRING), CAST(MAX(t) AS STRING),",
    "    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),",
    "    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),",
    "    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS INT64)",
    "  FROM recv GROUP BY block_date, account",
    "), ranked AS (",
    "  SELECT p.*, ROW_NUMBER() OVER (PARTITION BY block_date ORDER BY t DESC, h) AS rk FROM p",
    "), topagg AS (",
    "  SELECT 'top_tx', block_date, receiver, h, signer,",
    "    CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64),",
    "    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),",
    "    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),",
    "    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),",
    "    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),",
    "    CAST(g AS STRING), CAST(t AS STRING), n",
    `  FROM ranked WHERE rk <= ${TOP_TX_PER_DAY}`,
    ")",
    "SELECT * FROM dayagg UNION ALL SELECT * FROM recvagg UNION ALL SELECT * FROM topagg",
    "ORDER BY 1, 2, 3, 4",
  ].join("\n");
}

/** blocks.gas_price (yoctoNEAR per gas, FLOAT64 integer-valued) per day: exact sum and extremes. */
export function gasPriceSql(c: Pick<EconomicsChunk, "from" | "to">): string {
  return [
    "SELECT block_date, COUNT(*) AS blocks, MIN(gas_price) AS min_gas_price, MAX(gas_price) AS max_gas_price,",
    "  CAST(SUM(CAST(gas_price AS NUMERIC)) AS STRING) AS sum_gas_price, COUNTIF(gas_price != FLOOR(gas_price)) AS fractional_price_rows,",
    "  COUNTIF(gas_price IS NULL) AS null_price_rows, COUNT(DISTINCT gas_price) AS distinct_prices",
    `FROM ${T("blocks")}`,
    `WHERE ${win("block_date", c.from, c.to)}`,
    "GROUP BY block_date ORDER BY block_date",
  ].join("\n");
}

export function economicsSql(c: EconomicsChunk): string {
  return c.family === "outcomes" ? outcomesSql(c) : c.family === "tx_cost" ? txCostSql(c) : gasPriceSql(c);
}
