-- thesis dataset: head_accounts_break  (Head accounts around 2026-04-02: transactions in the 31 days before and after)
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 12
-- result file: raw/head_accounts_break.json
-- result sha256: 9fde6db7a0e78e1c8b115ecd2dfdb7341d7a5a31ec83d09a7b9b0cad11a688a2
-- reproduce: pnpm thesis:data
SELECT signer_account_id,
  countIf(block_date BETWEEN '2026-03-02' AND '2026-04-01') AS head_days_before,
  sumIf(tx_organic, block_date BETWEEN '2026-03-02' AND '2026-04-01') AS tx_before,
  sumIf(tx_organic, block_date BETWEEN '2026-03-02' AND '2026-04-01') / 31 AS avg_daily_before,
  countIf(block_date BETWEEN '2026-04-02' AND '2026-05-02') AS head_days_after,
  sumIf(tx_organic, block_date BETWEEN '2026-04-02' AND '2026-05-02') AS tx_after,
  sumIf(tx_organic, block_date BETWEEN '2026-04-02' AND '2026-05-02') / 31 AS avg_daily_after
FROM nearesis_live.account_daily_head FINAL
WHERE block_date BETWEEN '2026-03-02' AND '2026-05-02'
GROUP BY signer_account_id
ORDER BY greatest(tx_before, tx_after) DESC, signer_account_id
LIMIT 12
