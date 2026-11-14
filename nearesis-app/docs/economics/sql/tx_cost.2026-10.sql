WITH tx AS (
  SELECT t.block_date AS block_date, t.transaction_hash AS h, t.signer_account_id AS signer, t.receiver_account_id AS receiver,
    CAST(t.receipt_conversion_gas_burnt AS NUMERIC) AS g0, CAST(t.receipt_conversion_tokens_burnt AS BIGNUMERIC) AS t0
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
  WHERE t.block_date >= DATE '2026-10-01' AND t.block_date < DATE '2026-11-01'
), rc AS (
  SELECT r.originated_from_transaction_hash AS h, COUNT(*) AS n, SUM(CAST(x.gas_burnt AS NUMERIC)) AS g,
    SUM(CAST(x.tokens_burnt AS BIGNUMERIC)) AS t, COUNTIF(x.status = 'FAILURE') AS nf
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` x JOIN `bigquery-public-data.crypto_near_mainnet_us.receipt_origin_transaction` r ON r.receipt_id = x.receipt_id
    AND r.block_date >= DATE '2026-10-01' AND r.block_date < DATE '2026-11-03'
  WHERE x.block_date >= DATE '2026-10-01' AND x.block_date < DATE '2026-11-03'
  GROUP BY h
), p AS (
  SELECT tx.block_date, tx.h, tx.signer, tx.receiver, tx.g0, tx.t0, IFNULL(rc.n, 0) AS n, IFNULL(rc.g, 0) AS rg,
    IFNULL(rc.t, 0) AS rt, IFNULL(rc.nf, 0) AS nf, rc.h IS NULL AS no_receipts,
    tx.g0 + IFNULL(rc.g, 0) AS g, tx.t0 + IFNULL(rc.t, 0) AS t
  FROM tx LEFT JOIN rc ON rc.h = tx.h
), dayagg AS (
  SELECT 'day' AS kind, block_date, CAST(NULL AS STRING) AS account, CAST(NULL AS STRING) AS tx_hash, CAST(NULL AS STRING) AS signer_id,
    COUNT(*) AS txs, SUM(n) AS receipts, COUNTIF(nf > 0) AS txs_with_failed_receipt, COUNTIF(no_receipts) AS txs_without_receipt_rows,
    CAST(SUM(g0) AS STRING) AS conversion_gas, CAST(SUM(t0) AS STRING) AS conversion_tokens_yocto,
    CAST(SUM(rg) AS STRING) AS receipt_gas, CAST(SUM(rt) AS STRING) AS receipt_tokens_yocto,
    CAST(SUM(g) AS STRING) AS total_gas, CAST(SUM(t) AS STRING) AS total_tokens_yocto,
    CAST(MAX(g) AS STRING) AS max_gas, CAST(MAX(t) AS STRING) AS max_tokens_yocto,
    CAST(APPROX_QUANTILES(t, 1000)[OFFSET(500)] AS STRING) AS tokens_p50, CAST(APPROX_QUANTILES(t, 1000)[OFFSET(900)] AS STRING) AS tokens_p90, CAST(APPROX_QUANTILES(t, 1000)[OFFSET(990)] AS STRING) AS tokens_p99, CAST(APPROX_QUANTILES(t, 1000)[OFFSET(999)] AS STRING) AS tokens_p999,
    CAST(APPROX_QUANTILES(g, 1000)[OFFSET(500)] AS STRING) AS gas_p50, CAST(APPROX_QUANTILES(g, 1000)[OFFSET(900)] AS STRING) AS gas_p90, CAST(APPROX_QUANTILES(g, 1000)[OFFSET(990)] AS STRING) AS gas_p99, CAST(APPROX_QUANTILES(g, 1000)[OFFSET(999)] AS STRING) AS gas_p999,
    CAST(NULL AS STRING) AS tx_gas, CAST(NULL AS STRING) AS tx_tokens_yocto, CAST(NULL AS INT64) AS tx_receipts
  FROM p GROUP BY block_date
), recv AS (
  SELECT block_date, IF(SUM(1) OVER (PARTITION BY block_date, receiver) >= 100, receiver, '__below_threshold__') AS account, g0, t0, n, rg, rt, nf, no_receipts, g, t FROM p
), recvagg AS (
  SELECT 'receiver', block_date, account, CAST(NULL AS STRING), CAST(NULL AS STRING),
    COUNT(*), SUM(n), COUNTIF(nf > 0), COUNTIF(no_receipts),
    CAST(SUM(g0) AS STRING), CAST(SUM(t0) AS STRING), CAST(SUM(rg) AS STRING), CAST(SUM(rt) AS STRING),
    CAST(SUM(g) AS STRING), CAST(SUM(t) AS STRING), CAST(MAX(g) AS STRING), CAST(MAX(t) AS STRING),
    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),
    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),
    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS INT64)
  FROM recv GROUP BY block_date, account
), ranked AS (
  SELECT p.*, ROW_NUMBER() OVER (PARTITION BY block_date ORDER BY t DESC, h) AS rk FROM p
), topagg AS (
  SELECT 'top_tx', block_date, receiver, h, signer,
    CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64),
    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),
    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),
    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),
    CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),
    CAST(g AS STRING), CAST(t AS STRING), n
  FROM ranked WHERE rk <= 20
)
SELECT * FROM dayagg UNION ALL SELECT * FROM recvagg UNION ALL SELECT * FROM topagg
ORDER BY 1, 2, 3, 4
