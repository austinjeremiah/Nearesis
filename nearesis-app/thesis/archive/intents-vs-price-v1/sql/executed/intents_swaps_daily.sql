-- thesis dataset: intents_swaps_daily  (NEAR Intents swaps per day (count))
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T05:56:17.206Z
-- parameters: s = 2026-05-05, e = 2026-11-11 (inclusive; v3 research window)
-- rows: 191
-- result file: raw/intents_swaps_daily.json
-- result sha256: 8bee9659143ed8560a6cc0fd18ba757f7b192e559f85fa8b90a3a5fb56f8a275
-- reproduce: pnpm thesis:data
SELECT created_day AS d, countIf(status = 'SUCCESS') AS value, count() AS n_all
FROM nearesis_live.intents_swaps FINAL
WHERE created_day BETWEEN {s:Date} AND {e:Date}
GROUP BY d ORDER BY d
