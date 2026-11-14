-- thesis BigQuery source query: transactions_signers_daily
-- Total transactions and distinct signers per day.
-- Every row of the transactions table per block_date, and the number of distinct signer_account_id (a signer proxy, not people).
-- Source: bigquery-public-data.crypto_near_mainnet_us.transactions (partitioned by block_date; both bounds are DECLAREd literals, end_date is exclusive).
-- Window: block_date 2025-11-10 .. 2026-11-13 inclusive.
-- ==== EXECUTION RECORD BEGIN ====
-- status: EXECUTED
-- executedAt: 2026-11-14T10:13:30.443Z
-- jobId: f7eb0511-74dd-4928-a11b-f06ba3c1526d
-- jobLocation: us-east1
-- dryRunBytes: 19426952894
-- bytesBilled: 19426967552
-- maximumBytesBilled: 21369648184
-- rows: 369
-- resultFile: raw/bq_transactions_signers_daily.json
-- resultSha256: c0588d9f21767c5890c2456d59ee45d2a56f01010d8d279d6c3798c64521ea03
-- querySha256: 2f14abc7860d51e55d3a2677c8b0e9f53ba45cc41fd260ab1e3c866e586bc90e
-- ==== EXECUTION RECORD END ====
-- ---- query ----
DECLARE start_date DATE DEFAULT DATE '2025-11-10';
DECLARE end_date DATE DEFAULT DATE '2026-11-14';
SELECT t.block_date AS block_date,
  COUNT(*) AS tx_count,
  COUNT(DISTINCT t.signer_account_id) AS distinct_signers
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
WHERE t.block_date >= start_date AND t.block_date < end_date
GROUP BY block_date ORDER BY block_date
