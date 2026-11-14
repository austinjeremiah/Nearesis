-- Freshness per provider for the LIVE layer (read by the semantic gateway as `source_watermarks`).
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
