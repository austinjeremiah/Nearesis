# Tables and endpoints used by the thesis track

Window of every chart dataset: block_date / created_day 2026-05-05 .. 2026-11-11 inclusive (the v3 research window, so charts and the frozen research results describe the same period). Frozen files and hashes: `raw/manifest.json`. Rebuild raw data with `pnpm thesis:data` (local databases only; add `--bigquery` to also re-run the billed BigQuery queries).

## BigQuery public dataset `bigquery-public-data.crypto_near_mainnet_us`

All four queries run against the `transactions` table, always with finite `block_date >= start_date AND block_date < end_date` bounds (DECLAREd date literals, no OR, checked by the static guard before a dry run; the dry run precedes every billed job; `maximumBytesBilled` = ceil(dry-run bytes x 1.1)). Executed 2026-11-14, job location us-east1. Each SQL file's header holds the dry-run bytes, bytes billed, row count and result sha256; the results are in `raw/bq_*.json`.

| Table | Columns used | Purpose | Query file |
| --- | --- | --- | --- |
| `transactions` | `block_date` (row count) | daily transactions | `sql/bigquery/transactions_daily.sql` |
| `transactions` | `block_date`, `signer_account_id` | daily active accounts (distinct signers) | `sql/bigquery/active_accounts_daily.sql` |
| `transactions` | `block_date`, `receiver_account_id` | distinct receiver accounts and transactions per day (contract usage) | `sql/bigquery/contract_usage_daily.sql` |
| `transactions` | `block_date`, `receiver_account_id` | top 100 receivers over the window | `sql/bigquery/contract_usage_top.sql` |

`receipt_actions` (function-call actions) was loaded earlier into ClickHouse by the project backfill and is the source of the local contract-usage series; it was not queried again for the thesis (4-20 GiB per month).

## NEAR Intents Explorer API (ingested, not queried live here)

`GET <explorer base>/api/v0/transactions` with query `numberOfTransactions`, `direction=next`, cursor `lastDepositAddress` / `lastDepositMemo`, and `startTimestampUnix` / `endTimestampUnix`. Authentication: a Bearer JWT read from the environment variable named `INTENTS_EXPLORER_JWT` (value never stored or printed). Rate limit: one request per 5 seconds. Fields used: swap status, created time, origin/destination asset, USD amounts (`amount_in_usd`). The pulled swaps are stored in the local table `intents_swaps` below; `pnpm thesis:data` makes no Explorer calls.

## Local ClickHouse database `nearesis_live` (read only)

| Table / view | Columns used | Purpose | Dataset |
| --- | --- | --- | --- |
| `intents_swaps` (FINAL) | `created_day`, `status`, `amount_in_usd` | Intents volume (SUCCESS only, USD) and swap counts | `intents_volume_daily`, `intents_swaps_daily` |
| `account_daily_activity` (FINAL) | `block_date`, `signers_total`, `signers_organic` | daily distinct signers (from BigQuery `transactions`) | `active_accounts_daily` |
| `near_daily_tx` (FINAL) | `block_date`, `tx_count` | daily transactions (from BigQuery `transactions`) | `transactions_daily` |
| `near_daily_usage` (view over `near_daily_tx`, `contract_interactions`, `contract_interactions_below_threshold`) | `block_date`, `function_call_actions`, `active_contract_count` | daily function calls and active contracts | `contract_usage_daily` |
| `contract_interactions` (FINAL) | `block_date`, `receiver_account_id`, `interactions` | top receivers (only receiver-days with >= 100 calls are held) | `contract_usage_top` |
| `price_candles` (FINAL) | `day`, `close_raw`, `bucket_start`, `interval`, `symbol`, `quote_currency` | NEAR price (last hourly sample of the day) | `near_price_daily` |
| `source_coverage` (FINAL) | `dataset`, `day`, `state` | which days are partial (intents_swaps on 2026-07-23) | caveats |

The exact local query of each dataset is in `sql/executed/<dataset>.sql`.

## Sample query

Daily active accounts (distinct signers) for the window, exactly as in `sql/bigquery/active_accounts_daily.sql` (BigQuery, executed for this thesis; result `raw/bq_active_accounts_daily.json`):

```sql
DECLARE start_date DATE DEFAULT DATE '2026-05-05';
DECLARE end_date DATE DEFAULT DATE '2026-11-12';
SELECT t.block_date AS block_date,
  COUNT(DISTINCT t.signer_account_id) AS distinct_signers
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
WHERE t.block_date >= start_date AND t.block_date < end_date
GROUP BY block_date ORDER BY block_date
```

Local equivalence: the column equals `account_daily_activity.signers_total` day for day (and the BigQuery transaction count equals `near_daily_tx.tx_count`) (see the comparison in `raw/manifest.json` caveats).
