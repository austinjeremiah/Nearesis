-- outcomes:2026-11-09 [2026-11-09, 2026-11-10)
WITH o AS (
  SELECT x.block_date AS block_date, IFNULL(x.executor_account_id, '__null_executor__') AS executor,
    CASE WHEN x.tokens_burnt IS NULL THEN 'NULL_FIELDS' WHEN x.gas_burnt IS NULL THEN 'NULL_FIELDS'
      WHEN x.tokens_burnt = 0 THEN 'ZERO_TOKEN' ELSE 'BURNING' END AS outcome_kind,
    CAST(x.gas_burnt AS NUMERIC) AS g, CAST(x.tokens_burnt AS BIGNUMERIC) AS t,
    x.gas_burnt != FLOOR(x.gas_burnt) AS frac
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` x
  WHERE x.block_date >= DATE '2026-11-09' AND x.block_date < DATE '2026-11-10'
), a AS (
  SELECT block_date, executor, outcome_kind, COUNT(*) AS n, SUM(g) AS g, SUM(t) AS t, COUNTIF(frac) AS frac_rows,
    COUNTIF(outcome_kind = 'ZERO_TOKEN') AS zero_rows
  FROM o GROUP BY block_date, executor, outcome_kind
), f AS (
  SELECT *, IF(SUM(n) OVER (PARTITION BY block_date, executor) >= 100, executor, '__below_threshold__') AS ex
  FROM a
)
SELECT block_date, ex AS executor_account_id, outcome_kind, 'UNKNOWN' AS status_class, SUM(n) AS outcomes,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS gas_burnt, CAST(IFNULL(SUM(t), 0) AS STRING) AS tokens_burnt_yocto,
  SUM(frac_rows) AS fractional_gas_rows, SUM(zero_rows) AS zero_token_rows, 0 AS duplicate_receipt_rows
FROM f GROUP BY block_date, ex, outcome_kind
ORDER BY 1, 2, 3;

-- outcomes:2026-11-08 [2026-11-08, 2026-11-09)
WITH o AS (
  SELECT x.block_date AS block_date, IFNULL(x.executor_account_id, '__null_executor__') AS executor,
    CASE WHEN x.tokens_burnt IS NULL THEN 'NULL_FIELDS' WHEN x.gas_burnt IS NULL THEN 'NULL_FIELDS'
      WHEN x.tokens_burnt = 0 THEN 'ZERO_TOKEN' ELSE 'BURNING' END AS outcome_kind,
    CAST(x.gas_burnt AS NUMERIC) AS g, CAST(x.tokens_burnt AS BIGNUMERIC) AS t,
    x.gas_burnt != FLOOR(x.gas_burnt) AS frac
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` x
  WHERE x.block_date >= DATE '2026-11-08' AND x.block_date < DATE '2026-11-09'
), a AS (
  SELECT block_date, executor, outcome_kind, COUNT(*) AS n, SUM(g) AS g, SUM(t) AS t, COUNTIF(frac) AS frac_rows,
    COUNTIF(outcome_kind = 'ZERO_TOKEN') AS zero_rows
  FROM o GROUP BY block_date, executor, outcome_kind
), f AS (
  SELECT *, IF(SUM(n) OVER (PARTITION BY block_date, executor) >= 100, executor, '__below_threshold__') AS ex
  FROM a
)
SELECT block_date, ex AS executor_account_id, outcome_kind, 'UNKNOWN' AS status_class, SUM(n) AS outcomes,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS gas_burnt, CAST(IFNULL(SUM(t), 0) AS STRING) AS tokens_burnt_yocto,
  SUM(frac_rows) AS fractional_gas_rows, SUM(zero_rows) AS zero_token_rows, 0 AS duplicate_receipt_rows
FROM f GROUP BY block_date, ex, outcome_kind
ORDER BY 1, 2, 3;

