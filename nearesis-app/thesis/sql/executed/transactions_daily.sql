-- thesis dataset: transactions_daily  (Total, head and top-10 transactions per day)
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 369
-- result file: raw/transactions_daily.json
-- result sha256: 077c92917dabd3c9cc218ee1f3f2face20af604610a5544832d96818384f551a
-- reproduce: pnpm thesis:data
SELECT a.block_date AS d, a.tx_total AS tx_total, a.signers_total AS signers_total, a.tx_organic AS tx_organic, a.signers_organic AS signers_organic, h.tx_head AS tx_head, n.top10_tx AS tx_top10
FROM nearesis_live.account_daily_activity a FINAL
JOIN (SELECT block_date, sum(tx_organic) AS tx_head FROM nearesis_live.account_daily_head FINAL GROUP BY block_date) h ON h.block_date = a.block_date
JOIN nearesis_live.account_daily_new_returning n FINAL ON n.block_date = a.block_date
WHERE a.block_date BETWEEN {s:Date} AND {e:Date}
ORDER BY d
