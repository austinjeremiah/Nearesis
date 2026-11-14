# Nearesis

Nearesis is a research workspace for one question at a time. It keeps observed data, the statistics computed from it, and what an agent or a person concluded in separate, labelled layers, and every number in a published thesis traces back to a frozen data file. This repository is our submission to the NEAR hackathon 2026, track "Investment Thesis" (`thesis`). It contains the web app (`frontend/`) and the backend monorepo (`nearesis-app/`) with the thesis data, queries, build scripts and results.

## The thesis in one minute

**Volume Without Value Capture.** Users pay a real toll to settle through NEAR Intents, but almost none of it reaches NEAR: the gas the network keeps per dollar settled will stay a tiny fraction of what users pay, as the flow keeps moving around the NEAR token rather than through it.

Per 100 dollars settled through NEAR Intents over the last 30 days of the data (to 2026-11-13), from `nearesis-app/thesis/raw/forecast.json` (`/derived/toll_split`):

| | Cents per 100 USD settled |
| --- | --- |
| User-paid spread, all routes | 59.4 |
| of which integrator app fees | 47.8 |
| NEAR burnt as gas by the Intents contracts | 0.0918 |

93.1% of settled value touches no NEAR-chain asset, and the NEAR token is a leg of 2.46% of it. The thesis forecasts these numbers, the gas take rate, Intents' share of all NEAR burnt, settled volume and the long tail of ordinary accounts, with 50% and 80% bands and checkpoints on 2027-02-13, 2027-05-13 and 2027-11-13 that can prove it wrong. Every forecast is backtested (rolling origins, horizons up to 90 days); the 180- and 365-day figures are extrapolations and are labelled so. Evidence against has its own section: gas is only one toll (the protocol fee switch sends part of the front-end fees to NEAR buybacks, which the public data shows only partly), a small rate on a large base is still money, and private settlement is not visible.

The data is a full year (2025-11-10 to 2026-11-13): daily NEAR transactions, accounts and fees from the BigQuery public dataset (cross-checked day by day against the local copies), 7.2 million NEAR Intents swaps from the Explorer API with their app fees, and NEAR prices. The analysis sections are written by hand from `thesis/build/FACTS.md`; the build fails if any number in them is not backed by a frozen file.

The first hypothesis we tested, the track's sample ("cross-chain volume through NEAR Intents is a better leading indicator of real network usage than token price"), is kept as an archived, still-verifiable thesis in `nearesis-app/thesis/archive/intents-vs-price-v1/`: every candidate model had higher out-of-sample error than the baseline, and the model with price beat the model with Intents volume at every horizon. That result is what led to the better question above.

Where to read it:

- `nearesis-app/thesis/build/THESIS.md`
- the static dashboard, `nearesis-app/thesis/build/site/index.html` (open it in a browser, no server needed)
- the in-app page `/thesis` (see "Run the app locally")

## Track brief, item by item

| Brief item | Where it lives |
| --- | --- |
| BigQuery SQL with `block_date` filters | `nearesis-app/thesis/sql/bigquery/` (four queries on `bigquery-public-data.crypto_near_mainnet_us.transactions`, each bounded by `block_date >= start_date AND block_date < end_date`) |
| NEAR Intents Explorer pull | Collector in `nearesis-app/services/ingestion`; endpoint, pagination and credential name documented in `nearesis-app/thesis/TABLES.md` |
| One rebuild command | `pnpm thesis:build` (from `nearesis-app/`); `pnpm thesis:verify` rebuilds into a temp directory and compares every hash with `thesis/build/HASHES.json` |
| Static dashboard | `nearesis-app/thesis/build/site/index.html` |
| Thesis document | `nearesis-app/thesis/build/THESIS.md`: Executive claim, What would change our mind, Evidence for, Evidence against, Confounders and blind spots, Verdict per claim, Reproduction, Unable to compute, Source index; also in the app at `/thesis` and as a PDF |
| Forecast with checkpoints | `nearesis-app/thesis/raw/forecast.json` (backtests, bands, checkpoints), `pnpm thesis:verify` recomputes it |
| Fee and toll data | `nearesis-app/thesis/raw/fees/` (full-year burn by contract, user-paid spread, app fees, `FEE_MODEL.md` with sourced fee rules) |
| Tables and a sample query | `nearesis-app/thesis/TABLES.md` (BigQuery tables, Explorer endpoint, local ClickHouse tables, sample query) |
| Frozen inputs | `nearesis-app/thesis/raw/` with `manifest.json` (window, row counts, SHA-256 per file, BigQuery bytes billed) |

## Reproduce the thesis

These steps need no credentials, no databases and no network after installation. `thesis:build` reads only `thesis/raw` and the frozen research results; it fetches nothing.

```sh
git clone https://github.com/austinjeremiah/Nearesis.git && cd Nearesis/nearesis-app
pnpm install
pnpm thesis:build
pnpm thesis:verify
```

Node 24.22.2 (`.nvmrc`; `engines` requires >= 24.22.1) and pnpm 12.18.0 (`packageManager`). If you have neither, `sh scripts/bootstrap-toolchain.sh && . scripts/toolchain-env.sh` installs checksum-verified copies into `nearesis-app/.toolchain/` without touching the system.

`thesis:verify` exits non-zero if any generated file differs from the recorded hash.

Refreshing the data is separate and optional:

- `pnpm thesis:data` re-freezes `thesis/raw` from the local ClickHouse stores (needs the local databases).
- `pnpm thesis:data --bigquery` also re-runs the BigQuery queries. These are billed jobs and need `GCP_PROJECT_ID` and Google Cloud credentials. The frozen run billed 4,181,721,088 (active accounts), 1,160,773,632 (transactions) and 4,516,216,832 bytes (each of the two contract-usage queries).

