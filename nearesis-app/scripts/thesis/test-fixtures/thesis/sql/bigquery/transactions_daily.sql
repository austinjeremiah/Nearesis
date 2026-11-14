-- fixture BigQuery for transactions_daily
DECLARE start_date DATE DEFAULT DATE '2026-05-05';
SELECT block_date FROM t WHERE block_date >= start_date;
