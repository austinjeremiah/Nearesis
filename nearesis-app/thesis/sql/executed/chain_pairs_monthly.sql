-- thesis dataset: chain_pairs_monthly  (Monthly USD volume of the top 10 origin-chain to destination-chain pairs)
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 130
-- result file: raw/chain_pairs_monthly.json
-- result sha256: b743886ca1b3181dea7b77655ecf4ff4791edd9c4c7dc42b07a146604fc176f9
-- reproduce: pnpm thesis:data
WITH legs AS (
  SELECT toStartOfMonth(s.created_day) AS m, ifNull(o.blockchain, 'unmapped') AS origin_chain, ifNull(dd.blockchain, 'unmapped') AS destination_chain, s.amount_in_usd AS usd
  FROM (SELECT created_day, origin_asset, destination_asset, amount_in_usd FROM nearesis_live.intents_swaps FINAL WHERE status = 'SUCCESS' AND amount_in_usd IS NOT NULL AND created_day BETWEEN {s:Date} AND {e:Date} AND created_day NOT IN (SELECT day FROM nearesis_live.source_coverage FINAL WHERE provider_id = 'near-explorer' AND dataset = 'intents_swaps' AND state != 'complete') AND created_day NOT IN (SELECT created_day FROM nearesis_live.intents_swaps FINAL WHERE status = 'SUCCESS' AND amount_in_usd IS NULL)) s
LEFT JOIN (SELECT provider_asset_id, symbol_observed, blockchain FROM nearesis_live.asset_registry FINAL) o ON o.provider_asset_id = s.origin_asset
LEFT JOIN (SELECT provider_asset_id, symbol_observed, blockchain FROM nearesis_live.asset_registry FINAL) dd ON dd.provider_asset_id = s.destination_asset
)
SELECT m, origin_chain, destination_chain, sum(usd) AS usd, count() AS swaps
FROM legs
WHERE (origin_chain, destination_chain) IN (SELECT origin_chain, destination_chain FROM legs GROUP BY origin_chain, destination_chain ORDER BY sum(usd) DESC, origin_chain, destination_chain LIMIT 10)
GROUP BY m, origin_chain, destination_chain
ORDER BY origin_chain, destination_chain, m
SETTINGS join_use_nulls = 1
