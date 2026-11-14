-- nearesis_live: REAL data only. Mirrors the normalized fact schemas of the fixture database (ReplacingMergeTree(version)),
-- but every row defaults to source_label = 'LIVE' and carries fetched_at. Gaps stay gaps: nothing is zero-filled.
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
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(created_day)
ORDER BY swap_key;

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
  -- how the daily open/high/low/close were obtained; the free plan has no daily OHLC history
  basis LowCardinality(String),
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(day)
ORDER BY (provider, coin_id, quote_currency, `interval`, bucket_start, update_vintage);

-- BigQuery daily transactions. tx_count counts every row of crypto_near_mainnet_us.transactions for the day.
-- The table's status column only ever carries SUCCESS_RECEIPT_ID (conversion status), so successful vs failed cannot be
-- derived: successful_tx_count is deliberately absent from this table. distinct_signer_proxy is NOT summable across days.
CREATE TABLE IF NOT EXISTS near_daily_tx
(
  block_date Date,
  tx_count UInt64,
  distinct_signer_proxy UInt64,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY block_date;

-- Function-call receivers at or above the documented threshold (receiver-day interactions >= 100).
CREATE TABLE IF NOT EXISTS contract_interactions
(
  block_date Date,
  receiver_account_id String,
  project Nullable(String),
  taxonomy String,
  segment_state LowCardinality(String),
  interactions UInt64,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY (block_date, receiver_account_id);

-- Exact per-day remainder: receivers below the threshold, aggregated (count of receivers and their interactions).
CREATE TABLE IF NOT EXISTS contract_interactions_below_threshold
(
  block_date Date,
  receiver_count UInt64,
  interactions UInt64,
  threshold UInt32,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY block_date;

CREATE TABLE IF NOT EXISTS source_coverage
(
  provider_id LowCardinality(String),
  dataset LowCardinality(String),
  day Date,
  state LowCardinality(String),
  reason Nullable(String),
  source_label LowCardinality(String) DEFAULT 'LIVE',
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(day)
ORDER BY (provider_id, dataset, day);

CREATE TABLE IF NOT EXISTS quality_gaps
(
  provider_id LowCardinality(String),
  dataset LowCardinality(String),
  from_utc DateTime64(3, 'UTC'),
  to_utc DateTime64(3, 'UTC'),
  state LowCardinality(String),
  reason_code String,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(from_utc)
ORDER BY (provider_id, dataset, from_utc, to_utc, reason_code);

-- Per-day view joining the transaction and receiver families. Receiver-derived columns are NULL (never 0) for days whose
-- receiver chunk has not been loaded yet.
CREATE VIEW IF NOT EXISTS near_daily_usage AS
SELECT
  t.block_date AS block_date,
  t.tx_count AS tx_count,
  t.distinct_signer_proxy AS distinct_signer_proxy,
  if(b.block_date = toDate(0), NULL, b.interactions + coalesce(r.fc, 0)) AS function_call_actions,
  if(b.block_date = toDate(0), NULL, b.receiver_count + coalesce(r.n, 0)) AS active_contract_count,
  t.source_label AS source_label
FROM (SELECT * FROM near_daily_tx FINAL) AS t
LEFT JOIN (SELECT * FROM contract_interactions_below_threshold FINAL) AS b ON b.block_date = t.block_date
LEFT JOIN
(
  SELECT block_date, sum(interactions) AS fc, count() AS n FROM contract_interactions FINAL GROUP BY block_date
) AS r ON r.block_date = t.block_date;
