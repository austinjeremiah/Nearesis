-- thesis dataset: active_accounts_daily  (Daily active accounts (distinct signers))
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T05:56:17.206Z
-- parameters: s = 2026-05-05, e = 2026-11-11 (inclusive; v3 research window)
-- rows: 191
-- result file: raw/active_accounts_daily.json
-- result sha256: c9b9e43bebbf4112246506b8395c86a44ee61cdc8f14569386d5a87b761d5524
-- reproduce: pnpm thesis:data
SELECT block_date AS d, signers_total AS value, signers_organic
FROM nearesis_live.account_daily_activity FINAL
WHERE block_date BETWEEN {s:Date} AND {e:Date}
ORDER BY d
