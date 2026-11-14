-- thesis BigQuery source query: contract_usage_daily
-- Contract usage per day: distinct receiver_account_id and number of transactions addressed to receivers (any account type; not function-call actions).
-- Source: bigquery-public-data.crypto_near_mainnet_us.transactions (partitioned by block_date; both bounds are DECLAREd literals).
-- Window: block_date 2026-05-05 .. 2026-11-11 inclusive (end_date below is exclusive).
-- ==== EXECUTION RECORD BEGIN ====
-- status: EXECUTED
-- executedAt: 2026-11-14T05:54:29.675Z
-- jobId: 90128489-2fe2-491e-b267-deed24f06d80
-- jobLocation: us-east1
-- dryRunBytes: 4515762856
-- bytesBilled: 4516216832
-- maximumBytesBilled: 4967339142
-- rows: 191
-- resultFile: raw/bq_contract_usage_daily.json
-- resultSha256: 6a5e093cded2fdbb824951b2561d2b2d3f4292d5c8ce949f2540b1f2dcd09c62
-- querySha256: 5f98a37f358857cee1b6e2e492f6519afa9d774a442be1116c622cb040d10175
-- ==== EXECUTION RECORD END ====
-- ---- query ----
DECLARE start_date DATE DEFAULT DATE '2026-05-05';
DECLARE end_date DATE DEFAULT DATE '2026-11-12';
SELECT t.block_date AS block_date,
  COUNT(DISTINCT t.receiver_account_id) AS distinct_receivers,
  COUNT(*) AS tx_count
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
WHERE t.block_date >= start_date AND t.block_date < end_date
GROUP BY block_date ORDER BY block_date
