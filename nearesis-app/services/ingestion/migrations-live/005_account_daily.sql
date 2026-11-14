-- Account-level daily activity for the organic target (ch.08: exclude Intents-verifier and bridge generated actions).
-- Stored minimally: exact per-day aggregates plus named rows only for heavy signers; the long tail is never stored per account.
-- account_rule_version identifies the documented flag rule (receiver lists) in services/ingestion/src/backfill/account-sql.ts.
-- Gaps stay gaps: a day with no row is unavailable, never zero.
CREATE TABLE IF NOT EXISTS account_daily_activity
(
  block_date Date,
  tx_total UInt64,
  tx_intents UInt64,
  tx_bridge UInt64,
  tx_organic UInt64,
  signers_total UInt64,
  signers_organic UInt64,
  signers_with_intents UInt64,
  top1pct_signer_count UInt64,
  top5pct_signer_count UInt64,
  top1pct_organic_tx UInt64,
  top5pct_organic_tx UInt64,
  account_rule_version UInt16,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY block_date;

-- Heavy signers only (>= heavy_threshold transactions that day). intents_generated = intents+bridge transactions are the majority.
CREATE TABLE IF NOT EXISTS account_daily_heavy_signers
(
  block_date Date,
  signer_account_id String,
  tx_total UInt64,
  tx_intents UInt64,
  tx_bridge UInt64,
  intents_generated UInt8,
  heavy_threshold UInt32,
  account_rule_version UInt16,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY (block_date, signer_account_id);
