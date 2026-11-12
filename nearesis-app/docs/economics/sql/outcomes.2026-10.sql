WITH det AS (
  SELECT d.receipt_id AS receipt_id, MIN(d.predecessor_account_id) AS pred, MIN(d.receipt_kind) AS kind, COUNT(*) AS c
  FROM `bigquery-public-data.crypto_near_mainnet_us.receipt_details` d
  WHERE d.block_date >= DATE '2026-10-01' AND d.block_date < DATE '2026-11-01'
  GROUP BY d.receipt_id
), o AS (
  SELECT x.block_date AS block_date, x.executor_account_id AS executor,
    CASE WHEN d.receipt_id IS NULL THEN 'NO_RECEIPT_ROW'
      WHEN d.pred = 'system' THEN 'REFUND'
      WHEN d.kind = 'ACTION' THEN 'ACTION'
      ELSE 'DATA' END AS outcome_kind,
    CASE WHEN STARTS_WITH(x.status, 'SUCCESS') THEN 'SUCCESS' WHEN x.status = 'FAILURE' THEN 'FAILURE' ELSE 'OTHER' END AS status_class,
    CAST(x.gas_burnt AS NUMERIC) AS g, CAST(x.tokens_burnt AS BIGNUMERIC) AS t,
    x.gas_burnt != FLOOR(x.gas_burnt) AS frac, IFNULL(d.c, 1) - 1 AS dup
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` x LEFT JOIN det d ON d.receipt_id = x.receipt_id
  WHERE x.block_date >= DATE '2026-10-01' AND x.block_date < DATE '2026-11-01'
), a AS (
  SELECT block_date, executor, outcome_kind, status_class, COUNT(*) AS n, SUM(g) AS g, SUM(t) AS t,
    COUNTIF(frac) AS frac_rows, COUNTIF(t = 0) AS zero_token_rows, SUM(dup) AS dup_rows
  FROM o GROUP BY block_date, executor, outcome_kind, status_class
), f AS (
  SELECT *, IF(SUM(n) OVER (PARTITION BY block_date, executor) >= 100, executor, '__below_threshold__') AS ex
  FROM a
)
SELECT block_date, ex AS executor_account_id, outcome_kind, status_class, SUM(n) AS outcomes,
  CAST(SUM(g) AS STRING) AS gas_burnt, CAST(SUM(t) AS STRING) AS tokens_burnt_yocto,
  SUM(frac_rows) AS fractional_gas_rows, SUM(zero_token_rows) AS zero_token_rows, SUM(dup_rows) AS duplicate_receipt_rows
FROM f GROUP BY block_date, ex, outcome_kind, status_class
ORDER BY 1, 2, 3, 4
