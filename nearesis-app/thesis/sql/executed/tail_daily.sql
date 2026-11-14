-- thesis dataset: tail_daily  (F2 tail_tx and F3 tail_signers: the long tail of ordinary accounts)
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 369
-- result file: raw/tail_daily.json
-- result sha256: 1059f110af7df857edcce2efda25f70f866c67707e52bcb72fa1ed2645369533
-- reproduce: pnpm thesis:data
SELECT block_date AS d, tail_tx, tail_signers
FROM nearesis_live.account_daily_tail FINAL
WHERE block_date BETWEEN {s:Date} AND {e:Date}
ORDER BY d
