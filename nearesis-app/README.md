# nearesis-app

Nearesis is a research workspace for one question at a time. It shows observed data, the statistics a research engine computed from it, and what an agent or a person concluded, each clearly labelled. This directory is the application workspace (a pnpm monorepo plus a uv Python project). The specification and the evidence records live in `../NEARESIS_Build_Bible`.

Everything a reviewer needs to reproduce the documented results runs on a clean checkout with no credentials, no hidden demo server and no network after installation. The fixture path (labelled SYNTHETIC) is the default.

## Architecture

| Layer           | Where                                             | What it does                                                                                                                                          |
| --------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app         | `apps/web`                                        | Next.js canvas, thesis, evidence graph and time machine. Talks only to the API.                                                                       |
| API             | `apps/api`                                        | Versioned HTTP API for workspaces, commands, questions, runs, approvals, markers and capsules. Runs are read from the runtime schema, never computed. |
| Kernel          | `packages/kernel`                                 | Workspaces, canvas commands, capability leases, plugin gateway, monitoring, audit. Row-level security on every tenant table.                          |
| Agent runtime   | `packages/agent-runtime`, `packages/workflow`     | Director and role graphs run as Temporal workflows with budgets, leases and an approval gate before any privileged action.                            |
| Plugin          | `plugins/near-thesis`                             | The semantic and canvas tools the agents may call, plus the lifecycle rules (preregistration order, source health, consistency).                      |
| Semantic layer  | `packages/semantic-gateway`, `services/analytics` | Certified metrics only, served through Cube over ClickHouse. Every result carries a query hash, a snapshot and its gaps.                              |
| Ingestion       | `services/ingestion`                              | Collectors for the Explorer, 1Click quotes, BigQuery and prices, with a circuit breaker and no zero-filling of gaps.                                  |
| Research engine | `services/research` (Python)                      | Preregistered statistical tests on a frozen snapshot, deterministic and re-executable offline.                                                        |
| Capsule         | `packages/capsule`                                | Builds and independently rebuilds a research capsule (manifest, THESIS, DATA, LIMITATIONS, memo, static dashboard).                                   |
| Contracts       | `packages/contracts`                              | The shared zod schemas. Every package imports its types from here.                                                                                    |

State: Postgres (kernel in `public`, runtime in `runtime`, ingestion in `ingestion`), Redis, ClickHouse and Temporal, all started locally by `pnpm dev:infra` and bound to 127.0.0.1.

A run has a source mode. `fixture` reads the SYNTHETIC cubes. `live` reads the real-data layer. `GET /v1/runs/:id` states which, and a `live` run is `BLOCKED_SOURCE` (terminal, retryable) before any agent starts when a source it reads is degraded or unavailable. Every child task of a run carries the same question, snapshot, metric-version-map and preregistration hashes, and the dispatcher refuses a child that differs.

## Setup

Requires `git`, `curl` and Docker (for the local stack). Node, pnpm, uv and Python 3.12 are installed project-locally; nothing system-wide changes. Run the commands below from `nearesis-app/` of a fresh checkout.

```sh
sh scripts/bootstrap-toolchain.sh      # downloads checksum-verified Node 24.22.2, uv 0.13.7, CPython 3.12 into .toolchain/
. scripts/toolchain-env.sh             # puts them on PATH for this shell
pnpm install --frozen-lockfile
uv sync --frozen
pnpm typecheck && pnpm lint
```

Every later command assumes `. scripts/toolchain-env.sh` was run in the same shell.

## Environment flags and configuration

All configuration is by environment variable. None is needed for the fixture path. Defaults point at the local stack.

