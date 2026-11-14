SELECT block_date, COUNT(*) AS blocks, MIN(gas_price) AS min_gas_price, MAX(gas_price) AS max_gas_price,
  CAST(SUM(CAST(gas_price AS NUMERIC)) AS STRING) AS sum_gas_price, COUNTIF(gas_price != FLOOR(gas_price)) AS fractional_price_rows,
  COUNTIF(gas_price IS NULL) AS null_price_rows, COUNT(DISTINCT gas_price) AS distinct_prices
FROM `bigquery-public-data.crypto_near_mainnet_us.blocks`
WHERE block_date >= DATE '2026-10-01' AND block_date < DATE '2026-11-01'
GROUP BY block_date ORDER BY block_date
