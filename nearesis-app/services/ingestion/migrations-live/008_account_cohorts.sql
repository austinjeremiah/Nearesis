-- Per-signer account and cohort datasets (A23): one BigQuery scan of transactions (block_date, signer_account_id,
-- receiver_account_id) loaded into these tables. See services/ingestion/src/accounts/sql.ts for exact semantics.
-- Accounts are NOT people. "New" means first organic transaction SEEN SINCE window_start, not lifetime first-seen.
-- Organic = not an Intents verifier receiver and not a bridge/omni receiver (account_rule_version).
-- A day without a row is unavailable, never zero (source_coverage carries one row per day per dataset).

-- Head signers: organic transactions of every signer with at least head_threshold organic transactions that day.
CREATE TABLE IF NOT EXISTS account_daily_head
(
  block_date Date,
  signer_account_id String,
  tx_organic UInt64,
  head_threshold UInt32,
  account_rule_version UInt16,
  window_start Date,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY (block_date, signer_account_id);

-- Exact per-day remainder of organic signers below the head threshold: head + tail = organic day total.
CREATE TABLE IF NOT EXISTS account_daily_tail
(
  block_date Date,
  tail_signers UInt64,
  tail_tx UInt64,
  head_threshold UInt32,
  account_rule_version UInt16,
  window_start Date,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY block_date;

-- Exact distinct signers and transactions per registry entity bucket and day. entity_bucket is an entity_id, or one of
-- __unclassified__ / __unverified__ / __ambiguous__. A signer using several buckets in a day is counted in each: not additive.
CREATE TABLE IF NOT EXISTS entity_daily_signers
(
  block_date Date,
  entity_bucket String,
  signers_all UInt64,
  tx_all UInt64,
  signers_organic UInt64,
  tx_organic UInt64,
  registry_version String,
  account_rule_version UInt16,
  window_start Date,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY (block_date, entity_bucket);

-- Daily active organic signers, new (first organic day since window_start) and returning, concentration and the day totals.
CREATE TABLE IF NOT EXISTS account_daily_new_returning
(
  block_date Date,
  signers_all UInt64,
  tx_all UInt64,
  tx_intents UInt64,
  tx_bridge UInt64,
  signers_with_intents UInt64,
  signers_organic UInt64,
  tx_organic UInt64,
  new_signers UInt64,
  returning_signers UInt64,
  new_tx UInt64,
  returning_tx UInt64,
  top10_tx UInt64,
  top1pct_signer_count UInt64,
  top1pct_tx UInt64,
  top5pct_signer_count UInt64,
  top5pct_tx UInt64,
  account_rule_version UInt16,
  window_start Date,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(block_date)
ORDER BY block_date;

-- Retention by first-seen week (Monday) within the window: distinct cohort signers active in each later week.
CREATE TABLE IF NOT EXISTS account_cohort_week_retention
(
  cohort_week Date,
  active_week Date,
  signers UInt64,
  account_rule_version UInt16,
  window_start Date,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (cohort_week, active_week);

-- First/last seen and frequency inside the window for every signer that was a head signer at least once.
CREATE TABLE IF NOT EXISTS account_head_profile
(
  signer_account_id String,
  first_seen_in_window Date,
  last_seen_in_window Date,
  active_days UInt32,
  tx_organic UInt64,
  head_days UInt32,
  account_rule_version UInt16,
  window_start Date,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY signer_account_id;
