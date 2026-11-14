-- No SQL: this output is produced by scanning archived raw Explorer pages (.data/backfill/raw/<hash[0:2]>/<hash>)
-- in the order of their fetch time recorded in ClickHouse; each swap is counted once from its latest page.
-- Page list (ClickHouse, SELECT only):
SELECT raw_object_hash AS h FROM nearesis_live.intents_swaps FINAL GROUP BY raw_object_hash ORDER BY max(fetched_at), raw_object_hash;
-- Fee USD = amountInUsd (input) x appFees[].fee / 10000, summed over fee entries (fee is integer basis points per the 1Click docs).
