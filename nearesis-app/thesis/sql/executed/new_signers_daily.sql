-- thesis dataset: new_signers_daily  (New organic signers per day (first organic day seen since the window start))
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 368
-- result file: raw/new_signers_daily.json
-- result sha256: 69f1cc5f8fdb6f6db5536115f7c71f6d6fdc0db4853c6c809bd453d9be503ee5
-- reproduce: pnpm thesis:data
SELECT block_date AS d, new_signers AS value
FROM nearesis_live.account_daily_new_returning FINAL
WHERE block_date BETWEEN {s:Date} AND {e:Date} AND block_date > window_start
ORDER BY d
