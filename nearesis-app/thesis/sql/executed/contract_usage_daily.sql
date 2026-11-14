-- thesis dataset: contract_usage_daily  (Contract usage per day (function calls and active contracts))
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T05:56:17.206Z
-- parameters: s = 2026-05-05, e = 2026-11-11 (inclusive; v3 research window)
-- rows: 191
-- result file: raw/contract_usage_daily.json
-- result sha256: 42b0e165123ed25d073772df5deb7f77d3cbc147071ebafc032aa2033eda6da6
-- reproduce: pnpm thesis:data
SELECT block_date AS d, function_call_actions AS value, active_contract_count AS active_contracts
FROM nearesis_live.near_daily_usage
WHERE block_date BETWEEN {s:Date} AND {e:Date}
ORDER BY d