-- outcomes:2026-11-07 [2026-11-07, 2026-11-08)
WITH o AS (
  SELECT x.block_date AS block_date, IFNULL(x.executor_account_id, '__null_executor__') AS executor,
    CASE WHEN x.tokens_burnt IS NULL THEN 'NULL_FIELDS' WHEN x.gas_burnt IS NULL THEN 'NULL_FIELDS'
      WHEN x.tokens_burnt = 0 THEN 'ZERO_TOKEN' ELSE 'BURNING' END AS outcome_kind,
    CAST(x.gas_burnt AS NUMERIC) AS g, CAST(x.tokens_burnt AS BIGNUMERIC) AS t,
    x.gas_burnt != FLOOR(x.gas_burnt) AS frac
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` x
  WHERE x.block_date >= DATE '2026-11-07' AND x.block_date < DATE '2026-11-08'
), a AS (
  SELECT block_date, executor, outcome_kind, COUNT(*) AS n, SUM(g) AS g, SUM(t) AS t, COUNTIF(frac) AS frac_rows,
    COUNTIF(outcome_kind = 'ZERO_TOKEN') AS zero_rows
  FROM o GROUP BY block_date, executor, outcome_kind
), f AS (
  SELECT *, IF(SUM(n) OVER (PARTITION BY block_date, executor) >= 100, executor, '__below_threshold__') AS ex
  FROM a
)
SELECT block_date, ex AS executor_account_id, outcome_kind, 'UNKNOWN' AS status_class, SUM(n) AS outcomes,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS gas_burnt, CAST(IFNULL(SUM(t), 0) AS STRING) AS tokens_burnt_yocto,
  SUM(frac_rows) AS fractional_gas_rows, SUM(zero_rows) AS zero_token_rows, 0 AS duplicate_receipt_rows
FROM f GROUP BY block_date, ex, outcome_kind
ORDER BY 1, 2, 3;

-- outcomes:2026-11-06 [2026-11-06, 2026-11-07)
WITH o AS (
  SELECT x.block_date AS block_date, IFNULL(x.executor_account_id, '__null_executor__') AS executor,
    CASE WHEN x.tokens_burnt IS NULL THEN 'NULL_FIELDS' WHEN x.gas_burnt IS NULL THEN 'NULL_FIELDS'
      WHEN x.tokens_burnt = 0 THEN 'ZERO_TOKEN' ELSE 'BURNING' END AS outcome_kind,
    CAST(x.gas_burnt AS NUMERIC) AS g, CAST(x.tokens_burnt AS BIGNUMERIC) AS t,
    x.gas_burnt != FLOOR(x.gas_burnt) AS frac
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` x
  WHERE x.block_date >= DATE '2026-11-06' AND x.block_date < DATE '2026-11-07'
), a AS (
  SELECT block_date, executor, outcome_kind, COUNT(*) AS n, SUM(g) AS g, SUM(t) AS t, COUNTIF(frac) AS frac_rows,
    COUNTIF(outcome_kind = 'ZERO_TOKEN') AS zero_rows
  FROM o GROUP BY block_date, executor, outcome_kind
), f AS (
  SELECT *, IF(SUM(n) OVER (PARTITION BY block_date, executor) >= 100, executor, '__below_threshold__') AS ex
  FROM a
)
SELECT block_date, ex AS executor_account_id, outcome_kind, 'UNKNOWN' AS status_class, SUM(n) AS outcomes,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS gas_burnt, CAST(IFNULL(SUM(t), 0) AS STRING) AS tokens_burnt_yocto,
  SUM(frac_rows) AS fractional_gas_rows, SUM(zero_rows) AS zero_token_rows, 0 AS duplicate_receipt_rows
FROM f GROUP BY block_date, ex, outcome_kind
ORDER BY 1, 2, 3;

