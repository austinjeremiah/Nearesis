-- thesis BigQuery source query: fees_footprint_discovery
-- NEAR Intents footprint discovery: executors of receipts originating from transactions sent to intents.near
-- Source: bigquery-public-data.crypto_near_mainnet_us (day-partitioned on block_date; both bounds are DECLAREd literals, end_date is exclusive).
-- Window: block_date 2025-11-10 .. 2026-11-13 inclusive. It is executed in calendar-month chunks (halved when a month does not fit the remaining daily quota);
-- a chunk differs from this text only in its two DECLARE lines. Per-chunk job records are in sql/executed/fees_footprint_discovery.sql.
-- Run: pnpm thesis:fees run --execute (dry run first, BudgetLedger fit, maximumBytesBilled = 1.1 x estimate).
-- ---- query ----
DECLARE start_date DATE DEFAULT DATE '2026-05-13';
DECLARE end_date DATE DEFAULT DATE '2026-05-14';
WITH tx AS (
  SELECT t.transaction_hash AS h
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
  WHERE t.block_date >= start_date AND t.block_date < end_date AND t.receiver_account_id = 'intents.near'
), o AS (
  SELECT r.originated_from_transaction_hash AS h, x.executor_account_id AS ex, x.tokens_burnt AS tk, x.gas_burnt AS g
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` x JOIN `bigquery-public-data.crypto_near_mainnet_us.receipt_origin_transaction` r ON r.receipt_id = x.receipt_id
    AND r.block_date >= start_date AND r.block_date < end_date
  WHERE x.block_date >= start_date AND x.block_date < end_date
), gx AS (
  SELECT o.ex AS ex, SUM(CAST(o.tk AS BIGNUMERIC)) AS t, SUM(CAST(o.g AS NUMERIC)) AS g, COUNT(*) AS n, COUNT(DISTINCT o.h) AS txs
  FROM o JOIN tx ON tx.h = o.h GROUP BY ex
), r AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY t DESC, ex) AS rk FROM gx
)
SELECT ex AS executor_account_id, CAST(t AS STRING) AS tokens_yocto, CAST(g AS STRING) AS gas, n AS outcomes, txs AS transactions, rk AS rank
FROM r WHERE rk <= 40
UNION ALL
SELECT '__all_executors__', CAST(IFNULL(SUM(t), 0) AS STRING), CAST(IFNULL(SUM(g), 0) AS STRING), IFNULL(SUM(n), 0), CAST(NULL AS INT64), CAST(NULL AS INT64)
FROM gx
ORDER BY 6, 1
