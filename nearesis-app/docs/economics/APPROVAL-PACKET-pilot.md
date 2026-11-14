# Approval packet: NEAR gas and fees, seven-day pilot and cheaper architecture

Prepared 2026-11-13 (UTC) by worker A24. Requirements: final_master_prompt section 7, ch.06, ch.07, D10, D11, S15. Responds to the owner decision of 2026-11-13: the 1,339 GiB full-year scan is NOT approved; gas and fees stay in scope; audit, cheaper design, free dry runs, bounded seven-day pilot, no paid execution without budget authorisation.

**Nothing in this packet was billed.** Every number below is a free dry run (`dryRun: true`, `bq query --dry_run`) or free table metadata (`bq show table$YYYYMMDD`, which is tables.get and returns per-partition row counts and bytes). No BigQuery data was read, no row was loaded, no INFORMATION_SCHEMA query was run (those are billed). Only `migrateEconomics()` ran on ClickHouse `nearesis_live` (CREATE TABLE IF NOT EXISTS, six empty tables) so coverage reads "unavailable" rather than "unknown source".

## 1. What is requested

Authorise ONE billed run of exactly the SQL in `docs/economics/sql/pilot-2026-11-03_09.sql`:

- digest `68108c233c238f4ca466a2648fd59b998a25f9f1e79b9456e933f6b678c307f2` (SHA-256 over the SQL text of every chunk, `planDigest`);
- ceiling **1,965,896,095 bytes (1.83 GiB), USD 0.0112 at list price** (set `approvedMaxBytes` to this; each job additionally carries `maximumBytesBilled` = 1.1 x its own estimate, and the daily ledger of 95 GiB applies);
- window 2026-11-03 to 2026-11-09 inclusive (7 execution days), one extra reference day (2026-11-03) of the old join query used only for validation.

The billed runner (`runEconomicsPhase`) refuses to run without BOTH the matching digest and a positive `approvedMaxBytes`, and skips any chunk that would push the cumulative estimate over it. The CLI (`pnpm --filter ingestion economics:dry-run -- --pilot`) has no billed mode.

## 2. Audit of what we already have

**ClickHouse `nearesis_live`** (columns read from `system.columns`): `near_daily_tx` (block_date, tx_count, distinct_signer_proxy), `contract_interactions` (block_date, receiver_account_id, project, taxonomy, interactions), `contract_interactions_below_threshold`, `account_daily_*` / `account_head_*` / `account_cohort_*` (signer counts, tx counts, thresholds), `entity_*`, `intents_swaps`, `price_candles`, `quote_*`. **No table carries a gas, fee, token-burnt, gas-price or receipt column.** The five `near_economics_*` tables existed only in code (A19 hit UNKNOWN_SOURCE); they, plus the new `near_economics_conversion_daily`, now exist empty on `nearesis_live` and as `services/ingestion/migrations-live/009_economics.sql`.

**Archived BigQuery raw results** `.data/backfill/raw` (5,099 objects, 6.2 GB) and `.data/scheduler/raw` (935 objects, 137 MB): scanned byte-for-byte for `gas_burnt`, `tokens_burnt`, `receipt_conversion`, `gas_price`, `total_supply`: **zero hits**. The existing jobs only read `transactions` (hash/signer/receiver/status for counts) and `receipt_actions` (receiver counts); gas and fee fields were never fetched, so nothing can be reused and history must come from BigQuery.

**Public dataset** `bigquery-public-data.crypto_near_mainnet_us` (us-east1), from table metadata: all five tables are day-partitioned on `block_date` and **none is clustered**, so day-partition pruning is the only pruning available; there is no clustering-aware filter to exploit. Billing is by bytes of the columns read in the pruned partitions.

| Table | Rows | Total bytes | Gas / fee columns | Needed for fees |
| --- | --- | --- | --- | --- |
| `execution_outcomes` | 22.7 B | 10.6 TB | `gas_burnt` FLOAT, `tokens_burnt` FLOAT, `executor_account_id`, `status`, `receipt_id`, `logs`, ... | yes: the cheapest complete source of fees (one row per transaction outcome and per receipt outcome) |
| `transactions` | 5.49 B | 2.58 TB | `receipt_conversion_gas_burnt` INT64, `receipt_conversion_tokens_burnt` FLOAT | conversion burn only, 3 columns |
| `receipt_details` | 24.5 B | 21.7 TB | none (`receipt` JSON is the heaviest column) | NOT needed for fees |
| `receipt_origin_transaction` | 24.5 B | 3.1 TB | none | only for per-transaction cost |
| `blocks` | 214 M | 34.9 GB | `gas_price` FLOAT | yes, ~2 MB/day |

