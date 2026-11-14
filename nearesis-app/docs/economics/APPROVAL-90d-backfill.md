# Approval record: NEAR gas and fees, 90-day backfill (lean design)

Owner decision 2026-11-13: "I allowed 90 day backfill" (ADR-20261112-001, "Owner decision 2026-11-13 22:00Z"). Lead bounds applied exactly:

- Design: A24 lean families only (`outcomes`, `conversion`, `gas_price`), one chunk per (day, family), newest day first.
- Window: 2026-08-12 .. 2026-11-02 inclusive (83 days = the 90 days 2026-08-12..2026-11-09 minus the 7 pilot days 2026-11-03..09 already loaded). 249 chunks.
- **NEW plan digest (`planDigest`, SHA-256 over every chunk id and SQL text): `7f25a2bd2c66b3a76e7cce3134bfe34c1df5b4e6ef2d4d3c88197497aefce5bf`** (differs from the pilot digest 68108c23...).
- `approvedMaxBytes` = 22,548,578,304 (21 GiB).
- Free dry run at 2026-11-12T21:57:23Z: total 20,288,112,640 B (18.89 GiB, USD 0.1153 at list); each job counted at least its 10 MiB billing minimum, the ceiling basis (counting the 10 MiB minimum per job) is 20,969,180,912 B (19.53 GiB), both <= 21 GiB. Per family: outcomes 17,182,871,687 B, conversion 2,915,991,145 B, gas_price 189,249,808 B. Per-chunk bytes: `docs/economics/backfill-90d-dry-run-packet.json`.
- Guards: digest + approvedMaxBytes required by the runner, cumulative ceiling check, per-job `maximumBytesBilled` (1.1 x estimate, never below 10 MiB), 95 GiB daily quota ledger (quota day starts 08:00 UTC). A guard refusal stops the run; no retry with changed parameters.
- Runner: `pnpm --filter ingestion exec tsx src/economics/backfill-cli.ts --run --approval-digest <digest> --approved-max-bytes 22548578304`.
No other spending is authorised by this record.
