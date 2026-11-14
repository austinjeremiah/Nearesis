-- thesis BigQuery source query: fees_by_receiver_top
-- Top 50 accounts by NEAR burnt, whole window and per quarter
-- Source: bigquery-public-data.crypto_near_mainnet_us (day-partitioned on block_date; both bounds are DECLAREd literals, end_date is exclusive).
-- Window: block_date 2025-11-10 .. 2026-11-13 inclusive. It is executed in calendar-month chunks (halved when a month does not fit the remaining daily quota);
-- a chunk differs from this text only in its two DECLARE lines. Per-chunk job records are in sql/executed/fees_by_receiver_top.sql.
-- Run: pnpm thesis:fees run --execute (dry run first, BudgetLedger fit, maximumBytesBilled = 1.1 x estimate).
-- ---- query ----
DECLARE start_date DATE DEFAULT DATE '2025-11-10';
DECLARE end_date DATE DEFAULT DATE '2026-11-14';
WITH perex AS (
  SELECT x.block_date AS block_date, IFNULL(x.executor_account_id, '__null_executor__') AS ex, COUNT(*) AS n,
    SUM(CAST(x.gas_burnt AS NUMERIC)) AS g, SUM(CAST(x.tokens_burnt AS BIGNUMERIC)) AS t,
    COUNTIF(x.gas_burnt IS NULL) AS ng, COUNTIF(x.tokens_burnt IS NULL) AS nt,
    COUNTIF(x.gas_burnt != FLOOR(x.gas_burnt)) AS fg
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` x
  WHERE x.block_date >= start_date AND x.block_date < end_date
  GROUP BY block_date, ex
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY block_date ORDER BY t DESC, ex) AS rk FROM perex
), chunk_ex AS (
  SELECT ex, SUM(n) AS n, SUM(g) AS g, SUM(t) AS t, ROW_NUMBER() OVER (ORDER BY SUM(t) DESC, ex) AS rk
  FROM perex GROUP BY ex
)
SELECT 'day' AS kind, block_date, CAST(NULL AS STRING) AS account, SUM(n) AS n,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS gas, CAST(IFNULL(SUM(t), 0) AS STRING) AS tokens_yocto,
  SUM(ng) AS null_gas, SUM(nt) AS null_tokens, SUM(fg) AS fractional_gas, CAST(NULL AS INT64) AS day_rank
FROM perex GROUP BY block_date
UNION ALL
SELECT 'ex', block_date, ex, n, CAST(IFNULL(g, 0) AS STRING), CAST(IFNULL(t, 0) AS STRING), ng, nt, fg, rk
FROM ranked WHERE IF(rk <= 500, TRUE, ex IN ('intents.near', 'verifier2.near', 'bridge.near', 'omft.near', 'v2_1.omni.hot.tg'))
UNION ALL
SELECT 'omft', block_date, CAST(NULL AS STRING), SUM(n), CAST(IFNULL(SUM(g), 0) AS STRING), CAST(IFNULL(SUM(t), 0) AS STRING),
  SUM(ng), SUM(nt), SUM(fg), CAST(NULL AS INT64)
FROM perex WHERE ENDS_WITH(ex, '.omft.near') GROUP BY block_date
UNION ALL
SELECT 'top', CAST(NULL AS DATE), ex, n, CAST(IFNULL(g, 0) AS STRING), CAST(IFNULL(t, 0) AS STRING),
  CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64), rk
FROM chunk_ex WHERE rk <= 1000
ORDER BY 1, 2, 3
