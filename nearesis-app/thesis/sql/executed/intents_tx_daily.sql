-- thesis dataset: intents_tx_daily  (F1 intents_tx: transactions per day addressed to the Intents contracts)
-- executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)
-- frozen at: 2026-11-14T10:12:49.255Z
-- parameters: s = 2025-11-10, e = 2026-11-13 (inclusive full days)
-- rows: 369
-- result file: raw/intents_tx_daily.json
-- result sha256: 6f12dd6dd4ff8f889e4a99972d0bb7b541a41787c1496b69d8ea623573676247
-- reproduce: pnpm thesis:data
SELECT block_date AS d, tx_intents AS value
FROM nearesis_live.account_daily_activity FINAL
WHERE block_date BETWEEN {s:Date} AND {e:Date}
ORDER BY d
