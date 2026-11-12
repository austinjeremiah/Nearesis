-- receipt_count / receiver_rcpt are NULL (never 0) when the source mode does not fetch receipts (RPC tx-only mode).
-- Near-real-time NEAR feed (forward-only, `final` blocks from FastNEAR neardata). BigQuery daily loads stay the historical authority;
-- rt_reconciliation compares each fully covered UTC day against near_daily_tx once BigQuery has landed it.
-- state: 'final' = block/minute built only from final-finality blocks that cannot reorg; 'provisional' = a minute still accumulating
-- (its totals are partial) or a block that was observed before finality. Provisional rows are never reported as finalized.
CREATE TABLE IF NOT EXISTS rt_blocks
(
  height UInt64,
  block_hash String,
  prev_hash String,
  prev_height UInt64,
  block_ts DateTime64(3, 'UTC'),
  state LowCardinality(String),
  provider LowCardinality(String),
  tx_count UInt32,
  receipt_count Nullable(UInt32),
  gas_burnt UInt128,
  tokens_burnt_yocto UInt256,
  signer_count UInt32,
  chunks_included UInt16,
  observed_at DateTime64(3, 'UTC'),
  ingested_at DateTime64(3, 'UTC'),
  signers Array(String) TTL toDateTime(block_ts) + INTERVAL 3 DAY,
  receiver_ids Array(String) TTL toDateTime(block_ts) + INTERVAL 3 DAY,
  receiver_tx Array(UInt32) TTL toDateTime(block_ts) + INTERVAL 3 DAY,
  receiver_rcpt Array(Nullable(UInt32)) TTL toDateTime(block_ts) + INTERVAL 3 DAY,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMMDD(block_ts)
ORDER BY height;

CREATE TABLE IF NOT EXISTS rt_minutes
(
  minute DateTime('UTC'),
  state LowCardinality(String),
  complete UInt8,
  block_count UInt32,
  first_height UInt64,
  last_height UInt64,
  tx_count UInt64,
  receipt_count Nullable(UInt64),
  gas_burnt UInt128,
  tokens_burnt_yocto UInt256,
  active_signers UInt32,
  provider LowCardinality(String),
  computed_at DateTime64(3, 'UTC'),
  source_label LowCardinality(String) DEFAULT 'LIVE',
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(minute)
ORDER BY minute;

-- Top receivers per minute by tx_count (rank <= 100); `other_*` rows are not stored, totals live in rt_minutes.
CREATE TABLE IF NOT EXISTS rt_minute_receivers
(
  minute DateTime('UTC'),
  receiver_id String,
  tx_count UInt64,
  receipt_count Nullable(UInt64),
  state LowCardinality(String),
  source_label LowCardinality(String) DEFAULT 'LIVE',
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(minute)
ORDER BY (minute, receiver_id);

CREATE TABLE IF NOT EXISTS rt_watermark
(
  feed_id LowCardinality(String),
  provider LowCardinality(String),
  height UInt64,
  block_hash String,
  block_ts DateTime64(3, 'UTC'),
  head_height UInt64,
  observed_at DateTime64(3, 'UTC'),
  ingested_at DateTime64(3, 'UTC'),
  lag_seconds Float64,
  finality LowCardinality(String),
  first_height UInt64,
  first_block_ts DateTime64(3, 'UTC'),
  skipped_heights UInt64,
  state LowCardinality(String),
  source_label LowCardinality(String) DEFAULT 'LIVE',
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY feed_id;

CREATE TABLE IF NOT EXISTS rt_anomalies
(
  at DateTime64(3, 'UTC'),
  feed_id LowCardinality(String),
  kind LowCardinality(String),
  height UInt64,
  detail String,
  source_label LowCardinality(String) DEFAULT 'LIVE'
)
ENGINE = MergeTree
ORDER BY (at, kind);

CREATE TABLE IF NOT EXISTS rt_reconciliation
(
  day Date,
  status LowCardinality(String),
  bq_tx_count Nullable(UInt64),
  rt_tx_count UInt64,
  diff Nullable(Int64),
  diff_pct Nullable(Float64),
  rt_blocks UInt32,
  rt_contiguous UInt8,
  note String,
  checked_at DateTime64(3, 'UTC'),
  source_label LowCardinality(String) DEFAULT 'LIVE',
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY day;