| Variable                                                 | Purpose                                                                | Default                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| `DATABASE_URL`, `DATABASE_APP_URL`                       | Postgres (superuser for migrations, `nearesis_app` role at runtime)    | local stack, port 55432                |
| `REDIS_URL`                                              | Redis                                                                  | local stack, port 56379                |
| `CLICKHOUSE_URL`                                         | ClickHouse                                                             | local stack, port 58123                |
| `TEMPORAL_ADDRESS`                                       | Temporal                                                               | local stack, port 57233                |
| `INFERENCE_PROVIDER`                                     | `mock` (labelled scripted inference), `openrouter` (live) or `near-ai` | `mock` unless an OpenRouter key is set |
| `INFERENCE_BUDGET_USD`                                   | Hard spend cap for live inference, enforced by a ledger                | unset                                  |
| `OPENROUTER_PRIMARY_MODEL`, `OPENROUTER_FALLBACK_MODELS` | Live inference model choice                                            | unset                                  |
| `OPENROUTER_ALLOWED_PROVIDERS`                           | Upstream providers the live path may use                               | unset                                  |
| `GCP_PROJECT_ID`                                         | BigQuery project for live NEAR transaction data                        | unset                                  |

A question carries `source` (`fixture` or `live`) and an optional `preregistrationHash`. Live runs also need the credentials below.

## Credentials

Secrets are read server-side from the repository-root `.env` (gitignored, never committed). Only their names are documented here; `.env.example` lists the same names with empty values. The fixture path, the tests listed below and the capsule rebuild use none of them.

| Name                   | Used for                              |
| ---------------------- | ------------------------------------- |
| `INTENTS_EXPLORER_JWT` | Explorer collector (live swaps)       |
| `INTENTS_1CLICK_JWT`   | 1Click dry-run quote collector (live) |
| `COINGECKO_API_KEY`    | Price collector (live)                |
| `OPENROUTER_API_KEY`   | Live inference through OpenRouter     |
| `NEAR_AI_API_KEY`      | Optional attested inference           |
| `OUTLAYER_PAYMENT_KEY` | Optional OutLayer proof jobs          |

## Commands

Start the local stack and the services. Each long-running command takes its own terminal.

```sh
pnpm dev:infra                                          # Postgres 55432, Redis 56379, ClickHouse 58123/59000, Temporal 57233/58233
pnpm --filter @nearesis/api dev                         # API on 127.0.0.1:4100
pnpm --filter @nearesis/workflow worker                 # the investigation worker (Temporal queue nearesis-investigations)
pnpm --filter @nearesis/web dev                         # web app on 127.0.0.1:3100
```

Checks that need no stack:

```sh
pnpm security:all                      # secret scan and source-register URL audit
uv run pytest                          # the research engine's Python tests
```

In the web app, a workspace's thesis, evidence graph and time machine are at `/w/<workspaceId>/thesis`, `/w/<workspaceId>/evidence` and `/w/<workspaceId>/history`. See `docs/user/README.md` for how to read them.

## Rebuild and verify a research capsule offline

A capsule is built from a frozen snapshot, and rebuilt from the same snapshot by an independent code path. Both commands run with the network disabled after installation and need no credential.

```sh
pnpm research:rebuild --snapshot packages/capsule/fixtures/snapshot-synthetic --out /tmp/nearesis-capsule --no-wasm
pnpm research:verify --capsule /tmp/nearesis-capsule --no-research
```

`research:rebuild` re-derives every number from the raw snapshot with exact integer arithmetic, rebuilds the capsule and prints one JSON line. `research:verify` re-checks the hash chain (capsule hash, file hashes, data hash, input re-derivation, results recomputation). Both exit 0 when the capsule reproduces. To also re-run the preregistered research model, add `--research-bundle <dir>` to the rebuild and omit `--no-research` from the verify.

## Expected output

The rebuild prints one JSON line (`status` `reproduced`, the hashes in the next block and the check names). The figures it re-derives from the raw snapshot, and which the capsule's `THESIS.md` cites one by one, are:

```text
Expected output: pnpm research:rebuild on the SYNTHETIC snapshot
status: reproduced (report status VERIFIED_LOCAL)
Aligned daily points: 90 days
intents_volume_proxy change, first to last day: -1.26 percent
active_signers_proxy change, first to last day: 1.00 percent
Same-day Pearson correlation: 0.212024 ratio
Lag in days: 7 days
Pearson correlation of intents_volume_proxy at t with active_signers_proxy at t+k: 0.998605 ratio
```

Expected hashes for the same command (a different hash means the capsule did not reproduce):