Measured dry-run bytes per single column on 2026-10-15: `gas_burnt` 229 MB, `tokens_burnt` 229 MB, `executor_account_id` 451 MB, `status` 331 MB, `receipt_id` 773 MB, `logs` 1,749 MB (and 3.4 GB in Feb 2026); `receipt_details` receipt_id+predecessor+kind 1,182 MB; `receipt_origin_transaction` 1,481 MB. `execution_outcomes` carries executor, gas and tokens itself, so **the receipt_details join is not needed for fees.** `receipt_details` is what A18 used only to label ACTION/DATA/REFUND and it costs more than the whole lean design.

## 3. Why A18 cost 1,339 GiB

A18's two big families were `outcomes` (591 GiB: `execution_outcomes` with receipt_id, status, executor, gas, tokens, joined to `receipt_details` receipt_id/predecessor/kind) and `tx_cost` (747 GiB: `transactions` joined to `execution_outcomes` joined to `receipt_origin_transaction`, so three large tables and the receipt_id string column of two of them, scanned for 3 days of look-ahead as well). `gas_price` was 0.8 GiB. Of the outcomes family `receipt_details` alone was about 45% of it (1.5 of 3.4 GiB on a Dec to Mar day). Joins and string key columns, not the numeric columns, dominated.

**Why December 2025 to March 2026 is about 4x larger per month:** the dry-run per-day sweep (365 days, below) and free partition metadata show a step change at 2026-04-02 in row counts, not in column width or in anything A18 did:

| Partition | execution_outcomes rows | transactions rows | execution_outcomes bytes (all cols) |
| --- | --- | --- | --- |
| 2026-02-15 | 17.0 M | 3.79 M | 8.3 GB |
| 2026-03-30 | 16.4 M | 3.46 M | 8.2 GB |
| 2026-04-01 | 13.8 M | 3.76 M | 6.8 GB |
| 2026-04-02 | 3.6 M | 1.06 M | 2.2 GB |
| 2026-04-15 | 2.9 M | 0.76 M | 1.9 GB |
| 2026-11-03 | 3.0 M | 0.60 M | 2.0 GB |
| 2026-10-11 (spike) | 27.6 M | 1.11 M | 10.1 GB |

Pre-2026-04-02 days (143 of the 365) hold 125.3 GiB of the lean cost versus 43.4 GiB for the 222 days after; in A18's packet they were 1,000 of 1,339 GiB (outcomes 438 vs 153, tx_cost 562 vs 185). The data volume genuinely fell about 4 to 5x on 2026-04-02 for every table at once. The cause (an on-chain activity change such as a bot or spam regime) is not stated in the dataset and is not asserted here. 2026-10-11 is a receipt-heavy burst (25 outcomes per transaction); it is the most expensive lean day (1.25 GiB).

## 4. Cheaper architecture (rule version 2, implemented)

| Principle | Implementation |
| --- | --- |
| Column projection | `outcomes`: `execution_outcomes(block_date, executor_account_id, gas_burnt, tokens_burnt)`. No status, receipt_id, logs, block hashes. `conversion`: `transactions(block_date, receiver_account_id, receipt_conversion_gas_burnt, receipt_conversion_tokens_burnt)`. `gas_price`: `blocks(block_date, gas_price)`. |
| Partition pruning | every query has finite `block_date >= DATE .. AND < DATE ..` bounds; the unit is one day. |
| No joins | `receipt_details` and `receipt_origin_transaction` are out of the default plan. |
| Existing receipt fee fields | `receipt_conversion_*` of `transactions` gives the conversion burn for 0.03 to 0.2 GiB/day; receipt-only burn is derived as outcomes minus conversion and is CHECKED on the reference day, not assumed. |
| Incremental daily aggregation | one chunk per day (`planDailyChunks`), idempotent ReplacingMergeTree load, forward cost per day in section 6. |
| Clustering | not possible: no table is clustered. |

Semantics kept from A18: exact BIGNUMERIC sums, decimal STRING output, UInt128 gas / UInt256 yocto, every row tagged `token_precision = 'source_float64'`, the 30% contract reward as a regime parameter only (`modelled_from_documented_regime`), no metric or label called protocol revenue, USD only with a timestamped price.

What changes, stated plainly:
- **Refund split is a proxy.** Lean `outcome_kind` is `BURNING` (tokens_burnt > 0), `ZERO_TOKEN` (tokens_burnt = 0: refund receipts, which burn nothing but report about 0.22 Tgas, plus any other zero-fee execution) or `NULL_FIELDS`. `status_class` is `UNKNOWN`. Gas and tokens totals are unaffected. The gap `REFUND_SPLIT_IS_PROXY` is recorded on every lean chunk, and the pilot measures the proxy's error (check 1).
- **No per-transaction cost, percentiles or top transactions in the default plan.** They need `receipt_origin_transaction` (about 2 GiB/day more) and are a separately priced optional family (`tx_cost`, 2.03 GiB for the reference day, USD 0.0124).
- Metric proposals were re-based on the lean tables (execution fee and gas per execution outcome, transactions, conversion fee, mean gas price); the per-transaction proposals were removed until `tx_cost` is approved.

