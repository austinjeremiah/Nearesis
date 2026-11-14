-- Normalized fact tables (ch.07). ReplacingMergeTree(version); reads use FINAL / argMax so results do not depend on merge timing.
-- Exact amounts: Decimal256(S) plus the source string (S15). Missing data is never a zero row: see source_coverage.
CREATE TABLE IF NOT EXISTS intents_swaps
(
  swap_key String,
  deposit_address String,
  deposit_memo Nullable(String),
  status LowCardinality(String),
  created_at DateTime64(3, 'UTC'),
  created_day Date,
  origin_asset String,
  destination_asset String,
  canonical_origin_asset Nullable(String),
  canonical_destination_asset Nullable(String),
  amount_in_raw String,
  amount_out_raw String,
  amount_in Decimal256(0),
  amount_out Decimal256(0),
  amount_final UInt8,
  amount_in_usd_raw Nullable(String),
  amount_out_usd_raw Nullable(String),
  amount_in_usd Nullable(Decimal256(18)),
  amount_out_usd Nullable(Decimal256(18)),
  deposit_type String,
  recipient_type String,
  referral Nullable(String),
  privacy_era LowCardinality(String),
  public_swap_tx_hashes Array(String),
  boundary_tx_hashes Array(String),
  reconciliation_level LowCardinality(String),
  source_label LowCardinality(String),
  raw_object_hash String,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(created_day)
ORDER BY swap_key;

CREATE TABLE IF NOT EXISTS quote_attempts
(
  route_id String,
  origin_asset String,
  destination_asset String,
  amount_base_units_raw String,
  amount_base_units Decimal256(0),
  privacy_mode LowCardinality(String),
  scheduled_bucket DateTime64(3, 'UTC'),
  day Date,
  attempt_no UInt32,
  slot LowCardinality(String),
  attempt_class LowCardinality(Nullable(String)),
  amount_out_raw Nullable(String),
  amount_out Nullable(Decimal256(0)),
  fetched_at Nullable(DateTime64(3, 'UTC')),
  quote_cost_bps_raw Nullable(String),
  quote_cost_bps Nullable(Decimal256(18)),
  source_label LowCardinality(String),
  raw_object_hash String,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(day)
ORDER BY (route_id, amount_base_units_raw, privacy_mode, scheduled_bucket, attempt_no);

CREATE TABLE IF NOT EXISTS price_candles
(
  provider LowCardinality(String),
  coin_id String,
  symbol String,
  quote_currency LowCardinality(String),
  `interval` LowCardinality(String),
  bucket_start DateTime64(3, 'UTC'),
  day Date,
  open_raw String,
  high_raw String,
  low_raw String,
  close_raw String,
  volume_raw Nullable(String),
  open Decimal256(18),
  high Decimal256(18),
  low Decimal256(18),
  close Decimal256(18),
  volume Nullable(Decimal256(18)),
  provider_timestamp DateTime64(3, 'UTC'),
  fetched_at DateTime64(3, 'UTC'),
  update_vintage DateTime64(3, 'UTC'),
  source_label LowCardinality(String),
  raw_object_hash String,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(day)
ORDER BY (provider, coin_id, quote_currency, `interval`, bucket_start, update_vintage);

CREATE TABLE IF NOT EXISTS near_daily_usage
(
  block_date Date,
  successful_tx_count UInt64,
  function_call_actions UInt64,
  distinct_signer_proxy UInt64,
  active_contract_count UInt64,
  source_label LowCardinality(String),
  raw_object_hash String,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY block_date;

CREATE TABLE IF NOT EXISTS near_signer_days
(
  block_date Date,
  signer_account_id String,
  source_label LowCardinality(String),
  raw_object_hash String,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY (block_date, signer_account_id);

CREATE TABLE IF NOT EXISTS contract_interactions
(
  block_date Date,
  receiver_account_id String,
  project Nullable(String),
  taxonomy String,
  segment_state LowCardinality(String),
  interactions UInt64,
  source_label LowCardinality(String),
  raw_object_hash String,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY (block_date, receiver_account_id);

-- Non-NormalizedOutput fact tables owned by the analytics layer (economics and agent-market reports are loaded by their own jobs).
CREATE TABLE IF NOT EXISTS economics_reports
(
  report_day Date,
  report_source String,
  revenue_usd_raw String,
  revenue_usd Decimal256(18),
  source_label LowCardinality(String),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(report_day)
ORDER BY (report_day, report_source);

CREATE TABLE IF NOT EXISTS agent_market_jobs
(
  job_day Date,
  market String,
  completed_jobs UInt64,
  is_public UInt8,
  source_label LowCardinality(String),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(job_day)
ORDER BY (job_day, market);