-- outcomes:2026-11-05 [2026-11-05, 2026-11-06)
WITH o AS (
  SELECT x.block_date AS block_date, IFNULL(x.executor_account_id, '__null_executor__') AS executor,
    CASE WHEN x.tokens_burnt IS NULL THEN 'NULL_FIELDS' WHEN x.gas_burnt IS NULL THEN 'NULL_FIELDS'
      WHEN x.tokens_burnt = 0 THEN 'ZERO_TOKEN' ELSE 'BURNING' END AS outcome_kind,
    CAST(x.gas_burnt AS NUMERIC) AS g, CAST(x.tokens_burnt AS BIGNUMERIC) AS t,
    x.gas_burnt != FLOOR(x.gas_burnt) AS frac
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` x
  WHERE x.block_date >= DATE '2026-11-05' AND x.block_date < DATE '2026-11-06'
), a AS (
  SELECT block_date, executor, outcome_kind, COUNT(*) AS n, SUM(g) AS g, SUM(t) AS t, COUNTIF(frac) AS frac_rows,
    COUNTIF(outcome_kind = 'ZERO_TOKEN') AS zero_rows
  FROM o GROUP BY block_date, executor, outcome_kind
), f AS (
  SELECT *, IF(SUM(n) OVER (PARTITION BY block_date, executor) >= 100, executor, '__below_threshold__') AS ex
  FROM a
)
SELECT block_date, ex AS executor_account_id, outcome_kind, 'UNKNOWN' AS status_class, SUM(n) AS outcomes,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS gas_burnt, CAST(IFNULL(SUM(t), 0) AS STRING) AS tokens_burnt_yocto,
  SUM(frac_rows) AS fractional_gas_rows, SUM(zero_rows) AS zero_token_rows, 0 AS duplicate_receipt_rows
FROM f GROUP BY block_date, ex, outcome_kind
ORDER BY 1, 2, 3;

-- outcomes:2026-11-04 [2026-11-04, 2026-11-05)
WITH o AS (
  SELECT x.block_date AS block_date, IFNULL(x.executor_account_id, '__null_executor__') AS executor,
    CASE WHEN x.tokens_burnt IS NULL THEN 'NULL_FIELDS' WHEN x.gas_burnt IS NULL THEN 'NULL_FIELDS'
      WHEN x.tokens_burnt = 0 THEN 'ZERO_TOKEN' ELSE 'BURNING' END AS outcome_kind,
    CAST(x.gas_burnt AS NUMERIC) AS g, CAST(x.tokens_burnt AS BIGNUMERIC) AS t,
    x.gas_burnt != FLOOR(x.gas_burnt) AS frac
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` x
  WHERE x.block_date >= DATE '2026-11-04' AND x.block_date < DATE '2026-11-05'
), a AS (
  SELECT block_date, executor, outcome_kind, COUNT(*) AS n, SUM(g) AS g, SUM(t) AS t, COUNTIF(frac) AS frac_rows,
    COUNTIF(outcome_kind = 'ZERO_TOKEN') AS zero_rows
  FROM o GROUP BY block_date, executor, outcome_kind
), f AS (
  SELECT *, IF(SUM(n) OVER (PARTITION BY block_date, executor) >= 100, executor, '__below_threshold__') AS ex
  FROM a
)
SELECT block_date, ex AS executor_account_id, outcome_kind, 'UNKNOWN' AS status_class, SUM(n) AS outcomes,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS gas_burnt, CAST(IFNULL(SUM(t), 0) AS STRING) AS tokens_burnt_yocto,
  SUM(frac_rows) AS fractional_gas_rows, SUM(zero_rows) AS zero_token_rows, 0 AS duplicate_receipt_rows
FROM f GROUP BY block_date, ex, outcome_kind
ORDER BY 1, 2, 3;

