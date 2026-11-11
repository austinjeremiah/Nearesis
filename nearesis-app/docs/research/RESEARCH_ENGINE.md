# Statistical research engine (services/research)

Python package `nearesis_research`, pinned with project-local `uv` (numpy 2.5.3, pandas 3.1.0, scipy 1.18.1, statsmodels 0.15.0, scikit-learn 1.9.1). Single-thread BLAS is forced at import. All estimates are computed by code; no language model is involved. Follows Build Bible ch.08.

## Commands

```
cd nearesis-app && source scripts/toolchain-env.sh
PYTHONPATH=services/research uv run python -m nearesis_research.cli run --fixture signal|nosignal --seed 20261111 --out <dir>
PYTHONPATH=services/research uv run python -m nearesis_research.cli reproduce --dir <dir>
PYTHONPATH=services/research uv run python -m nearesis_research.cli live --start 2026-01-01 --end 2026-11-01 --out <dir>
uv run pytest tests/python/research -q
pnpm --filter @nearesis/research test      # Q01-Q10 acceptance wrappers
```

## Method summary

- Target: log1p of organic daily successful actions at origin+h (h in 1, 7, 14); Intents-generated accounts excluded; the unadjusted target is never silently substituted.
- Features: y lags, calendar one-hots, lagged log1p Intents volume (lag grid 0-5, 7), lagged NEAR log returns. Calendar-true lags on a complete UTC-day index. A missing day is NaN, never 0 and never forward-filled; rows with any missing input are dropped once, identically for every model, and each drop is recorded.
- Models: baseline, intents, price, combined (standardised ridge, alpha 1.0, scaler fit on training rows per origin) plus naive, seasonal naive and 7-day moving average baselines. Expanding rolling origin; no random CV.
- Regime split at 2026-10-27: development and lockbox windows end before it; the post window is analysed separately; rows straddling the boundary are excluded and counted.
- Lockbox: last 30 pre-regime origins, sealed under the preregistration hash, openable once; development rows overlapping it are purged. The lockbox is opened only if the development gate passes.
- Inference: one-sided Diebold-Mariano on absolute error (HAC), moving-block bootstrap CI for delta MAE, Benjamini-Hochberg over the frozen 9-test family (3 candidates x 3 horizons), min relative improvement 2%.
- Robustness/falsification: 30/90/180-day windows, top 1%/5% account removal (set fixed from the development window), outlier-day exclusion, post-regime window, single-lag comparison, circular-shift placebo of the Intents series. Stablecoin-only is reported NOT_TESTABLE (no route-level input).
- Verdict engine (`experiment._verdict`) uses only thresholds in the frozen preregistration (hash verified). SUPPORTED requires development FDR + effect + CI, holdout confirmation, robustness agreement >= 80% and placebo p <= 0.05. Otherwise MIXED / UNSUPPORTED / INSUFFICIENT_DATA / NOT_REPRODUCIBLE. `independent_replication` is never assigned by the engine.
- Leakage detector re-derives every feature from the raw series using only data at or before the origin and blocks publication on any mismatch (future value, altered value, negative lag, mechanical overlap, split overlap).

## Live data

`live.load_live` reads `nearesis_live` (read-only, local ClickHouse, date-bounded). It reports actual per-series coverage, keeps absent days NaN, treats NULL USD swap amounts as incomplete volume (never zero), and marks the dataset incomplete when coverage is partial. The daily aggregate target is `near_daily_tx.tx_count` (unadjusted); the organic target needs account-level data, so a live run is capped at INSUFFICIENT_DATA until that exists. Fixture acceptance (Q01-Q10) is the gate; no live claim is derived from fixtures.

## Artifact bundle (`research_run.json` and one file per section)

Zod contract: `ResearchRunArtifact` in `packages/contracts/src/research-artifacts.ts`. Top level: `schemaVersion`, `methodVersion`, `experimentId`, `status`, `evidenceStrength`, `verdict{status,evidenceStrength,reasons[],thresholdsFrom}`, `claimScope`, `preregistrationVerified`, then the twelve sections `hypothesis`, `preregistration`, `inputSnapshot`, `features`, `models`, `windows`, `estimates`, `uncertainty`, `counterevidence`, `limitations`, `falsification`, `reproduction`, and `artifactHashes` (sha256 of the canonical JSON of each section; floats rounded to 10 decimals).

`status`: SUPPORTED, MIXED, UNSUPPORTED, INSUFFICIENT_DATA, NOT_REPRODUCIBLE. `evidenceStrength`: exploratory, pre_registered, out_of_sample, independent_replication.

`narrative.render_narrative` / `verify_narrative` build and check sentences from the computed facts; any numeric token not present in the facts is rejected.

Reproduction tolerance: 1e-9 absolute on float leaves; canonical-JSON section hashes are exact when floats agree to 10 decimals.
