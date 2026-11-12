-- Effective-dated asset registry for nearesis_live, derived only from the archived official 1Click token list.
-- One row per (provider_id, provider_asset_id, valid_from); a later version supersedes an earlier one.
-- Rows that cannot be mapped are kept with canonical_asset_id NULL and a reason: unknown stays explicitly unknown.
CREATE TABLE IF NOT EXISTS asset_registry
(
  provider_id LowCardinality(String),
  provider_asset_id String,
  canonical_asset_id Nullable(String),
  verification LowCardinality(String),
  unknown_reason Nullable(String),
  symbol_observed String,
  blockchain String,
  coingecko_id Nullable(String),
  valid_from DateTime64(3, 'UTC'),
  valid_to Nullable(DateTime64(3, 'UTC')),
  evidence_url String,
  source_raw_object_hash String,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  fetched_at DateTime64(3, 'UTC'),
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (provider_id, provider_asset_id, valid_from);

-- Why a swap leg has no canonical asset (NULL canonical + reason); mapped legs show reason NULL.
CREATE VIEW IF NOT EXISTS intents_swap_asset_status AS
SELECT
  s.swap_key AS swap_key,
  s.canonical_origin_asset IS NOT NULL AS origin_mapped,
  s.canonical_destination_asset IS NOT NULL AS destination_mapped,
  if(s.canonical_origin_asset IS NOT NULL, NULL, coalesce(o.unknown_reason, 'not_in_registry')) AS origin_unknown_reason,
  if(s.canonical_destination_asset IS NOT NULL, NULL, coalesce(d.unknown_reason, 'not_in_registry')) AS destination_unknown_reason
FROM intents_swaps AS s FINAL
LEFT JOIN (SELECT provider_asset_id, argMax(unknown_reason, version) AS unknown_reason FROM asset_registry GROUP BY provider_asset_id) AS o ON o.provider_asset_id = s.origin_asset
LEFT JOIN (SELECT provider_asset_id, argMax(unknown_reason, version) AS unknown_reason FROM asset_registry GROUP BY provider_asset_id) AS d ON d.provider_asset_id = s.destination_asset;
