-- Dry 1Click quote samples (ch.07 grid). Every attempt is one row: observed (with a class) or unavailable (never attempted,
-- with the reason). dry is always 1; nothing here ever comes from a swap or a deposit. Failures are rows, not omissions.
CREATE TABLE IF NOT EXISTS quote_attempts
(
  route_id String,
  origin_asset String,
  destination_asset String,
  origin_chain LowCardinality(String),
  destination_chain LowCardinality(String),
  notional_usd UInt32,
  amount_base_units String,
  privacy_mode LowCardinality(String),
  scheduled_bucket_utc DateTime64(3, 'UTC'),
  attempt_no UInt16,
  slot LowCardinality(String),
  class LowCardinality(Nullable(String)),
  reason Nullable(String),
  http_status Nullable(UInt16),
  amount_out_base_units Nullable(String),
  amount_in_usd Nullable(Decimal256(18)),
  amount_out_usd Nullable(Decimal256(18)),
  time_estimate_s Nullable(Float64),
  quote_timestamp Nullable(DateTime64(3, 'UTC')),
  latency_ms Nullable(UInt32),
  fetched_at Nullable(DateTime64(3, 'UTC')),
  raw_object_hash Nullable(String),
  dry UInt8 DEFAULT 1,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(scheduled_bucket_utc)
ORDER BY (route_id, amount_base_units, privacy_mode, scheduled_bucket_utc, attempt_no);
