# Statistical research engine (services/research)

Python package `nearesis_research`, pinned with project-local `uv` (numpy 2.5.3, pandas 3.1.0, scipy 1.18.1, statsmodels 0.15.0, scikit-learn 1.9.1). Single-thread BLAS is forced at import. All estimates are computed by code; no language model is involved. Follows Build Bible ch.08.

## Commands

```
cd nearesis-app && source scripts/toolchain-env.sh
PYTHONPATH=services/research uv run python -m nearesis_research.cli run --fixture signal|nosignal --seed 20261111 --out <dir>
PYTHONPATH=services/research uv run python -m nearesis_research.cli reproduce --dir <dir>
PYTHONPATH=services/research uv run python -m nearesis_research.cli live-freeze --out-root docs/research/live-snapshots
PYTHONPATH=services/research uv run python -m nearesis_research.cli live --snapshot docs/research/live-snapshots/<snapshotId> --out docs/research/live-results/<snapshotId>
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

Live research runs only from a pinned snapshot (`live.freeze_live_snapshot`): one read-only, date-bounded query set against `nearesis_live`, raw result sets written as canonical JSON with SHA-256, snapshot id = window + input method + content hash. Identical content reuses the id, changed content gets a new id, a damaged pinned copy is refused, and `cli live` refuses to write into a non-empty result directory. Input method `live-organic-v2` uses `account_daily_activity.tx_organic` as the organic target (supersedes `live-aggregate-v1`, the unadjusted `near_daily_tx.tx_count`, whose runs stay as they were). The swap window is resolved by an explicit rule (partial first day and the newest, still-written day are dropped). Absent days stay NaN, a SUCCESS swap with a NULL USD amount makes the day's volume incomplete (never zero). Top-1%/5% removal uses the day's signer cohort (a labelled proxy, not the fixture's fixed account set); public versus confidential volume uses `privacy_era`. Stablecoin routes and segment targets are NOT_COMPUTABLE (no asset registry: `canonical_origin_asset` is NULL; no per-account rows). Live runs are labelled post-hoc registration (the frozen parameters are the fixture-evaluation freeze; live-study fields are TBD). See `docs/research/LIVE_INPUTS.md` for runs.

## Artifact bundle (`research_run.json` and one file per section)

Zod contract: `ResearchRunArtifact` in `packages/contracts/src/research-artifacts.ts`. Top level: `schemaVersion`, `methodVersion`, `experimentId`, `status`, `evidenceStrength`, `verdict{status,evidenceStrength,reasons[],thresholdsFrom}`, `claimScope`, `preregistrationVerified`, then the twelve sections `hypothesis`, `preregistration`, `inputSnapshot`, `features`, `models`, `windows`, `estimates`, `uncertainty`, `counterevidence`, `limitations`, `falsification`, `reproduction`, and `artifactHashes` (sha256 of the canonical JSON of each section; floats rounded to 10 decimals).

`status`: SUPPORTED, MIXED, UNSUPPORTED, INSUFFICIENT_DATA, NOT_REPRODUCIBLE. `evidenceStrength`: exploratory, pre_registered, out_of_sample, independent_replication.

`narrative.render_narrative` / `verify_narrative` build and check sentences from the computed facts; any numeric token not present in the facts is rejected.

Reproduction tolerance: 1e-9 absolute on float leaves; canonical-JSON section hashes are exact when floats agree to 10 decimals.

## G07 tests Q11 to Q22 (ch.16b)

All analysis parameters live in the frozen block of `docs/research/PREREGISTRATION.md`; `docs/research/PREREGISTRATION.freeze.json` records its canonical hash (CRLF to LF, NFC, UTF-8, trailing whitespace kept) and the freeze time. Code reads values only through `nearesis_research.frozen.load_frozen().get(path)`. Evaluation results are appended to `.data/research/audit/<hash>.jsonl`; the freeze must precede the first entry. A document that differs from its freeze record makes a result `post-hoc registration` with `exploratory` strength.

- `rolling.py` (Q11), `targets.py` (Q12), `overlap.py` and `publication.py` (Q13), `inference.py` `dm_paired` and `paired_comparison` (Q14), `verdict.py` (Q15), `registration.py` (Q16), `lockbox_protocol.py` (Q17, including the audit-replay path), `robustness.py` (Q18), `adversarial.py` (Q19, scripted branches), `manifest.py` and `cli g07-run` (Q20), `quant_supervisor.py` with `quant_worker/worker.mjs` (Q21), `thesis.py` (Q22). `negative_controls.py` holds deliberately wrong implementations used only by tests.
- Measurements: `PYTHONPATH=services/research uv run python -m nearesis_research.accept_cases_g07 Q14`. Verdicts: `pnpm accept --id Q14 --session <agent>`.
- Q21 needs Docker and the local `node:24-bookworm-slim` image; Q20 needs `uv sync --frozen --offline` to work from the local cache.
- Audit replay of the holdout: `HoldoutProtocol.audit_replay` (same configuration hash, seeds and data digest; counted separately, never raises strength). `cli g07-run --audit-replay-of <configHash>` for a clean-environment rerun.
