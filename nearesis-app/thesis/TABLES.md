# Tables and endpoints used by the reference thesis

Window of every daily dataset: UTC days 2025-11-10 .. 2026-11-13 inclusive (the earliest and the last full day held in every account table). Swap data through 2026-11-14 is partial and is not used. Frozen files and hashes: `raw/manifest.json`. Rebuild raw data with `pnpm thesis:data` (read-only SELECTs on the local database; add `--bigquery` to also re-run the billed BigQuery cross-checks), then `pnpm thesis:build` and `pnpm thesis:verify`.

## BigQuery public dataset `bigquery-public-data.crypto_near_mainnet_us`

Both queries read the `transactions` table only, always with finite `block_date >= start_date AND block_date < end_date` bounds (DECLAREd date literals, no OR, checked by the static guard before a dry run; the dry run precedes every billed job; `maximumBytesBilled` = ceil(dry-run bytes x 1.1)). Each SQL file's header holds the dry-run bytes, bytes billed, row count and result sha256 (or says NOT EXECUTED); results are in `raw/bq_*.json`; the comparison with the local series is in `raw/manifest.json` under `crossChecks`.

| Table | Columns used | Purpose | Query file |
| --- | --- | --- | --- |
| `transactions` | `block_date`, `signer_account_id` | daily transactions and distinct signers | `sql/bigquery/transactions_signers_daily.sql` |
| `transactions` | `block_date`, `signer_account_id`, `receiver_account_id` | Intents, bridge, organic, head and tail transactions and signers per day | `sql/bigquery/account_scan_daily.sql` |

## NEAR Intents Explorer API (ingested, not queried live here)

The pulled swaps are stored in the local table `intents_swaps`; `pnpm thesis:data` makes no Explorer calls. Fields used: swap status, created time, origin/destination asset, USD amount of the input.

## Local ClickHouse database `nearesis_live` (read only)

| Table | Columns used | Purpose | Dataset |
| --- | --- | --- | --- |
| `account_daily_activity` (FINAL) | `block_date`, `tx_total`, `tx_intents`, `tx_organic`, `signers_total`, `signers_organic` | day totals from the account scan | `intents_tx_daily`, `transactions_daily` |
| `account_daily_tail` (FINAL) | `block_date`, `tail_tx`, `tail_signers` | long tail below the head threshold | `tail_daily` |
| `account_daily_head` (FINAL) | `block_date`, `signer_account_id`, `tx_organic` | heavy-head accounts | `transactions_daily`, `head_accounts_break` |
| `account_daily_new_returning` (FINAL) | `block_date`, `new_signers`, `top10_tx` | new signers, top-ten transactions | `new_signers_daily`, `transactions_daily` |
| `intents_swaps` (FINAL) | `created_day`, `status`, `amount_in_usd`, `origin_asset`, `destination_asset` | settled volume, swap counts, composition | `intents_volume_daily`, `swaps_daily`, `intents_mix_daily`, `chain_pairs_monthly`, `excursion_routes` |
| `asset_registry` (FINAL) | `provider_asset_id`, `symbol_observed`, `blockchain`, `verification` | which asset is a stablecoin, a NEAR-chain asset or the NEAR token | `intents_mix_daily`, `asset_sets` |
| `price_candles` (FINAL) | `day`, `close_raw`, `bucket_start`, `interval`, `symbol`, `quote_currency` | NEAR daily close | `near_price_daily` |
| `source_coverage` (FINAL) | `provider_id`, `dataset`, `day`, `state`, `reason` | days with partial swap data | `swaps_coverage` |

The fee inputs (NEAR burnt, take rate, user-paid spread) are produced separately into `raw/fees/` with their own manifest; the build reads them when they exist.

The exact local query of each dataset is in `sql/executed/<dataset>.sql`.

## Sample query

Daily transactions and distinct signers (BigQuery; executed for this thesis, result `raw/bq_transactions_signers_daily.json`, equal day for day to the local series):

```sql
DECLARE start_date DATE DEFAULT DATE '2025-11-10';
DECLARE end_date DATE DEFAULT DATE '2026-11-14';
SELECT t.block_date AS block_date,
  COUNT(*) AS tx_count,
  COUNT(DISTINCT t.signer_account_id) AS distinct_signers
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
WHERE t.block_date >= start_date AND t.block_date < end_date
GROUP BY block_date ORDER BY block_date
```
