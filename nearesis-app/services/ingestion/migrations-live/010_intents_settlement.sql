-- NEAR Intents settlement duration pilot (owner-approved 7-day BigQuery pilot). Block times of the swaps' NEAR transactions
-- come from bigquery-public-data transactions; swaps whose hashes are not all found are stored with complete = 0 and NULL
-- durations, never zero-filled. Durations may be negative (block time before Explorer createdAt) and are kept as measured.
CREATE TABLE IF NOT EXISTS intents_settlement_tx_times
(
  tx_hash String,
  block_ts_ns UInt64,
  window_id String,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY tx_hash;

CREATE TABLE IF NOT EXISTS intents_settlement_durations
(
  swap_key String,
  window_id String,
  status LowCardinality(String),
  created_at DateTime64(3, 'UTC'),
  created_day Date,
  origin_chain LowCardinality(String),
  n_hashes UInt16,
  n_found UInt16,
  complete UInt8,
  first_listed_ms Nullable(Int64),
  last_listed_ms Nullable(Int64),
  min_ms Nullable(Int64),
  max_ms Nullable(Int64),
  max_hash_index Nullable(UInt16),
  settlement_ms Nullable(Int64),
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(created_day)
ORDER BY swap_key;
