-- thesis BigQuery source query: active_accounts_daily
-- Daily active accounts: distinct signer_account_id per block_date (a signer proxy, not people; not summable across days).
-- Source: bigquery-public-data.crypto_near_mainnet_us.transactions (partitioned by block_date; both bounds are DECLAREd literals).
-- Window: block_date 2026-05-05 .. 2026-11-11 inclusive (end_date below is exclusive).
-- ==== EXECUTION RECORD BEGIN ====
-- status: EXECUTED
-- executedAt: 2026-11-14T05:54:27.203Z
-- jobId: 3b1c8c6a-aa8e-4fd4-b778-c1d43167e32c
-- jobLocation: us-east1
-- dryRunBytes: 4181577863
-- bytesBilled: 4181721088
-- maximumBytesBilled: 4599735650
-- rows: 191
-- resultFile: raw/bq_active_accounts_daily.json
-- resultSha256: 70f13fcbc1547aa8fa35a94041a4d0a96c66c7aee2c058a6853ea4616e56f7d4
-- querySha256: a64a92ec8fcdba72e44a8cf8d5ec903a3031d8878e48c586c30f2355f788dc62
-- ==== EXECUTION RECORD END ====
-- ---- query ----
DECLARE start_date DATE DEFAULT DATE '2026-05-05';
DECLARE end_date DATE DEFAULT DATE '2026-11-12';
SELECT t.block_date AS block_date,
  COUNT(DISTINCT t.signer_account_id) AS distinct_signers
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
WHERE t.block_date >= start_date AND t.block_date < end_date
GROUP BY block_date ORDER BY block_date
