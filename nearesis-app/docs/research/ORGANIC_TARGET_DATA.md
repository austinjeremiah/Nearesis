# Live organic-target data (account-level daily activity)

Source: `nearesis_live.account_daily_activity` (one row per UTC day, 2025-11-10 onward; forward days are added by the scheduler bq task). Use `FINAL`.

| Target                   | Expression                                       |
| ------------------------ | ------------------------------------------------ |
| Unadjusted               | `tx_total` (equals `near_daily_tx.tx_count`)     |
| Organic (primary, ch.08) | `tx_organic = tx_total - tx_intents - tx_bridge` |
| Sensitivity top-1%       | `tx_organic - top1pct_organic_tx`                |
| Sensitivity top-5%       | `tx_organic - top5pct_organic_tx`                |

Top-p% means the ceil(p% of organic signers) signers with the most organic transactions that day. Signer counts: `signers_total`, `signers_organic`, `signers_with_intents` are per-day only and not summable across days. `account_daily_heavy_signers` lists signers with at least 1000 tx per day (with an `intents_generated` flag when Intents+bridge tx are the majority); the long tail is not stored per account. The flag rule is receiver based and versioned (`account_rule_version`, `services/ingestion/src/backfill/account-sql.ts`). A day absent from the table is unavailable (see `source_coverage` dataset `account_daily_activity`), never zero. See FND-20261111-018 for the concentration caveat.
