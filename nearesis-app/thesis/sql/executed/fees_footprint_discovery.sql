-- thesis dataset: fees_footprint_discovery (NEAR Intents footprint discovery: executors of receipts originating from transactions sent to intents.near)
-- executed against: BigQuery public dataset crypto_near_mainnet_us, location us-east1, SELECT only
-- frozen at: 2026-11-14T11:25:11.929Z
-- rows: 57
-- result file: raw/fees/fees_footprint_discovery.json
-- result sha256: a109bb92143d8d8e8f0fde1c74c816ea450aaddc486228029ca7f1e956c6448b
-- bytes billed (sum of the jobs below): 2684354560
-- job discovery:2026-05-13 2026-05-13..2026-05-13 jobId=4840828e-b600-4359-8fd7-79cb50da330a location=us-east1 executedAt=2026-11-14T11:15:49.460Z dryRunBytes=732847366 bytesBilled=732954624 rows=41 resultSha256=c122458d0989600d06498128527cceb8c472be3680033929f4a80203e32beae5 querySha256=e20658aa836fd30eae3b2f67f62b704ea50a0d7816e8298e788a919c37ec2eb6
-- job discovery:2026-08-12 2026-08-12..2026-08-12 jobId=eb207dcd-4853-4539-a345-6d2de2124b8e location=us-east1 executedAt=2026-11-14T11:15:54.372Z dryRunBytes=783863992 bytesBilled=784334848 rows=41 resultSha256=622fdf8a67651161f2db9a96e66eb3ab1a0516bb5038a24c47e05d7c442e86e6 querySha256=49a54c864b7f4948382bff7049ecf975155e2a0495f8a0ec02cc1ea1128b5544
-- job discovery:2026-10-14 2026-10-14..2026-10-14 jobId=d92f41a7-39b8-434f-b91e-e808bc8c9b62 location=us-east1 executedAt=2026-11-14T11:16:00.398Z dryRunBytes=1166494251 bytesBilled=1167065088 rows=41 resultSha256=2a219a8cb4a1359b633adbba87a3fe9319a8812960bd98ff43ac3153d642a642 querySha256=85dd2d6e18ec18b785a92dcd0f5aa83339756c7d93026089b3a5a00d7a38a6a3
-- The executed SQL of the newest chunk follows; the other chunks differ only in the two DECLARE lines.
DECLARE start_date DATE DEFAULT DATE '2026-10-14';
DECLARE end_date DATE DEFAULT DATE '2026-10-15';
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