## 5. The seven-day pilot (2026-11-03 to 2026-11-09)

Exact SQL: `docs/economics/sql/pilot-2026-11-03_09.sql` (generated by `economics:dry-run -- --pilot --sql`); dry-run packet: `docs/economics/pilot-dry-run-packet.json`. Dry runs at 2026-11-12T19:11:45.739Z.

| Chunk | Estimated bytes | GiB | USD at list price |
| --- | --- | --- | --- |
| conversion:2026-11-03 | 26,978,659 | 0.0251 | 0.000153 |
| conversion:2026-11-04 | 31,542,270 | 0.0294 | 0.000179 |
| conversion:2026-11-05 | 37,740,608 | 0.0351 | 0.000215 |
| conversion:2026-11-06 | 32,827,947 | 0.0306 | 0.000187 |
| conversion:2026-11-07 | 30,585,451 | 0.0285 | 0.000174 |
| conversion:2026-11-08 | 27,276,518 | 0.0254 | 0.000155 |
| conversion:2026-11-09 | 40,663,418 | 0.0379 | 0.000231 |
| gas_price:2026-11-03 | 2,417,040 | 0.0023 | 0.000014 |
| gas_price:2026-11-04 | 2,324,832 | 0.0022 | 0.000013 |
| gas_price:2026-11-05 | 2,397,920 | 0.0022 | 0.000014 |
| gas_price:2026-11-06 | 2,397,296 | 0.0022 | 0.000014 |
| gas_price:2026-11-07 | 2,390,624 | 0.0022 | 0.000014 |
| gas_price:2026-11-08 | 2,417,808 | 0.0023 | 0.000014 |
| gas_price:2026-11-09 | 2,397,264 | 0.0022 | 0.000014 |
| outcomes:2026-11-03 | 137,600,694 | 0.1282 | 0.000782 |
| outcomes:2026-11-04 | 165,580,327 | 0.1542 | 0.000941 |
| outcomes:2026-11-05 | 192,584,034 | 0.1794 | 0.001095 |
| outcomes:2026-11-06 | 173,804,488 | 0.1619 | 0.000988 |
| outcomes:2026-11-07 | 146,332,669 | 0.1363 | 0.000832 |
| outcomes:2026-11-08 | 131,161,661 | 0.1222 | 0.000746 |
| outcomes:2026-11-09 | 191,658,283 | 0.1785 | 0.001089 |
| outcomes_full:2026-11-03 | 582,816,284 | 0.5428 | 0.003313 |
| **Total** | **1,965,896,095** | **1.8309** | **0.011175** |

Lean seven days: 1,383,079,811 B (1.29 GiB, USD 0.0079). Reference-day validation: 582,816,284 B (0.54 GiB, USD 0.0033). Optional, NOT in the digest and NOT requested: `tx_cost` reference day 2,178,572,142 B (2.03 GiB, USD 0.0124).

