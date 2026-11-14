-- thesis dataset: transactions_daily  (NEAR transactions per day)
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T05:56:17.206Z
-- parameters: s = 2026-05-05, e = 2026-11-11 (inclusive; v3 research window)
-- rows: 191
-- result file: raw/transactions_daily.json
-- result sha256: 7db994092e8099a13dfe59898ad6c97761a33f058cc9a92a2804eed05652bbbb
-- reproduce: pnpm thesis:data
SELECT block_date AS d, tx_count AS value
FROM nearesis_live.near_daily_tx FINAL
WHERE block_date BETWEEN {s:Date} AND {e:Date}
ORDER BY d
