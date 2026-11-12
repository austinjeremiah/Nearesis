import type { ClickHouseClient } from "@clickhouse/client";

/**
 * ClickHouse schema for NEAR transaction economics (nearesis_live). Idempotent CREATE ... IF NOT EXISTS, applied by
 * migrateEconomics(). Integer units only: gas in gas units (UInt128), tokens in yoctoNEAR (UInt256); no Float anywhere.
 * `token_precision = 'source_float64'`: the public BigQuery dataset stores tokens_burnt as FLOAT64, so each source value
 * carries a relative error <= 2^-53; aggregation here is exact on the stored doubles (see docs/economics/SEMANTICS.md).
 */
const PROV = `
  token_precision LowCardinality(String),
  rule_version UInt16,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64`;

export const ECONOMICS_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS near_economics_outcomes_daily
(
  block_date Date,
  executor_account_id String,
  outcome_kind LowCardinality(String),
  status_class LowCardinality(String),
  outcomes UInt64,
  gas_burnt UInt128,
  tokens_burnt_yocto UInt256,
  fractional_gas_rows UInt64,
  zero_token_rows UInt64,
  duplicate_receipt_rows UInt64,${PROV}
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY (block_date, executor_account_id, outcome_kind, status_class)`,
  `CREATE TABLE IF NOT EXISTS near_economics_tx_daily
(
  block_date Date,
  txs UInt64,
  receipts UInt64,
  txs_with_failed_receipt UInt64,
  txs_without_receipt_rows UInt64,
  conversion_gas UInt128,
  conversion_tokens_yocto UInt256,
  receipt_gas UInt128,
  receipt_tokens_yocto UInt256,
  total_gas UInt128,
  total_tokens_yocto UInt256,
  max_gas UInt128,
  max_tokens_yocto UInt256,
  tokens_p50 UInt256, tokens_p90 UInt256, tokens_p99 UInt256, tokens_p999 UInt256,
  gas_p50 UInt128, gas_p90 UInt128, gas_p99 UInt128, gas_p999 UInt128,
  percentile_method LowCardinality(String),${PROV}
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY block_date`,
  `CREATE TABLE IF NOT EXISTS near_economics_tx_receiver_daily
(
  block_date Date,
  receiver_account_id String,
  txs UInt64,
  receipts UInt64,
  txs_with_failed_receipt UInt64,
  txs_without_receipt_rows UInt64,
  conversion_gas UInt128,
  conversion_tokens_yocto UInt256,
  receipt_gas UInt128,
  receipt_tokens_yocto UInt256,
  total_gas UInt128,
  total_tokens_yocto UInt256,
  max_gas UInt128,
  max_tokens_yocto UInt256,${PROV}
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY (block_date, receiver_account_id)`,
  `CREATE TABLE IF NOT EXISTS near_economics_top_tx
(
  block_date Date,
  rank UInt16,
  transaction_hash String,
  signer_account_id String,
  receiver_account_id String,
  gas_burnt UInt128,
  tokens_burnt_yocto UInt256,
  receipts UInt64,${PROV}
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY (block_date, rank)`,
  `CREATE TABLE IF NOT EXISTS near_economics_gas_price_daily
(
  block_date Date,
  blocks UInt64,
  min_gas_price_yocto UInt64,
  max_gas_price_yocto UInt64,
  sum_gas_price_yocto UInt128,
  fractional_price_rows UInt64,
  null_price_rows UInt64,
  distinct_prices UInt64,
  rule_version UInt16,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY block_date`,
];

export const ECONOMICS_TABLE_NAMES = [
  "near_economics_outcomes_daily",
  "near_economics_tx_daily",
  "near_economics_tx_receiver_daily",
  "near_economics_top_tx",
  "near_economics_gas_price_daily",
] as const;

export async function migrateEconomics(ch: ClickHouseClient): Promise<void> {
  for (const q of ECONOMICS_TABLES) await ch.command({ query: q });
}
