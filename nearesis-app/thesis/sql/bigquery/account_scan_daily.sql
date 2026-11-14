-- thesis BigQuery source query: account_scan_daily
-- Intents, bridge, organic, head and tail transactions per day (the account scan, day level).
-- Per signer and day, organic = not an Intents verifier receiver and not a bridge/omni receiver; head = signers with at least 100 organic transactions that day, tail = the other organic signers; top10 = the ten organic signers with the most organic transactions. Same rule as the local account scan (services/ingestion/src/accounts/sql.ts, account rule version 1), reduced to the day-level columns used by this thesis.
-- Source: bigquery-public-data.crypto_near_mainnet_us.transactions (partitioned by block_date; both bounds are DECLAREd literals, end_date is exclusive).
-- Window: block_date 2025-11-10 .. 2026-11-13 inclusive.
-- ==== EXECUTION RECORD BEGIN ====
-- status: EXECUTED
-- executedAt: 2026-11-14T10:13:27.663Z
-- jobId: 97b9e024-a06c-4c31-bccd-6ae3de71da91
-- jobLocation: us-east1
-- dryRunBytes: 37704956319
-- bytesBilled: 37705744384
-- maximumBytesBilled: 41475451951
-- rows: 369
-- resultFile: raw/bq_account_scan_daily.json
-- resultSha256: 1beeea90bd18768d7ac8900c1ca59b17acafab50054f02ff0602507747bf881a
-- querySha256: 977e20f0977e75ec52f73124b6e6b79d9e31b107bff6958d365a3d98bc25173b
-- ==== EXECUTION RECORD END ====
-- ---- query ----
DECLARE start_date DATE DEFAULT DATE '2025-11-10';
DECLARE end_date DATE DEFAULT DATE '2026-11-14';
WITH tx AS (
  SELECT t.block_date AS block_date, t.signer_account_id AS signer,
    t.receiver_account_id IN ('intents.near', 'verifier2.near') AS is_intents,
    GREATEST(CAST(t.receiver_account_id IN ('bridge.near', 'omft.near', 'v2_1.omni.hot.tg') AS INT64), CAST(ENDS_WITH(t.receiver_account_id, '.omft.near') AS INT64)) = 1 AS is_bridge
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
  WHERE t.block_date >= start_date AND t.block_date < end_date
), s AS (
  SELECT block_date, signer, COUNT(*) AS n, COUNTIF(is_intents) AS n_int, COUNTIF(is_bridge AND NOT is_intents) AS n_br
  FROM tx GROUP BY block_date, signer
), r AS (
  SELECT block_date, signer, n, n_int, n_br, n - n_int - n_br AS n_org FROM s
), ranked AS (
  SELECT block_date, n_org, ROW_NUMBER() OVER (PARTITION BY block_date ORDER BY n_org DESC, signer) AS rk
  FROM r WHERE n_org > 0
), tot AS (
  SELECT block_date, SUM(n) AS tx_total, SUM(n_int) AS tx_intents, SUM(n_br) AS tx_bridge FROM r GROUP BY block_date
), org AS (
  SELECT block_date, COUNT(*) AS signers_organic, SUM(n_org) AS tx_organic,
    COUNTIF(n_org < 100) AS tail_signers, SUM(IF(n_org < 100, n_org, 0)) AS tail_tx,
    SUM(IF(n_org >= 100, n_org, 0)) AS head_tx, SUM(IF(rk <= 10, n_org, 0)) AS top10_tx
  FROM ranked GROUP BY block_date
)
SELECT tot.block_date AS block_date, tot.tx_total, tot.tx_intents, tot.tx_bridge,
  COALESCE(org.tx_organic, 0) AS tx_organic, COALESCE(org.signers_organic, 0) AS signers_organic,
  COALESCE(org.tail_signers, 0) AS tail_signers, COALESCE(org.tail_tx, 0) AS tail_tx,
  COALESCE(org.head_tx, 0) AS head_tx, COALESCE(org.top10_tx, 0) AS top10_tx
FROM tot LEFT JOIN org ON org.block_date = tot.block_date
ORDER BY block_date
