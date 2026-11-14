-- Coverage state (S11): a day with no rows is a confirmed zero only when the matching coverage row says complete.
CREATE TABLE IF NOT EXISTS source_coverage
(
  provider_id LowCardinality(String),
  dataset LowCardinality(String),
  day Date,
  state LowCardinality(String),
  reason Nullable(String),
  source_label LowCardinality(String),
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
  source_label LowCardinality(String),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(from_utc)
ORDER BY (provider_id, dataset, from_utc, to_utc, reason_code);

CREATE TABLE IF NOT EXISTS source_watermarks
(
  provider_id LowCardinality(String),
  newest_event_time Nullable(DateTime64(3, 'UTC')),
  last_full_scan_at Nullable(DateTime64(3, 'UTC')),
  gap_count UInt32,
  provider_lag_seconds Nullable(Float64),
  schema_version Nullable(String),
  state LowCardinality(String),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY provider_id;

CREATE TABLE IF NOT EXISTS asset_aliases
(
  canonical_asset_id String,
  provider_asset_id String,
  provider_id String,
  valid_from DateTime64(3, 'UTC'),
  valid_to Nullable(DateTime64(3, 'UTC')),
  evidence_url Nullable(String),
  verification LowCardinality(String),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (provider_id, provider_asset_id, valid_from);

CREATE TABLE IF NOT EXISTS contract_registry
(
  chain String,
  account_id String,
  project String,
  taxonomy String,
  valid_from DateTime64(3, 'UTC'),
  valid_to Nullable(DateTime64(3, 'UTC')),
  ownership_verification LowCardinality(String),
  evidence_url Nullable(String),
  ambiguity_score Float64,
  row_state LowCardinality(String),
  conflict_group Nullable(String),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (chain, account_id, valid_from);
