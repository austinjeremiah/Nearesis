-- thesis dataset: contract_usage_top  (Top 50 receiver contracts over the window (function calls))
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T05:56:17.206Z
-- parameters: s = 2026-05-05, e = 2026-11-11 (inclusive; v3 research window)
-- rows: 50
-- result file: raw/contract_usage_top.json
-- result sha256: 015d809a1e0486d69eddeceaa42f962d021a0ad7cf04f9abbf12e1efcfe3517a
-- reproduce: pnpm thesis:data
SELECT receiver_account_id, sum(interactions) AS value, count() AS days_listed
FROM nearesis_live.contract_interactions FINAL
WHERE block_date BETWEEN {s:Date} AND {e:Date}
GROUP BY receiver_account_id
ORDER BY sum(interactions) DESC, receiver_account_id
LIMIT 50
