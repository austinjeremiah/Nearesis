-- thesis dataset: intents_mix_daily  (What moves through Intents: stable-to-stable, no-NEAR-asset and NEAR-token shares of daily USD volume)
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 341
-- result file: raw/intents_mix_daily.json
-- result sha256: 2166838d0c38ce510ca2e746ba9401ebbb6e387cf20cbc8eb23b2faec65fa410
-- reproduce: pnpm thesis:data
SELECT d,
  sum(usd) AS total_usd,
  ifNull(sumIf(usd, stable), 0) AS stable_usd,
  ifNull(sumIf(usd, nonear), 0) AS no_near_usd,
  ifNull(sumIf(usd, neartok), 0) AS near_token_usd,
  ifNull(sumIf(usd, unk), 0) AS unknown_usd,
  toFloat64(ifNull(sumIf(usd, stable), 0)) / toFloat64(sum(usd)) AS stable_share,
  toFloat64(ifNull(sumIf(usd, nonear), 0)) / toFloat64(sum(usd)) AS no_near_share,
  toFloat64(ifNull(sumIf(usd, neartok), 0)) / toFloat64(sum(usd)) AS near_token_share,
  toFloat64(ifNull(sumIf(usd, unk), 0)) / toFloat64(sum(usd)) AS unknown_share
FROM (
  SELECT s.created_day AS d, s.amount_in_usd AS usd,
    (o.provider_asset_id IS NULL OR dd.provider_asset_id IS NULL) AS unk,
    (NOT unk AND upper(o.symbol_observed) IN ('DAI', 'FRAX', 'USD1', 'USDC', 'USDCX', 'USDG', 'USDT', 'USDT0', 'USDE', 'USDF') AND upper(dd.symbol_observed) IN ('DAI', 'FRAX', 'USD1', 'USDC', 'USDCX', 'USDG', 'USDT', 'USDT0', 'USDE', 'USDF')) AS stable,
    (NOT unk AND o.blockchain != 'near' AND dd.blockchain != 'near') AS nonear,
    (NOT unk AND (upper(o.symbol_observed) IN ('NEAR', 'WNEAR') OR upper(dd.symbol_observed) IN ('NEAR', 'WNEAR'))) AS neartok
  FROM (SELECT created_day, origin_asset, destination_asset, amount_in_usd FROM nearesis_live.intents_swaps FINAL WHERE status = 'SUCCESS' AND amount_in_usd IS NOT NULL AND created_day BETWEEN {s:Date} AND {e:Date} AND created_day NOT IN (SELECT day FROM nearesis_live.source_coverage FINAL WHERE provider_id = 'near-explorer' AND dataset = 'intents_swaps' AND state != 'complete') AND created_day NOT IN (SELECT created_day FROM nearesis_live.intents_swaps FINAL WHERE status = 'SUCCESS' AND amount_in_usd IS NULL)) s
LEFT JOIN (SELECT provider_asset_id, symbol_observed, blockchain FROM nearesis_live.asset_registry FINAL) o ON o.provider_asset_id = s.origin_asset
LEFT JOIN (SELECT provider_asset_id, symbol_observed, blockchain FROM nearesis_live.asset_registry FINAL) dd ON dd.provider_asset_id = s.destination_asset
)
GROUP BY d ORDER BY d
SETTINGS join_use_nulls = 1
