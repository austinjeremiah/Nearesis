-- Refund causes of Explorer swaps (additive side table keyed by swap_key; intents_swaps itself is unchanged).
-- Source: the Explorer item's refundReason / refundTo / refundFee / refundFeeFormatted / refundType, copied verbatim from the
-- imported record (no network). A row exists for every swap that is REFUNDED or FAILED or carries a refundReason.
-- refund_reason NULL means the provider sent no reason (never a guessed one).
CREATE TABLE IF NOT EXISTS intents_swap_refunds
(
  swap_key String,
  status LowCardinality(String),
  created_at DateTime64(3, 'UTC'),
  created_day Date,
  refund_reason Nullable(String),
  refund_to Nullable(String),
  refund_fee_raw Nullable(String),
  refund_fee_formatted Nullable(String),
  refund_type String,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  raw_object_hash String,
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(created_day)
ORDER BY swap_key;
