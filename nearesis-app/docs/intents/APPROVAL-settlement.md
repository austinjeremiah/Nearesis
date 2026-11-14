# Approval request: NEAR Intents settlement duration (BigQuery, nothing run)

Prepared 2026-11-13 (UTC) by A25. Requirement: final_master_prompt section 8 (NEAR Intents), A20 `CANNOT_COMPUTE` for settlement duration. **Nothing in this document was billed.** The only BigQuery calls were free: `tables.get` metadata (column list of `transactions`) and three `dryRun: true` jobs (`pnpm --filter @nearesis/ingestion exec tsx src/intents/settlement-dry-cli.ts`, FREE-only, no billed mode). PostgreSQL and ClickHouse reads were local.

## Why it is needed
The Explorer gives one time per swap, `createdAt`. It has no settlement or completion time. The only route to one is the block time of the NEAR transactions in `nearTxHashes`. Public-era swaps (created before 2026-10-27T00:00Z) name the swap's own NEAR transactions; from that date `nearTxHashes` holds shield/unshield boundary hashes, so settlement duration is defined for the public era only and the private era stays `CANNOT_COMPUTE`.

## The query (read-only, one table, two columns, partition-pruned)
```sql
SELECT t.transaction_hash AS tx_hash, t.block_timestamp AS block_ts_ns
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` AS t
WHERE t.block_date >= DATE '<first swap day>' AND t.block_date < DATE '<last swap day + 2 days>'
  AND t.transaction_hash IN (SELECT h FROM `<project>.nearesis_scratch.settlement_hashes`)
```
- Generator and guard-checked SQL: `services/ingestion/src/intents/settlement-sql.ts` (`settlementSql`); test `settlement-sql.test.ts` passes the repository's BigQuery guard (finite `block_date` range, SELECT only).
- `transactions` is partitioned by `block_date` and not clustered (table metadata), so the hash filter does not reduce bytes; cost = the two columns x the days in the range. `block_timestamp` is INT64 nanoseconds (column list from `tables.get`). The range ends two days after the last swap day: one slack day for settlements after midnight UTC.
- The 214,026 (7 days) or 1,063,602 (30 days) hashes cannot go in one query parameter (request limit 10 MB), and batching them would re-scan the same partitions once per batch. They are loaded once into a scratch table with a free load job (`bq load`, ~10 to 50 MB) and joined: one scan per window. The scratch table is also read by the query (BigQuery bills a minimum of 10 MB per referenced table); that is not in the dry-run numbers below, which measure the `transactions` scan, so budget about +0.05 GiB.
- Duration (computed locally in ClickHouse, not in BigQuery): `settlement_ms = max(block_ts_ns of the swap's hashes) / 1e6 - createdAt(ms)`. A swap with a hash not found is excluded and counted, never zero-filled. Which of the several hashes marks completion (the last is assumed) must be validated on a small sample before the numbers are published; the first run can double as that sample.

## Free dry-run bytes (location us-east1, query cache off, 2026-11-13)
| Window (swap days, UTC) | Partitions read | Swaps / hashes (local import) | Dry-run bytes | GiB | List-price USD (6.25 per TiB) |
| --- | --- | --- | --- | --- | --- |
| 7 days: 2026-10-20 to 2026-10-26 | [10-20, 10-28) | 112,759 / 214,026 | **297,155,352** | 0.277 | 0.0017 |
| 13 days: 2026-10-14 to 2026-10-26 (every public-era day loaded in ClickHouse) | [10-14, 10-28) | 201,450 / 389,650 | 549,448,955 | 0.512 | 0.0031 |
| 30 days: 2026-09-27 to 2026-10-26 | [09-27, 10-28) | 538,447 / 1,063,602 | **1,519,064,414** | 1.415 | 0.0086 |

Machine-readable: `docs/intents/settlement-dry-run-packet.json` (also carries the SHA-256 of the approval SQL per window with the placeholder scratch name `PROJECT.nearesis_scratch.settlement_hashes`; the digest to authorise is recomputed with the real project and table before a run). The 30-day window sits at 1.4% of the 95 GiB daily ledger; the 7-day pilot at 0.3%.

## What is requested
Nothing is requested yet beyond a decision. Recommended: approve the 7-day window first (ceiling 0.35 GiB = 375,000,000 bytes including the scratch table), validate which hash marks completion on the result, then decide on the 30-day window (ceiling 1.6 GiB). A billed run would need: the digest of the exact SQL, a positive byte ceiling, `maximumBytesBilled` equal to the ceiling, and a scratch dataset in the project (us-east1, same location as the public dataset) the owner agrees to create. This worker did not create one and did not run any non-dry job.

## Limits
- Public era only; private-era swaps stay `CANNOT_COMPUTE`.
- `block_timestamp` is block time, not the moment the solver acted; durations are bounded below by block production (about 1 s on NEAR) and measure Explorer `createdAt` to NEAR inclusion, not the user's wait on the destination chain.
- 513 of the 538,447 swaps in the 30-day window have no hash at all (no settlement time possible); the 7-day window has 280 of 112,759.
