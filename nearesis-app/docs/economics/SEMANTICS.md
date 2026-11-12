# NEAR transaction economics: source semantics and metric definitions

Checked 2026-11-13 (UTC). Requirements: final_master_prompt section 7, ch.06, ch.07, D10, D11, S15. Code: `services/ingestion/src/economics/**`, `services/analytics/src/economics/**`.

## Documentation consulted

| Topic | URL | What it fixes |
| --- | --- | --- |
| Gas flow, burning, contract reward, refunds, price range | https://github.com/near/nearcore/blob/master/docs/architecture/how/gas.md | Burnt gas leaves supply. Contract reward `burnt_gas_reward` is 30% up to protocol version 86 and 0% from 87. Gas price moves between 0.1 and 2 NEAR per Pgas (1e8 to 2e9 yoctoNEAR per gas). `min_gas_purchase_price` is 1e9 yocto per gas from protocol version 85. Refund fee (5%, min 1 Tgas) is currently 0. |
| Fees | https://nomicon.io/RuntimeSpec/Fees/ | `gas_burnt` is the irreversible gas spent on computation; "contract account gets 30%" (older wording); unused gas is refunded after the refund fee. |
| Receipts | https://nomicon.io/RuntimeSpec/Receipts | ActionReceipt vs DataReceipt; a receipt is postponed until its data dependencies arrive; `predecessor_id` is `system` for gas and deposit refunds; a receipt's `gas_price` is the price at which its gas was bought; from version 85 it burns at the lower of that price and the executing block's price; refund receipts have gas price 0. |
| Refunds | https://nomicon.io/RuntimeSpec/Refunds | Refund receipts are free to create and run (no tokens burnt) but their execution still reports `gas_burnt` (about 0.22 Tgas). Gas refunds go to the signer; deposit refunds go to the predecessor (or `promise_set_refund_to`). If a refund execution fails the refund amount is burnt. |
| Contract reward removal | https://github.com/near/nearcore/pull/16672 and https://cryptoticker.io/en/near-gas-fees-full-burn-what-to-watch/ | Reward ends at protocol version 87 (nearcore 2.14). Press reports "around October 5, 2026", explicitly not firm. |
| Dataset | `bigquery-public-data.crypto_near_mainnet_us` (table metadata and schema via `bq show`, free) | See below. |

**70/30 verification result.** The 70% burnt / 30% to the called contract split is true for protocol versions up to 86 and is documented as removed from version 87. The mainnet activation date of version 87 is NOT verified from a primary source (the two nearcore pull requests are documentation PRs; the date comes from a news article). The split is therefore a regime parameter (`FeeRegime`), never a constant: `REGIME_PRE_V87` (30% reward) and `REGIME_V87` (all burnt). Any burnt/reward figure is labelled `modelled_from_documented_regime`.

## Source schema (BigQuery, inspected for free)

All tables are day-partitioned on `block_date`, location us-east1.

- `transactions`: `transaction_hash`, `signer_account_id`, `receiver_account_id`, `status` (conversion status only), `converted_into_receipt_id`, `receipt_conversion_gas_burnt` INT64, `receipt_conversion_tokens_burnt` FLOAT64.
- `execution_outcomes`: one row per transaction outcome and per receipt outcome. `receipt_id`, `executor_account_id` (signer for a transaction, receiver for a receipt), `gas_burnt` FLOAT64, `tokens_burnt` FLOAT64, `status` (SUCCESS_VALUE, SUCCESS_RECEIPT_ID, FAILURE, ...).
- `receipt_details`: `receipt_id`, `receipt_kind` (ACTION/DATA), `predecessor_account_id` (`system` for refunds), `receiver_account_id`, `receipt` (JSON, not read).
- `receipt_origin_transaction`: `receipt_id` to `originated_from_transaction_hash`.
- `blocks`: `gas_price` FLOAT64 (yoctoNEAR per gas), `total_supply`.

Observed with free `bq head` on the 2026-10-01 partition: block `gas_price` was 100000000 (1e8) for the sampled blocks; a refund-like outcome showed `gas_burnt` 223182562500 with `tokens_burnt` 0.0; outcome token/gas ratios were 1e8 for most rows and about 9.3e8 for one row. So `tokens_burnt` is NOT always `gas_burnt x block price` (the dataset description says the same), and gas of refund receipts must not be priced.

### Exactness limit that cannot be fixed downstream

`tokens_burnt` and `receipt_conversion_tokens_burnt` are FLOAT64. A yoctoNEAR amount above 2^53 (about 9e15 yocto, i.e. any fee over 0.000000009 NEAR) is therefore already rounded at the source, relative error at most 2^-53 per value. We do not pretend otherwise: every value is converted from the stored double exactly (CAST to BIGNUMERIC), summed exactly in BIGNUMERIC (no float aggregation, no INT64 overflow), carried as a decimal STRING and stored as UInt256. Every table row carries `token_precision = 'source_float64'`. Gas (`gas_burnt`, at most about 3e14) is an integer below 2^53 and exact; rows with a fractional `gas_burnt` are counted (`fractional_gas_rows`) and raise a quality gap.

## Definitions (units are never mixed)