## What else is in the app

- Workspaces where you ask a question and investigate it, with findings grounded in the data they cite.
- An Agent page (`/agent`) showing plans, a consent step before privileged actions, and live step results.
- Hypotheses, experiments, an evidence graph, markers and monitors per workspace.
- Verifiable research capsules (manifest, THESIS, data, limitations, static dashboard) that can be rebuilt independently, with OutLayer TEE proofs on NEAR testnet.
- Publication of a thesis to a public page.
- A PDF workspace report.
- A USD credits allowance for AI and proofs (`/credits`).
- Sign-in with a NEAR wallet, plus a dev sign-in for local use.

## Run the app locally

Prerequisites: Node and pnpm as above, and a Docker-compatible runtime for Postgres, Redis, ClickHouse and Temporal (`nearesis-app/infrastructure/compose/docker-compose.yml`).

Backend, from `nearesis-app/` (one terminal each):

```sh
pnpm install
pnpm dev:infra                                   # Postgres 55432, Redis 56379, ClickHouse 58123, Temporal 57233; stop with pnpm dev:infra:down
pnpm dev:seed                                    # dev data for the dev sign-in
pnpm --filter @nearesis/api dev                  # API, 127.0.0.1:4100 by default (PORT overrides)
pnpm --filter @nearesis/workflow worker          # investigation worker (Temporal queue nearesis-investigations)
```

Frontend, from `frontend/` (set `NEARESIS_API_URL` to the port your API uses; the default is `http://127.0.0.1:4110`):

```sh
corepack pnpm install
NEARESIS_DEV_LOGIN=1 NEARESIS_API_URL=http://127.0.0.1:4100 corepack pnpm dev -p 3400
```

Open `http://127.0.0.1:3400`. `NEARESIS_DEV_LOGIN=1` shows a dev sign-in on `/login`; it is never available in a production build. Main pages: `/home`, `/thesis`, `/agent`, `/workspaces`, `/data`, `/publications`, `/credits`, `/system`.

Configuration is by environment variable, read from a repository-root `.env` (see `nearesis-app/.env.example`; the file holds names only). Nothing below is needed for the thesis rebuild.

| Variable | Needed for |
| --- | --- |
| `DATABASE_URL`, `DATABASE_APP_URL`, `REDIS_URL`, `CLICKHOUSE_URL`, `TEMPORAL_ADDRESS` | Pointing at a stack other than the local default |
| `INFERENCE_PROVIDER`, `OPENROUTER_API_KEY`, `OPENROUTER_PRIMARY_MODEL`, `OPENROUTER_FALLBACK_MODELS`, `OPENROUTER_ALLOWED_PROVIDERS`, `INFERENCE_BUDGET_USD` | Live AI inference. Without a key, `INFERENCE_PROVIDER` is `mock` (scripted, labelled) |
| `NEAR_AI_API_KEY` | Optional attested inference |
| `INTENTS_EXPLORER_JWT`, `INTENTS_1CLICK_JWT` | Live Intents Explorer and 1Click collectors |
| `COINGECKO_API_KEY` | Live price collector |
| `GCP_PROJECT_ID` | BigQuery (live data and `thesis:data --bigquery`) |
| `OUTLAYER_PAYMENT_KEY` | OutLayer proof jobs |

API flags that switch on the full feature set: `NEARESIS_MONITOR_BACKGROUND=1` (background monitors), `NEARESIS_PUBLISH_KEYCHAIN=1` and `NEARESIS_PUBLISH_ANCHOR_TESTNET=1` (publication signing and testnet anchoring), `NEARESIS_OUTLAYER_LIVE=1` (live OutLayer proofs). Without them those features are off or use local stand-ins.

Without credentials the app runs on the SYNTHETIC fixture path, which is labelled as such in the UI and the API.

## Repository layout

```text
frontend/                     Next.js app; talks to the API only through its own server-side routes
nearesis-app/
  apps/api                    versioned HTTP API
  packages/                   kernel, contracts, capsule, workflow, agent-runtime, semantic-gateway, ...
  plugins/near-thesis         tools the agents may call
  services/ingestion          Explorer, 1Click, BigQuery and price collectors
  services/research           preregistered statistical tests (Python)
  infrastructure/             docker compose stack
  thesis/
    sql/bigquery/             the BigQuery queries
    raw/                      frozen datasets and manifest.json
    build/                    THESIS.md, site/index.html, thesis.json, HASHES.json
    TABLES.md                 tables, endpoints, sample query
  scripts/thesis/             thesis:data, thesis:build, thesis:verify
```

## Limits

- Everything on-chain that we write (proofs, anchors) is on NEAR testnet only.
- The OutLayer attestation checks do not include Intel TCB collateral verification.
- 1Click swaps are not all NEAR Intents activity, and the Explorer shows only the swaps it exposes. After 2026-10-27 private (shielded) settlement is not observed, so lower later values mean unobserved, not zero.
- Intents volume counts SUCCESS swaps only, valued at the provider's USD amount for the input side, which is not an audited price.
- The data window is 2026-05-05 to 2026-11-11 (191 days). Intents swap data for 2026-07-23 is partial, and 7,841 of 3,990,299 swaps could not be mapped to an asset and are excluded.
- `THESIS.md` lists what it could not compute: any model outside the preregistered family, a causal effect, the placebo test, the robustness agreement share, the lag comparison, and the 30-day lockbox evaluation (not opened). Horizons of 7 and 14 days have 59 and 38 scored origins against a preregistered minimum of 60. Several robustness variants lacked enough data.
- The BigQuery queries count transactions by `receiver_account_id`, which is a different measure from function-call actions; the comparison is reported but is not like-for-like.
