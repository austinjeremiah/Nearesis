-- thesis BigQuery source query: contract_usage_top
-- Top 100 receiver accounts over the whole window by number of transactions addressed to them, with the number of days they were hit.
-- Source: bigquery-public-data.crypto_near_mainnet_us.transactions (partitioned by block_date; both bounds are DECLAREd literals).
-- Window: block_date 2026-05-05 .. 2026-11-11 inclusive (end_date below is exclusive).
-- ==== EXECUTION RECORD BEGIN ====
-- status: EXECUTED
-- executedAt: 2026-11-14T05:54:36.143Z
-- jobId: 98f3251d-3649-49f2-bf53-b307879a9cad
-- jobLocation: us-east1
-- dryRunBytes: 4515762856
-- bytesBilled: 4516216832
-- maximumBytesBilled: 4967339142
-- rows: 100
-- resultFile: raw/bq_contract_usage_top.json
-- resultSha256: 498d915b0e02efb2d74ad1e7ccc53b143d83c352789893b05e798c039e293efd
-- querySha256: 7a2620f101fa6a254ade8a74fafc3547be69b9754f5c65d2fc193363259ecbe9
-- ==== EXECUTION RECORD END ====
-- ---- query ----
DECLARE start_date DATE DEFAULT DATE '2026-05-05';
DECLARE end_date DATE DEFAULT DATE '2026-11-12';
SELECT t.receiver_account_id AS receiver_account_id,
  COUNT(*) AS tx_count,
  COUNT(DISTINCT t.block_date) AS active_days
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
WHERE t.block_date >= start_date AND t.block_date < end_date
GROUP BY receiver_account_id ORDER BY tx_count DESC, receiver_account_id LIMIT 100
