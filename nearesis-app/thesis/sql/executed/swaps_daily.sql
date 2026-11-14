-- thesis dataset: swaps_daily  (Successful Intents swaps per day and the median successful swap (USD))
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 343
-- result file: raw/swaps_daily.json
-- result sha256: 9559bf87041ff96d680abb75f74af9646d5bc134e5d14b0543adb8c44371c882
-- reproduce: pnpm thesis:data
SELECT created_day AS d, countIf(status = 'SUCCESS') AS success_swaps,
  quantileExactIf(0.5)(toFloat64(amount_in_usd), status = 'SUCCESS' AND amount_in_usd IS NOT NULL) AS median_usd
FROM nearesis_live.intents_swaps FINAL
WHERE created_day BETWEEN {s:Date} AND {e:Date} AND created_day NOT IN (SELECT day FROM nearesis_live.source_coverage FINAL WHERE provider_id = 'near-explorer' AND dataset = 'intents_swaps' AND state != 'complete')
GROUP BY d ORDER BY d