| Quantity | Unit | Definition |
| --- | --- | --- |
| Gas burnt | gas units | `gas_burnt` of an outcome. Reported for refund receipts too. |
| Execution fee | yoctoNEAR | `tokens_burnt`: the gross amount the runtime charged for the burnt gas. Not a price x gas product. |
| Conversion burn | gas, yocto | `receipt_conversion_*` of `transactions`: the cost of converting the transaction into its first receipt. |
| Transaction cost | gas, yocto | conversion burn + every outcome of receipts that originated from the transaction (looking 2 days ahead for delayed receipts). Failed receipts count. |
| Burnt / contract reward | yoctoNEAR | modelled split of the execution fee by regime (floor of fee x 30 / 100 for the reward, remainder burnt). |
| Gas price | yocto per gas | `blocks.gas_price`; daily min, max, exact sum and block count (mean = sum / blocks). |
| Effective burn price | yocto per gas | execution fee / gas, over non-refund outcomes only. |
| Execution intensity | gas per tx, yocto per tx, receipts per tx | exact ratio, null when there are no transactions. |
| Percentiles | yoctoNEAR, gas | p50, p90, p99, p99.9 of per-transaction cost from `APPROX_QUANTILES(x, 1000)`: approximate, labelled `bigquery_approx_quantiles_1000`, `exact: false`. |
| High-cost transactions | yoctoNEAR | top 20 transactions per day by fee, filtered by an exact yocto threshold at read time. |
| Gas by contract/application | gas, yocto | by executing account (`near_economics_outcomes_daily`) and by transaction receiver (`near_economics_tx_receiver_daily`); an application mapping comes from A17's registry resolver `appOf(account, day)`, unmapped accounts stay under their account id, accounts under 100 outcomes (or transactions) a day fold into `__below_threshold__` with exact totals. |
| USD | USD | only with a timestamped CoinGecko price: `usd = yocto x priceUsd / 1e24`, rounded once half-even. Every value carries `conversion{method, source, priceUsd, priceTimestampUTC, rounding}`. Without a price the value is null with reason `NO_TIMESTAMPED_PRICE`, never 0. Methods: `coingecko_daily_close_utc`, `..._open_utc`, `..._mid_hl_utc`. |

### Two time bases

`near_economics_outcomes_daily` is on the execution day (the block date of the outcome). `near_economics_tx_*` is on the transaction day (receipts are attributed to the day their transaction was signed). Daily totals differ at day edges by construction. They reconcile as follows, and the result is reported, not forced:

- within a family: per-receiver rows (named + folded) sum to the day row for transactions, receipts, gas and tokens (enforced at load; the loader refuses a chunk that fails); `total = conversion + receipt` for gas and for tokens;
- across families: tokens of `NO_RECEIPT_ROW` outcomes should equal the conversion burn of `transactions` on the same day (`reconcileOutcomesToTransactions`).

## What is not "protocol revenue"

Execution fees are not called protocol revenue anywhere. Up to protocol version 86 a modelled 30% went to the called contract's account (an application reward, not protocol income), the rest was burnt (supply reduction, not income); from version 87 all is burnt. Validators are paid from inflation, not from these fees. No metric, table or label in this build is named revenue; `economics.externally_reported_revenue_usd` (ch.06) is a different, externally sourced metric.

## Known gaps (recorded as `quality_gaps`)

- `REFUND_VALUE_NOT_DERIVED` (every chunk): the NEAR value of gas and deposit refunds sits in the `receipt` JSON, which this build does not scan (cost). Refund receipts are counted (`outcome_kind = REFUND`, gas reported, tokens 0); the 5% refund fee is 0 at protocol 78 to current, so refunds do not change burnt tokens.
- `TX_WITHOUT_RECEIPT_OUTCOMES`: transactions whose receipts were not found within the window (delayed beyond 2 days or odd structure).
- `DUPLICATE_RECEIPT_DETAILS`: `receipt_details` rows duplicated per receipt id (deduplicated by MIN, counted).
- `FRACTIONAL_GAS_ROWS`, `GAS_PRICE_ODD_VALUES`, `PROVIDER_GAP` (a missing day is `unavailable`, never zero).
- Delayed receipts that execute in a different month than their `receipt_details` row can show as `NO_RECEIPT_ROW`; `reconcileOutcomesToTransactions` makes the effect visible.
- Whether `execution_outcomes` contains the transaction outcomes (executor = signer) is inferred from the column description and checked at reconcile time, not assumed.
- Protocol version 87 activation date is unverified (see above).

## Rule version 2: lean load (A24, 2026-11-13)

The owner did not approve A18's 1,339 GiB plan. Default families now read only numeric and key columns without joins: `outcomes` (`execution_outcomes`: block_date, executor_account_id, gas_burnt, tokens_burnt), `conversion` (`transactions`: receiver and the two receipt_conversion columns) and `gas_price`. See `APPROVAL-PACKET-pilot.md` for bytes and costs.

- `outcome_kind` is `BURNING` (tokens_burnt > 0), `ZERO_TOKEN` (tokens_burnt = 0; refund receipts burn nothing but report about 0.22 Tgas, so ZERO_TOKEN is a PROXY for refunds, never an exact refund count) or `NULL_FIELDS`; `status_class` is `UNKNOWN`. The A18 kinds (ACTION, DATA, REFUND, NO_RECEIPT_ROW) now exist only in the validation family `outcomes_full`, which is archived and compared, never loaded (it would double count).
- Receipt-only burn is outcomes minus conversion, valid only if `execution_outcomes` includes the transaction outcomes; the pilot checks this (`reconcileLeanToConversion`).
- Per-transaction cost, percentiles and top transactions (`tx_cost`) are optional and priced separately.
- Gap `REFUND_SPLIT_IS_PROXY` on every lean chunk; `REFUND_VALUE_NOT_DERIVED` stays.
- Table `near_economics_conversion_daily` (scope day|receiver) is new; DDL in `migrations-live/009_economics.sql`.
