# Runbook: cost caps, SLO burn alerts, chaos stack, backup and restore

Authority: Build Bible ch.13 (cost model, observability), ch.17, ch.21 (data recovery exercise), ch.16b PERF11 and PERF12.

## Isolated fault-injection stack

A separate compose project, `nearesis-chaos` (`infrastructure/compose/chaos.yml`), with its own network and named volumes and ports on 127.0.0.1 only: Postgres 64432, Redis 64379, ClickHouse 64123 (native 64900), Temporal 64233 (UI 64234), Cube 64400. It uses the same digest-pinned images as the shared stack and never pulls (`--pull never`). It never touches the shared `nearesis` project, its volumes or live collection.

```
scripts/chaos/stack.sh up            # all five services (healthy before returning)
scripts/chaos/stack.sh status
scripts/chaos/stack.sh restart redis # also: kill <svc> [signal], pause/unpause <svc>
scripts/chaos/stack.sh down          # removes ONLY the nearesis-chaos containers and volumes
```

PERF11 and the restore drill redirect every harness to it with `tests/perf/_chaos.ts` (`useIsolatedEnv`). Run: `PERF_DRYRUN=1 pnpm exec vitest run tests/perf/PERF11.accept.test.ts` (harness development) or `pnpm accept --id PERF11` (lead, clean tree).

## Backup and restore

`scripts/chaos/backup-restore.ts` backs up one Postgres database (`pg_dump -Fc`, read-only) and one ClickHouse database (DDL plus Native-format rows per table) and writes `manifest.json` with, per table, the row count and a content hash computed in the database (Postgres: md5 over ordered row text; ClickHouse: `sum(cityHash64(*))`) plus the sha256 of every file.

```
tsx scripts/chaos/backup-restore.ts backup  --pg-db <db> --ch-db <db> --out <dir> [--pg-container <name> --pg-port <n> --ch-url <url>]
tsx scripts/chaos/backup-restore.ts restore --dir <dir> --pg-db <new_db> --ch-db <new_db>
tsx scripts/chaos/backup-restore.ts verify  --dir <dir> --pg-db <db> --ch-db <db>
```

- Restore writes only into the isolated stack and refuses any other target. It refuses a dump or export whose sha256 differs from the manifest before writing anything.
- Verify recomputes counts and hashes on the restored databases; any difference exits 1.
- Drill test: `pnpm exec vitest run tests/ops/backup-restore.drill.test.ts` (seeds a real kernel and runtime database and a ClickHouse database, restores into new databases, then runs three negative controls).
- Scheduled drill (ch.21): quarterly, restore into the isolated stack, record the measured backup and restore durations from the test evidence as RPO/RTO inputs. Do not publish an RPO or RTO figure that has not been measured on the target hardware. For production, restore the Postgres dump from point-in-time recovery to staging and check object-store manifest checksums the same way.

Restoring live data: take the backup from the shared stack by naming its container and port (`--pg-container nearesis-postgres-1 --pg-port 55432 --ch-url http://127.0.0.1:58123`), which only reads; restore always goes to the isolated stack first and is promoted by a human.

## Cost caps and spend forecast

Migration `packages/workflow/migrations/005_cost_control.sql` (apply with the runtime `migrate()` before enabling). Enable on a worker and the API with `NEARESIS_COST_CONTROL=1`; without it the code paths are inert.

- Nine metered dimensions: `bigquery_bytes_billed`, `external_requests`, `ai_tokens`, `outlayer_compute`, `clickhouse_cpu`, `clickhouse_io`, `object_storage_gb_month`, `network_egress_bytes`, `workflow_operations`. Prices are workspace policy (`rates`), never constants.
- Every model call is authorised before it is sent (`LedgerInference` with a `CostGovernor`); a refused spend never reaches the provider, writes a `cost_blocks` row and an audit record, and sets a sticky hard stop at the cap or on a dimension limit. Paid operations need the operation name in `paidOpsPermitted` (default `["inference"]`).
- Spend that is only known afterwards (ClickHouse `system.query_log`, BigQuery job statistics, egress counters) is metered with `CostGovernor.observed` and counts against every later authorisation.
- API (owner/admin writes): `GET /v1/workspaces/:id/cost/burn`, `GET /v1/workspaces/:id/cost/ledger`, `PUT /v1/workspaces/:id/cost/policy`, `POST /v1/workspaces/:id/cost/resume`. The forecast is always labelled `projection` and says `insufficient_data` before three settled entries and one hour of the period.
- Alerts: sent through the kernel event path as `notification.created` events (`kind: cost.threshold | cost.blocked`), at most `alertMaxPerWindow` per window per workspace, de-duplicated by key, with an optional cooldown; the rest are stored as `suppressed` and counted.

Hard stop response: read the burn view, find the dimension, either fix the runaway (revoke the workspace agent leases, ch.21 agent runaway runbook) or raise the cap with `PUT .../cost/policy`, then `POST .../cost/resume`. Policy changes alone never clear a stop.

## SLO burn alerts

Declared SLOs: `packages/agent-runtime/src/slo/catalog.ts` (API availability, source freshness, workspace load, cached query, SSE propagation, monitor trigger). Alert rules are multi-window multi-burn-rate for a 30-day objective: page at 14.4x over 1 h and 5 min, page at 6x over 6 h and 30 min, ticket at 1x over 3 d and 6 h; both windows must exceed the factor and the long window needs at least 10 events. Events are recorded per minute in `runtime.slo_buckets` (`SloRecorder`; the API feeds `api_availability` from every response). `evaluateAndAlert` emits one `slo.burn` alert per firing rule through the kernel audit path, de-duplicated per rule and capped per window. Status: `GET /v1/ops/slo`.

On a page: check `GET /v1/ops/slo` for the SLO and window, correlate with the dependency (Postgres, Temporal, Redis, ClickHouse, Cube) and the chaos recovery timings in the PERF11 evidence, and follow the matching ch.21 runbook.
