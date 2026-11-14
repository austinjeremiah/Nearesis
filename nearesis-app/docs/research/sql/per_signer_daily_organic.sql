-- PREPARED, NOT RUN. Running this is a BigQuery job and an owner decision (about 35 GiB billed for the full window).
-- No dry run was executed either; a free `bq query --dry_run` estimate is also out of scope here.
--
-- Purpose: per-signer daily organic transaction counts, the missing source for the engine's segment cell
-- (robustness.py: head/tail split by segmentHeadAccounts). See docs/research/LIVE_INPUTS.md,
-- "Segment input (prepared, not run)".
--
-- Bytes estimate (from the existing account backfill, which has the same scan shape: date, signer and receiver columns):
--   13 months (2025-11-10 .. 2026-11-11) about 34.9 GiB billed; per month 4.6 to 6.3 GiB; daily budget 97,280 MiB.
-- Month-chunk plan (run one chunk per scheduler budget window, never the whole range as one query):
--   2025-11 (from 2025-11-10), 2025-12, 2026-01, 2026-02, 2026-03, 2026-04, 2026-05, 2026-06, 2026-07, 2026-08,
--   2026-09, 2026-10, 2026-11 (to 2026-11-11 inclusive, i.e. < 2026-11-12).
--   13 chunks; set @start and @end per chunk (end exclusive). Each chunk is written to its own extract file
--   `per_signer_daily_organic_YYYY-MM.csv`, columns: block_date, signer, n_org (schema in live_segments.py).
-- Completeness: the head extract holds signers with n_org >= 100 on that day only. The long tail is never stored per
-- account: the loader derives one exact remainder per day as (organic day total from account_daily_activity) minus the
-- listed rows, so the day total is conserved.
-- Organic definition: identical to the target (intents / verifier / bridge receivers excluded, account rule v1).

SELECT t.block_date AS block_date, t.signer_account_id AS signer, COUNT(*) AS n_org
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions` t
WHERE t.block_date >= DATE '2026-10-01' AND t.block_date < DATE '2026-11-01'   -- chunk bounds (month); end exclusive
  AND t.receiver_account_id NOT IN ('intents.near', 'verifier2.near', 'bridge.near', 'omft.near', 'v2_1.omni.hot.tg')
  AND NOT ENDS_WITH(t.receiver_account_id, '.omft.near')
GROUP BY block_date, signer
HAVING COUNT(*) >= 100   -- keeps the head; the long tail stays an exact remainder row per day (never stored per account)