```text
capsuleHash  a6f799c280dfb9b7ccb61066f05e44d903a37e8e93b40895f7503c113220f034
resultsSha256 4bdd559e99a7852e45c3d54e87050fbaa35cd49866790fd23d321f25e79192b5
dataHash     e08dd7e47f87933ff1e838a69008ddb04c4a4a8a5f839c581c136c43ffc52888
```

The checks reported are `capsuleHash`, `fileHashes`, `dataHash`, `inputRederivation` and `resultsRecomputation`. Without a recorded attestation the verify report says so (`attestation.present: false`) and the capsule is labelled locally reproduced, never cryptographically verified.

## Data scope

- The documented results come from a SYNTHETIC fixture: a fixed-seed series for a made-up intents volume proxy and a signer proxy that follows it by seven days plus noise. It is not NEAR production data, and the results are not evidence about NEAR.
- Live mode reads NEAR transactions and signers (BigQuery), prices (CoinGecko), Explorer 1Click swaps and 1Click dry-run quotes. The Explorer covers 1Click only, not all NEAR Intents activity; after the private-settlement change of 2026-10-27 public transaction hashes are shield and unshield boundaries, not swaps.
- Missing data is shown as missing, never as zero. A degraded or unavailable source blocks the analyses that need fresh data and holds publication of current-date claims.
- Nothing in this repository executes a swap (quote calls are dry runs), writes to a mainnet or handles a wallet key.

## Fixture license

The SYNTHETIC snapshot in `packages/capsule/fixtures/snapshot-synthetic` is generated by `packages/capsule/fixtures/make-snapshot.ts` from a fixed seed. It contains no third-party data and carries no third-party license. The repository does not yet include an open-source license file; until one is added, no license to reuse the code is granted beyond reviewing and running it for evaluation.

## Known limitations

The full list is in `docs/user/KNOWN_LIMITATIONS.md`. The ones a reviewer will meet first:

- Research results available today are from the SYNTHETIC fixture. Live research runs are capped at `INSUFFICIENT_DATA` until complete organic-activity data exists.
- No OutLayer proof exists for any capsule. A capsule is shown as locally reproducible, never as cryptographically verified, without a job id and check time.
- The final testnet commitment of a preregistration is a signing step and is not performed. The flow records it as `BLOCKED_DEPENDENCY`.
- Scripted inference stands in for a language model on the fixture path and is labelled mock on every output.
- Live coverage is partial: over long windows the 1Click series can be refused by the gateway's cost cap, and the thesis page then shows the refusal, not an empty series.

## Tests

```sh
pnpm typecheck && pnpm lint && pnpm test                  # unit tests of every package (the local stack must be running)
pnpm exec vitest run tests/integration/B05.accept.test.ts # one end-to-end acceptance test on the real local stack
```

Acceptance tests have stable IDs (for example `K01`, `B05`, `V09`) and live under each package's `test/acceptance` or under `tests/`. Run one with `pnpm accept --id <ID> --session <name>` after committing; the runner refuses to record on a dirty tree. The definitions are in `../NEARESIS_Build_Bible/chapters/16_TEST_MATRIX.md` and the amendments `16a` and `16b`.

## Evidence verification and recovery

Each recorded acceptance run is a JSON file under `../NEARESIS_Build_Bible/reports/TESTS/<ID>/` with the observed values, the commit it ran at and a log. Evidence is only written by `pnpm accept`; it is never edited by hand. To check a result yourself, re-run the same command and compare the observed values.

Recovery:

- A step that cannot run records `BLOCKED_DEPENDENCY` with its blocker file under `../NEARESIS_Build_Bible/reports/BLOCKERS/`. Fix the dependency and re-run the same command.
- The local stack is idempotent: `pnpm dev:infra` restarts anything that is down. Never remove its volumes.
- A run that stopped on a degraded source (`BLOCKED_SOURCE`) is retried by submitting the question again once the collector's health is `ok`.
- A capsule that fails `research:verify` is rebuilt from the frozen snapshot with `research:rebuild`; the snapshot's files are never edited.

See `AGENTS.md` for the working rules and `docs/` for the threat model, database conventions and source register.
