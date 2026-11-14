-- thesis BigQuery source query: transactions_daily
-- Daily transaction count: every row of the transactions table for the day (the status column only carries SUCCESS_RECEIPT_ID, so success vs failure cannot be derived).
-- Source: bigquery-public-data.crypto_near_mainnet_us.transactions (partitioned by block_date; both bounds are DECLAREd literals).
-- Window: block_date 2026-05-05 .. 2026-11-11 inclusive (end_date below is exclusive).
-- ==== EXECUTION RECORD BEGIN ====
-- status: EXECUTED
-- executedAt: 2026-11-14T05:54:23.422Z
-- jobId: 36e22020-1183-4e72-9747-dbec1de04d75
-- jobLocation: us-east1
-- dryRunBytes: 1160026096
-- bytesBilled: 1160773632
-- maximumBytesBilled: 1276028706
-- rows: 191
-- resultFile: raw/bq_transactions_daily.json
-- resultSha256: 9587b499c1bd7e750770f35b1cddd039d050282de3cdf66f2bda041df0ff65a4
-- querySha256: e75a0b092ac48e41699030a849f59aac4eb6f36d6f881542900f366de51c47dc
-- ==== EXECUTION RECORD END ====
-- ---- query ----
DECLARE start_date DATE DEFAULT DATE '2026-05-05';
DECLARE end_date DATE DEFAULT DATE '2026-11-12';
SELECT t.block_date AS block_date,
  COUNT(*) AS tx_count
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
WHERE t.block_date >= start_date AND t.block_date < end_date
GROUP BY block_date ORDER BY block_date
