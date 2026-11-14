-- thesis dataset: excursion_routes  (Routes with a NEAR-token leg, 2026-05-22 to 2026-05-27 (the May 2026 excursion))
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 10
-- result file: raw/excursion_routes.json
-- result sha256: 075ec1f2e76ea01bb0e67a18b85df4383fdf8e534b684ae53f3560749efc50d0
-- reproduce: pnpm thesis:data
SELECT ifNull(o.symbol_observed, 'unmapped') AS origin_symbol, ifNull(o.blockchain, 'unmapped') AS origin_chain,
  ifNull(dd.symbol_observed, 'unmapped') AS destination_symbol, ifNull(dd.blockchain, 'unmapped') AS destination_chain,
  count() AS swaps, sum(s.amount_in_usd) AS usd, quantileExact(0.5)(toFloat64(s.amount_in_usd)) AS median_usd
FROM (SELECT created_day, origin_asset, destination_asset, amount_in_usd FROM nearesis_live.intents_swaps FINAL WHERE status = 'SUCCESS' AND amount_in_usd IS NOT NULL AND created_day BETWEEN '2026-05-22' AND '2026-05-27' AND created_day NOT IN (SELECT day FROM nearesis_live.source_coverage FINAL WHERE provider_id = 'near-explorer' AND dataset = 'intents_swaps' AND state != 'complete')) s
LEFT JOIN (SELECT provider_asset_id, symbol_observed, blockchain FROM nearesis_live.asset_registry FINAL) o ON o.provider_asset_id = s.origin_asset
LEFT JOIN (SELECT provider_asset_id, symbol_observed, blockchain FROM nearesis_live.asset_registry FINAL) dd ON dd.provider_asset_id = s.destination_asset
WHERE upper(ifNull(o.symbol_observed, '')) IN ('NEAR', 'WNEAR') OR upper(ifNull(dd.symbol_observed, '')) IN ('NEAR', 'WNEAR')
GROUP BY origin_symbol, origin_chain, destination_symbol, destination_chain
ORDER BY sum(s.amount_in_usd) DESC, origin_symbol, destination_symbol
LIMIT 10
SETTINGS join_use_nulls = 1