**Price used:** USD 6.25 per TiB on-demand analysis (https://cloud.google.com/bigquery/pricing, read 2026-11-13: "$6.25 / 1 tebibyte ... The first 1 TiB per month is free"). That is the list price; the page prices regions separately and the billing account is in INR, so USD is an estimate, not an invoice. **The free first TiB per month and the trial credits are not assumed**: whether the billing account has already used its free TiB this month or has credit left was not checked (no billed or billing-API call was made), so every USD figure here is the no-free-tier upper bound. The project quota override (100 GiB/day, ADR-20261110-005 uses 95 GiB) and the INR 2,100/month budget are the binding guardrails; the pilot is 1.83 GiB, 1.9% of one quota day.

**What the pilot validates** (pure functions in `reconcile.ts`, run on the loaded and archived rows):
1. `compareLeanToFull`: for the reference day the lean totals (gas, tokens, outcome count) must equal the A18 join query; the refund proxy is measured (ZERO_TOKEN outcomes vs REFUND outcomes, zero-token non-refund rows, refund receipts that burn tokens).
2. `reconcileLeanToConversion`: execution outcomes contain the transaction outcomes, i.e. outcome gas and tokens >= conversion burn and outcomes >= transactions, giving receipt-only burn as a difference. A failure means `execution_outcomes` does NOT include the transaction rows and the design must add a term.
3. Per-receiver conversion rows (named + folded) sum to the day row (enforced at load; the loader refuses a failing chunk).
4. `checkGasPriceRows`: block gas price inside the protocol range 1e8 to 2e9 yocto per gas, min <= sum/blocks <= max.
5. Fractional gas rows, null fields and fold-threshold totals reported as quality gaps; missing days stay `unavailable`, never zero.
6. Float64 precision tag present on every token value; effective burn price = fee / gas over non-refund (BURNING) outcomes within a plausible band.
7. Day-edge behaviour between the execution-day and transaction-day bases (reported, not forced).
The window is after 2026-10-05, the press-reported (unverified) date of protocol version 87; it cannot validate the contract-reward regime, which is a documented parameter and not observable in these tables.

## 6. Cost under the new design (dry-run per day, all 365 days of 2025-11-10 to 2026-11-09)

Per-day lean cost (outcomes + conversion + gas_price): last 30 days mean 0.240 GiB (257,857,412 B, USD 0.00147), last 7 days mean 0.184 GiB, maximum day 1.249 GiB (2026-10-11), minimum 0.121 GiB (2026-04-25). **Forward-only incremental: about USD 0.0015 per day, about USD 0.54 per year at the last-30-day rate.** Example day 2026-11-09: 234,718,965 B (0.22 GiB, USD 0.0013), `docs/economics/daily-dry-run-packet.json`.

| Backfill (counting back from 2026-11-09) | Bytes | GiB | USD at list | Quota days (95 GiB) |
| --- | --- | --- | --- | --- |
| last 30 days (2026-10-11 to 2026-11-09) | 7,735,722,388 | 7.20 | 0.0440 | 1 |
| last 90 days (2026-08-12 to 2026-11-09) | 21,671,192,451 | 20.18 | 0.1232 | 1 |
| last 365 days (2025-11-10 to 2026-11-09) | 181,086,651,533 | 168.65 | 1.0294 | 2 |

Old design for comparison: 1,437,597,583,912 B = 1,338.87 GiB = USD 8.17 at the same price, 20 quota days. The new full year is 168.65 GiB (USD 1.03), 12.6% of the bytes, **an 87% reduction**; most of what remains is the Dec 2025 to Mar 2026 high-volume period (125 GiB).

Per month (lean, all three families):

| Month | Days | GiB | GiB per day | USD |
| --- | --- | --- | --- | --- |
| 2025-11 | 21 | 20.03 | 0.954 | 0.1223 |
| 2025-12 | 31 | 27.57 | 0.889 | 0.1683 |
| 2026-01 | 31 | 26.24 | 0.846 | 0.1601 |
| 2026-02 | 28 | 23.88 | 0.853 | 0.1457 |
| 2026-03 | 31 | 26.66 | 0.860 | 0.1627 |
| 2026-04 | 30 | 5.82 | 0.194 | 0.0355 |
| 2026-05 | 31 | 5.49 | 0.177 | 0.0335 |
| 2026-06 | 30 | 5.59 | 0.186 | 0.0341 |
| 2026-07 | 31 | 5.25 | 0.169 | 0.0320 |
| 2026-08 | 31 | 5.69 | 0.183 | 0.0347 |
| 2026-09 | 30 | 6.43 | 0.214 | 0.0392 |
| 2026-10 | 31 | 8.44 | 0.272 | 0.0515 |
| 2026-11 | 9 | 1.57 | 0.174 | 0.0096 |

Totals-only variant (drop `executor_account_id`: gas and fee totals without per-contract split): about 0.54x of the lean bytes (measured on the weekly sample days). Not the default, because per-contract gas is a requirement.

Expansion plan, each step a separate owner approval with its own digest: (1) pilot above; (2) last 90 days (20.18 GiB, USD 0.12); (3) the rest of the 365-day window newest first (148.5 GiB, USD 0.90) in chunks of at most one quota day; (4) the forward daily job (scheduler wiring is an integration-queue item, below); (5) optional `tx_cost` on sampled days or forward-only if the owner wants per-transaction percentiles. History before 2025-11-10 would be priced with the same free sweep first.

## 7. Limits and open items

- tokens_burnt is FLOAT64 at the source; values above 2^53 yocto carry up to 2^-53 relative error already (tagged on every row).
- Refund NEAR value (in the `receipt` JSON, about the heaviest column of the 21.7 TB `receipt_details`) is not derived; refund counts are a proxy until the pilot measures it.
- Protocol-version 87 activation date is unverified (SEMANTICS.md).
- Scheduler wiring of the daily job (a new phase in `scheduler/cli.ts`) is not done and needs a scheduler restart after approval.
- The commit does not run any billed job. A billed pilot needs the digest and `approvedMaxBytes` above, plus an `approvedMaxBytes`-aware caller (the runner is wired; no CLI invokes it).
