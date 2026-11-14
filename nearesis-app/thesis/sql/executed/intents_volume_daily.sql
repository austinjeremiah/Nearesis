-- thesis dataset: intents_volume_daily  (F4 intents_usd: USD volume of successful Intents swaps per day)
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 343
-- result file: raw/intents_volume_daily.json
-- result sha256: 06dc827071cf272121975d4d9187feb1ffddf263ef76497862ca3f1ad5c20bf5
-- reproduce: pnpm thesis:data
SELECT created_day AS d,
  if(countIf(status = 'SUCCESS' AND amount_in_usd IS NULL) > 0, NULL, sumIf(amount_in_usd, amount_in_usd IS NOT NULL AND status = 'SUCCESS')) AS value
FROM nearesis_live.intents_swaps FINAL
WHERE created_day BETWEEN {s:Date} AND {e:Date} AND created_day NOT IN (SELECT day FROM nearesis_live.source_coverage FINAL WHERE provider_id = 'near-explorer' AND dataset = 'intents_swaps' AND state != 'complete')
GROUP BY d ORDER BY d
