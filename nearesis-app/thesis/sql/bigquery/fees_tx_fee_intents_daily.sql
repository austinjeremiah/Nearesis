-- thesis BigQuery source query: tx_fee_intents_daily
-- Transactions sent to NEAR Intents contracts per day with their conversion fee, reconciled to the outcome series
-- Source: bigquery-public-data.crypto_near_mainnet_us (day-partitioned on block_date; both bounds are DECLAREd literals, end_date is exclusive).
-- Window: block_date 2025-11-10 .. 2026-11-13 inclusive. It is executed in calendar-month chunks (halved when a month does not fit the remaining daily quota);
-- a chunk differs from this text only in its two DECLARE lines. Per-chunk job records are in sql/executed/fees_tx_fee_intents_daily.sql.
-- Run: pnpm thesis:fees run --execute (dry run first, BudgetLedger fit, maximumBytesBilled = 1.1 x estimate).
-- ---- query ----
DECLARE start_date DATE DEFAULT DATE '2025-11-10';
DECLARE end_date DATE DEFAULT DATE '2026-11-14';
WITH r AS (
  SELECT t.block_date AS block_date, IFNULL(t.receiver_account_id, '__null_receiver__') AS rcv, COUNT(*) AS n,
    SUM(CAST(t.receipt_conversion_gas_burnt AS NUMERIC)) AS g, SUM(CAST(t.receipt_conversion_tokens_burnt AS BIGNUMERIC)) AS k,
    COUNTIF(t.receipt_conversion_gas_burnt IS NULL) AS ng, COUNTIF(t.receipt_conversion_tokens_burnt IS NULL) AS nk
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
  WHERE t.block_date >= start_date AND t.block_date < end_date
  GROUP BY block_date, rcv
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY block_date ORDER BY n DESC, rcv) AS rk FROM r
)
SELECT 'day' AS kind, block_date, CAST(NULL AS STRING) AS account, SUM(n) AS txs,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS conversion_gas, CAST(IFNULL(SUM(k), 0) AS STRING) AS conversion_tokens_yocto,
  SUM(ng) AS null_gas, SUM(nk) AS null_tokens, CAST(NULL AS INT64) AS day_rank
FROM r GROUP BY block_date
UNION ALL
SELECT 'rcv', block_date, rcv, n, CAST(IFNULL(g, 0) AS STRING), CAST(IFNULL(k, 0) AS STRING), ng, nk, rk
FROM ranked WHERE IF(rk <= 300, TRUE, rcv IN ('intents.near', 'verifier2.near', 'bridge.near', 'omft.near', 'v2_1.omni.hot.tg'))
UNION ALL
SELECT 'omft', block_date, CAST(NULL AS STRING), SUM(n), CAST(IFNULL(SUM(g), 0) AS STRING), CAST(IFNULL(SUM(k), 0) AS STRING),
  SUM(ng), SUM(nk), CAST(NULL AS INT64)
FROM r WHERE ENDS_WITH(rcv, '.omft.near') GROUP BY block_date
ORDER BY 1, 2, 3
