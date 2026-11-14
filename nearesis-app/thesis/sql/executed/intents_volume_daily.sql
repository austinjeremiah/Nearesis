-- thesis dataset: intents_volume_daily  (NEAR Intents swap volume per day (USD))
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T05:56:17.206Z
-- parameters: s = 2026-05-05, e = 2026-11-11 (inclusive; v3 research window)
-- rows: 191
-- result file: raw/intents_volume_daily.json
-- result sha256: 5083fd601b20f447721ade6becf12c9ad480d73d266484cb04347d8780af81d5
-- reproduce: pnpm thesis:data
SELECT created_day AS d,
  if(countIf(status = 'SUCCESS' AND amount_in_usd IS NULL) > 0, NULL, toFloat64(sumIf(amount_in_usd, amount_in_usd IS NOT NULL AND status = 'SUCCESS'))) AS value
FROM nearesis_live.intents_swaps FINAL
WHERE created_day BETWEEN {s:Date} AND {e:Date}
GROUP BY d ORDER BY d