-- outcomes:2026-11-03 [2026-11-03, 2026-11-04)
WITH o AS (
  SELECT x.block_date AS block_date, IFNULL(x.executor_account_id, '__null_executor__') AS executor,
    CASE WHEN x.tokens_burnt IS NULL THEN 'NULL_FIELDS' WHEN x.gas_burnt IS NULL THEN 'NULL_FIELDS'
      WHEN x.tokens_burnt = 0 THEN 'ZERO_TOKEN' ELSE 'BURNING' END AS outcome_kind,
    CAST(x.gas_burnt AS NUMERIC) AS g, CAST(x.tokens_burnt AS BIGNUMERIC) AS t,
    x.gas_burnt != FLOOR(x.gas_burnt) AS frac
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes` x
  WHERE x.block_date >= DATE '2026-11-03' AND x.block_date < DATE '2026-11-04'
), a AS (
  SELECT block_date, executor, outcome_kind, COUNT(*) AS n, SUM(g) AS g, SUM(t) AS t, COUNTIF(frac) AS frac_rows,
    COUNTIF(outcome_kind = 'ZERO_TOKEN') AS zero_rows
  FROM o GROUP BY block_date, executor, outcome_kind
), f AS (
  SELECT *, IF(SUM(n) OVER (PARTITION BY block_date, executor) >= 100, executor, '__below_threshold__') AS ex
  FROM a
)
SELECT block_date, ex AS executor_account_id, outcome_kind, 'UNKNOWN' AS status_class, SUM(n) AS outcomes,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS gas_burnt, CAST(IFNULL(SUM(t), 0) AS STRING) AS tokens_burnt_yocto,
  SUM(frac_rows) AS fractional_gas_rows, SUM(zero_rows) AS zero_token_rows, 0 AS duplicate_receipt_rows
FROM f GROUP BY block_date, ex, outcome_kind
ORDER BY 1, 2, 3;

-- conversion:2026-11-09 [2026-11-09, 2026-11-10)
WITH tx AS (
  SELECT block_date, IFNULL(receiver_account_id, '__null_receiver__') AS r,
    CAST(receipt_conversion_gas_burnt AS NUMERIC) AS g, CAST(receipt_conversion_tokens_burnt AS BIGNUMERIC) AS k
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
  WHERE block_date >= DATE '2026-11-09' AND block_date < DATE '2026-11-10'
), f AS (
  SELECT block_date, IF(COUNT(*) OVER (PARTITION BY block_date, r) >= 100, r, '__below_threshold__') AS acct, g, k FROM tx
)
SELECT 'day' AS scope, block_date, CAST(NULL AS STRING) AS account, COUNT(*) AS txs,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS conversion_gas, CAST(IFNULL(SUM(k), 0) AS STRING) AS conversion_tokens_yocto,
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL) AS null_rows
FROM tx GROUP BY block_date
UNION ALL
SELECT 'receiver', block_date, acct, COUNT(*), CAST(IFNULL(SUM(g), 0) AS STRING), CAST(IFNULL(SUM(k), 0) AS STRING),
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL)
FROM f GROUP BY block_date, acct
ORDER BY 1, 2, 3;

-- conversion:2026-11-08 [2026-11-08, 2026-11-09)
WITH tx AS (
  SELECT block_date, IFNULL(receiver_account_id, '__null_receiver__') AS r,
    CAST(receipt_conversion_gas_burnt AS NUMERIC) AS g, CAST(receipt_conversion_tokens_burnt AS BIGNUMERIC) AS k
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
  WHERE block_date >= DATE '2026-11-08' AND block_date < DATE '2026-11-09'
), f AS (
  SELECT block_date, IF(COUNT(*) OVER (PARTITION BY block_date, r) >= 100, r, '__below_threshold__') AS acct, g, k FROM tx
)
SELECT 'day' AS scope, block_date, CAST(NULL AS STRING) AS account, COUNT(*) AS txs,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS conversion_gas, CAST(IFNULL(SUM(k), 0) AS STRING) AS conversion_tokens_yocto,
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL) AS null_rows
FROM tx GROUP BY block_date
UNION ALL
SELECT 'receiver', block_date, acct, COUNT(*), CAST(IFNULL(SUM(g), 0) AS STRING), CAST(IFNULL(SUM(k), 0) AS STRING),
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL)
FROM f GROUP BY block_date, acct
ORDER BY 1, 2, 3;

-- conversion:2026-11-07 [2026-11-07, 2026-11-08)
WITH tx AS (
  SELECT block_date, IFNULL(receiver_account_id, '__null_receiver__') AS r,
    CAST(receipt_conversion_gas_burnt AS NUMERIC) AS g, CAST(receipt_conversion_tokens_burnt AS BIGNUMERIC) AS k
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
  WHERE block_date >= DATE '2026-11-07' AND block_date < DATE '2026-11-08'
), f AS (
  SELECT block_date, IF(COUNT(*) OVER (PARTITION BY block_date, r) >= 100, r, '__below_threshold__') AS acct, g, k FROM tx
)
SELECT 'day' AS scope, block_date, CAST(NULL AS STRING) AS account, COUNT(*) AS txs,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS conversion_gas, CAST(IFNULL(SUM(k), 0) AS STRING) AS conversion_tokens_yocto,
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL) AS null_rows
FROM tx GROUP BY block_date
UNION ALL
SELECT 'receiver', block_date, acct, COUNT(*), CAST(IFNULL(SUM(g), 0) AS STRING), CAST(IFNULL(SUM(k), 0) AS STRING),
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL)
FROM f GROUP BY block_date, acct
ORDER BY 1, 2, 3;

-- conversion:2026-11-06 [2026-11-06, 2026-11-07)
WITH tx AS (
  SELECT block_date, IFNULL(receiver_account_id, '__null_receiver__') AS r,
    CAST(receipt_conversion_gas_burnt AS NUMERIC) AS g, CAST(receipt_conversion_tokens_burnt AS BIGNUMERIC) AS k
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
  WHERE block_date >= DATE '2026-11-06' AND block_date < DATE '2026-11-07'
), f AS (
  SELECT block_date, IF(COUNT(*) OVER (PARTITION BY block_date, r) >= 100, r, '__below_threshold__') AS acct, g, k FROM tx
)
SELECT 'day' AS scope, block_date, CAST(NULL AS STRING) AS account, COUNT(*) AS txs,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS conversion_gas, CAST(IFNULL(SUM(k), 0) AS STRING) AS conversion_tokens_yocto,
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL) AS null_rows
FROM tx GROUP BY block_date
UNION ALL
SELECT 'receiver', block_date, acct, COUNT(*), CAST(IFNULL(SUM(g), 0) AS STRING), CAST(IFNULL(SUM(k), 0) AS STRING),
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL)
FROM f GROUP BY block_date, acct
ORDER BY 1, 2, 3;

-- conversion:2026-11-05 [2026-11-05, 2026-11-06)
WITH tx AS (
  SELECT block_date, IFNULL(receiver_account_id, '__null_receiver__') AS r,
    CAST(receipt_conversion_gas_burnt AS NUMERIC) AS g, CAST(receipt_conversion_tokens_burnt AS BIGNUMERIC) AS k
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
  WHERE block_date >= DATE '2026-11-05' AND block_date < DATE '2026-11-06'
), f AS (
  SELECT block_date, IF(COUNT(*) OVER (PARTITION BY block_date, r) >= 100, r, '__below_threshold__') AS acct, g, k FROM tx
)
SELECT 'day' AS scope, block_date, CAST(NULL AS STRING) AS account, COUNT(*) AS txs,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS conversion_gas, CAST(IFNULL(SUM(k), 0) AS STRING) AS conversion_tokens_yocto,
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL) AS null_rows
FROM tx GROUP BY block_date
UNION ALL
SELECT 'receiver', block_date, acct, COUNT(*), CAST(IFNULL(SUM(g), 0) AS STRING), CAST(IFNULL(SUM(k), 0) AS STRING),
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL)
FROM f GROUP BY block_date, acct
ORDER BY 1, 2, 3;

-- conversion:2026-11-04 [2026-11-04, 2026-11-05)
WITH tx AS (
  SELECT block_date, IFNULL(receiver_account_id, '__null_receiver__') AS r,
    CAST(receipt_conversion_gas_burnt AS NUMERIC) AS g, CAST(receipt_conversion_tokens_burnt AS BIGNUMERIC) AS k
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
  WHERE block_date >= DATE '2026-11-04' AND block_date < DATE '2026-11-05'
), f AS (
  SELECT block_date, IF(COUNT(*) OVER (PARTITION BY block_date, r) >= 100, r, '__below_threshold__') AS acct, g, k FROM tx
)
SELECT 'day' AS scope, block_date, CAST(NULL AS STRING) AS account, COUNT(*) AS txs,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS conversion_gas, CAST(IFNULL(SUM(k), 0) AS STRING) AS conversion_tokens_yocto,
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL) AS null_rows
FROM tx GROUP BY block_date
UNION ALL
SELECT 'receiver', block_date, acct, COUNT(*), CAST(IFNULL(SUM(g), 0) AS STRING), CAST(IFNULL(SUM(k), 0) AS STRING),
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL)
FROM f GROUP BY block_date, acct
ORDER BY 1, 2, 3;

-- conversion:2026-11-03 [2026-11-03, 2026-11-04)
WITH tx AS (
  SELECT block_date, IFNULL(receiver_account_id, '__null_receiver__') AS r,
    CAST(receipt_conversion_gas_burnt AS NUMERIC) AS g, CAST(receipt_conversion_tokens_burnt AS BIGNUMERIC) AS k
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
  WHERE block_date >= DATE '2026-11-03' AND block_date < DATE '2026-11-04'
), f AS (
  SELECT block_date, IF(COUNT(*) OVER (PARTITION BY block_date, r) >= 100, r, '__below_threshold__') AS acct, g, k FROM tx
)
SELECT 'day' AS scope, block_date, CAST(NULL AS STRING) AS account, COUNT(*) AS txs,
  CAST(IFNULL(SUM(g), 0) AS STRING) AS conversion_gas, CAST(IFNULL(SUM(k), 0) AS STRING) AS conversion_tokens_yocto,
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL) AS null_rows
FROM tx GROUP BY block_date
UNION ALL
SELECT 'receiver', block_date, acct, COUNT(*), CAST(IFNULL(SUM(g), 0) AS STRING), CAST(IFNULL(SUM(k), 0) AS STRING),
  COUNTIF(g IS NULL) + COUNTIF(k IS NULL)
FROM f GROUP BY block_date, acct
ORDER BY 1, 2, 3;

-- gas_price:2026-11-09 [2026-11-09, 2026-11-10)
SELECT block_date, COUNT(*) AS blocks, MIN(gas_price) AS min_gas_price, MAX(gas_price) AS max_gas_price,
  CAST(SUM(CAST(gas_price AS NUMERIC)) AS STRING) AS sum_gas_price, COUNTIF(gas_price != FLOOR(gas_price)) AS fractional_price_rows,
  COUNTIF(gas_price IS NULL) AS null_price_rows, COUNT(DISTINCT gas_price) AS distinct_prices
FROM `bigquery-public-data.crypto_near_mainnet_us.blocks`
WHERE block_date >= DATE '2026-11-09' AND block_date < DATE '2026-11-10'
GROUP BY block_date ORDER BY block_date;

-- gas_price:2026-11-08 [2026-11-08, 2026-11-09)
SELECT block_date, COUNT(*) AS blocks, MIN(gas_price) AS min_gas_price, MAX(gas_price) AS max_gas_price,
  CAST(SUM(CAST(gas_price AS NUMERIC)) AS STRING) AS sum_gas_price, COUNTIF(gas_price != FLOOR(gas_price)) AS fractional_price_rows,
  COUNTIF(gas_price IS NULL) AS null_price_rows, COUNT(DISTINCT gas_price) AS distinct_prices
FROM `bigquery-public-data.crypto_near_mainnet_us.blocks`
WHERE block_date >= DATE '2026-11-08' AND block_date < DATE '2026-11-09'
GROUP BY block_date ORDER BY block_date;

-- gas_price:2026-11-07 [2026-11-07, 2026-11-08)
SELECT block_date, COUNT(*) AS blocks, MIN(gas_price) AS min_gas_price, MAX(gas_price) AS max_gas_price,
  CAST(SUM(CAST(gas_price AS NUMERIC)) AS STRING) AS sum_gas_price, COUNTIF(gas_price != FLOOR(gas_price)) AS fractional_price_rows,
  COUNTIF(gas_price IS NULL) AS null_price_rows, COUNT(DISTINCT gas_price) AS distinct_prices
FROM `bigquery-public-data.crypto_near_mainnet_us.blocks`
WHERE block_date >= DATE '2026-11-07' AND block_date < DATE '2026-11-08'
GROUP BY block_date ORDER BY block_date;

-- gas_price:2026-11-06 [2026-11-06, 2026-11-07)
SELECT block_date, COUNT(*) AS blocks, MIN(gas_price) AS min_gas_price, MAX(gas_price) AS max_gas_price,
  CAST(SUM(CAST(gas_price AS NUMERIC)) AS STRING) AS sum_gas_price, COUNTIF(gas_price != FLOOR(gas_price)) AS fractional_price_rows,
  COUNTIF(gas_price IS NULL) AS null_price_rows, COUNT(DISTINCT gas_price) AS distinct_prices
FROM `bigquery-public-data.crypto_near_mainnet_us.blocks`
WHERE block_date >= DATE '2026-11-06' AND block_date < DATE '2026-11-07'
GROUP BY block_date ORDER BY block_date;

-- gas_price:2026-11-05 [2026-11-05, 2026-11-06)
SELECT block_date, COUNT(*) AS blocks, MIN(gas_price) AS min_gas_price, MAX(gas_price) AS max_gas_price,
  CAST(SUM(CAST(gas_price AS NUMERIC)) AS STRING) AS sum_gas_price, COUNTIF(gas_price != FLOOR(gas_price)) AS fractional_price_rows,
  COUNTIF(gas_price IS NULL) AS null_price_rows, COUNT(DISTINCT gas_price) AS distinct_prices
FROM `bigquery-public-data.crypto_near_mainnet_us.blocks`
WHERE block_date >= DATE '2026-11-05' AND block_date < DATE '2026-11-06'
GROUP BY block_date ORDER BY block_date;

-- gas_price:2026-11-04 [2026-11-04, 2026-11-05)
SELECT block_date, COUNT(*) AS blocks, MIN(gas_price) AS min_gas_price, MAX(gas_price) AS max_gas_price,
  CAST(SUM(CAST(gas_price AS NUMERIC)) AS STRING) AS sum_gas_price, COUNTIF(gas_price != FLOOR(gas_price)) AS fractional_price_rows,
  COUNTIF(gas_price IS NULL) AS null_price_rows, COUNT(DISTINCT gas_price) AS distinct_prices
FROM `bigquery-public-data.crypto_near_mainnet_us.blocks`
WHERE block_date >= DATE '2026-11-04' AND block_date < DATE '2026-11-05'
GROUP BY block_date ORDER BY block_date;

-- gas_price:2026-11-03 [2026-11-03, 2026-11-04)
SELECT block_date, COUNT(*) AS blocks, MIN(gas_price) AS min_gas_price, MAX(gas_price) AS max_gas_price,
  CAST(SUM(CAST(gas_price AS NUMERIC)) AS STRING) AS sum_gas_price, COUNTIF(gas_price != FLOOR(gas_price)) AS fractional_price_rows,
  COUNTIF(gas_price IS NULL) AS null_price_rows, COUNT(DISTINCT gas_price) AS distinct_prices
FROM `bigquery-public-data.crypto_near_mainnet_us.blocks`
WHERE block_date >= DATE '2026-11-03' AND block_date < DATE '2026-11-04'
GROUP BY block_date ORDER BY block_date;

-- outcomes_full:2026-11-03 [2026-11-03, 2026-11-04)
WITH det AS (
  SELECT d.receipt_id AS receipt_id, MIN(d.predecessor_account_id) AS pred, MIN(d.receipt_kind) AS kind, COUNT(*) AS c
  FROM `bigquery-public-data.crypto_near_mainnet_us.receipt_details` d
  WHERE d.block_date >= DATE '2026-11-03' AND d.block_date < DATE '2026-11-04'
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
  WHERE x.block_date >= DATE '2026-11-03' AND x.block_date < DATE '2026-11-04'
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
ORDER BY 1, 2, 3, 4;

