# Live study registration: input method `live-organic-v3` (stablecoin route cells)

Status: pre-run registration of a live research input method. Written and committed before any `live-organic-v3` snapshot exists and before any v3 result has been computed. The commit time of this file and of `LIVE-ORGANIC-V3-REGISTRATION.freeze.json` is the pre-registration timestamp. It is a fixture-evaluation-style freeze (document hash, no chain commitment), the same pattern as `PREREGISTRATION-AMENDMENT-002.md` and its freeze file. It does not edit, replace or re-freeze `PREREGISTRATION.md`, any amendment, or the pinned run `live-20260603-20261111-live-organic-v2-15fe2ad62d6c`, which stays byte-reproducible and keeps saying NOT_COMPUTABLE for routes.

## 1. Why a new input method

`live-organic-v2` froze its inputs before the canonical asset registry existed (migration 006, `asset_registry`, view `intents_swap_asset_status`), so its `stablecoin_only_routes` and `non_stablecoin_routes` cells are NOT_COMPUTABLE. Since 2026-11-12 the registry maps 99.9 percent of swaps. Computing the route cells needs different frozen inputs and a pre-declared stablecoin set, hence a new method and a new snapshot id. v2 behaviour is untouched.

## 2. Stablecoin symbol set (declared from registry identity only)

A canonical symbol is a stablecoin if and only if it is in the declared candidate list below AND, in the frozen `registry_identity` table of the snapshot (latest version per `provider_asset_id` of `nearesis_live.asset_registry`), every non-NULL row with that canonical symbol is `verification = 'verified'` and carries exactly one distinct `coingecko_id`, equal to the id declared here. No symbol is added from market knowledge at run time, no price or peg behaviour is consulted.

| Canonical symbol | Required coingeckoId |
| ---------------- | -------------------- |
| USDT             | tether               |
| USDC             | usd-coin             |
| DAI              | dai                  |
| USDT0            | usdt0                |
| USD1             | usd1-wlfi            |
| USDG             | global-dollar        |
| USDe             | ethena-usde          |
| USDf             | falcon-finance       |
| FRAX             | frax                 |
| USDCX            | usdcx                |

Declared exclusions (stablecoin-like or fiat/commodity-pegged symbols that are not in the set and are never counted as non-stablecoin either): `USAD`, `sUSDC`, `nrUsdt`, `xDAI`, `EURe`, `GBPe`, `XAUT`. Reason: wrapped or savings variants and chain-native tokens that share a coingeckoId with a listed stablecoin, and non-USD pegs; their classification would be a guess. A swap touching one of them is class `excluded_declared`.

Rule for unknown, conflicting or NULL-canonical rows (excluded and counted, never guessed):

- A candidate symbol that fails the identity check at freeze time (not verified, no id, more than one id, or an id different from the table) leaves the set and is added to the unresolved list; a swap touching it is class `excluded_declared`, never `non_stablecoin`.
- A swap whose `canonical_origin_asset` or `canonical_destination_asset` is NULL is class `unmapped`, whatever the reason (`conflicting_identity_for_symbol`, `no_coingecko_identity`, `not_in_registry`, or a stale NULL, see section 3). Reasons are counted from `intents_swap_asset_status`.
- Class precedence, evaluated in this order for each swap: `unmapped`, `excluded_declared`, `stablecoin` (origin and destination both in the set), `non_stablecoin` (neither leg in the set), `mixed` (exactly one leg in the set).
- `mixed`, `excluded_declared` and `unmapped` volumes are reported in the audit and are not used by either route cell.

## 3. Window rule

Window: the existing `live-organic-v2` rule, unchanged (`live.resolve_swap_window`): the newest day present is dropped as still being written, the first day is dropped if it has fewer than half of the median of the next seven days. The window is resolved at freeze time. The swaps table now starts earlier than 2026-06-03 (the Explorer backfill has progressed since v2), so the v3 window can be wider than the v2 window; this is a consequence of the unchanged rule and is not chosen for effect. The non-route cells therefore are not expected to equal the v2 cells.

Stale NULL-canonical rows: the running Explorer backfill process may write NULL canonical assets for new rows until it is restarted. A row is `stale_null` when its canonical asset is NULL while the registry (latest version) resolves the provider asset to a non-NULL canonical symbol. The frozen `route_day_quality` table counts them per day. The window end is truncated to the day before the first day in the resolved window on which the share of `stale_null` rows (origin or destination) is 1 percent or more of that day's swaps. Below that, stale rows are counted as `unmapped` (they are NULL canonical rows) and stay in the window. The 1 percent cutoff is declared here, before data are examined under this rule.

## 4. Target, cells, hypotheses, tests

- Target: unchanged from v2: `account_daily_activity.tx_organic` (organic successful transactions, Intents verifier and bridge removed by the ingestion account rule), log1p scale as in the frozen preregistration. Missing days stay NaN, never 0. Swap volume, price, privacy-era volume and top-1/5 percent cohort inputs are built by the v2 code unchanged.
- Cells added: `stablecoin_only_routes` and `non_stablecoin_routes` of the frozen Q18 robustness matrix (variant list unchanged). Route predictor = the sum of known `amount_in_usd` over SUCCESS swaps in the route class for each day, used in place of total intents volume as the candidate predictor against the same organic target, same candidate (`intents`), same baseline, same rolling origin protocol and thresholds as the other matrix cells. A day with no SUCCESS swaps in the class, or with a SUCCESS swap whose USD amount is NULL in the class, is a missing predictor day (NaN), never 0.
- Hypotheses and tests: reused unchanged (the frozen experiment id `experiment.near.intents_predictive_power@1`, family of 9 candidate-by-horizon comparisons, Benjamini-Hochberg, Amendment 002 fixed-smoothing inference records, lockbox, placebo, bootstrap). No new hypothesis is added and none is dropped. The route cells are descriptive robustness rows, exactly as every cell of the frozen matrix is descriptive in `robustness_matrix.json`; they do not enter the verdict computation. The engine-internal `stablecoin_only_routes` check inside `experiment._robustness` is NOT_TESTABLE in the unchanged engine and is reported as it is.
- Sign-flip rule: the frozen rule applies as written to the computed route cells (a computed cell whose delta MAE has the opposite sign to the primary one is a flip), reported, not adjusted.

## 5. Minimum samples and thresholds (never lowered)

All thresholds are the frozen ones, read from `default_prereg()` and `PREREGISTRATION.md`, unchanged: `minDevOrigins` 60, `minHoldoutOrigins` 14, `minTrain` 60, `lockboxDays` 30, regime split 2026-10-27, `minRelativeImprovement` 0.02, `robustnessAgreeShare` 0.8, Q18 `minPostRegimeRows` 60 and window minimums. A route cell with no scored origins under the preregistered minimum training length is NOT_COMPUTABLE with that reason; if the primary study has fewer than 60 scored development origins the verdict is INSUFFICIENT_DATA and is reported as such. No threshold, window length or minimum is changed after seeing any v3 output.

## 6. Verdict engine and labels

The verdict engine, `verdict.py`, `inference.py`, `dm_*` and the robustness code run exactly as they do today. The legacy `p_raw` gating of nested comparisons is an open owner decision and is not touched here. Output labels are whatever the engine assigns: live runs carry the `post-hoc registration` label in the engine (the frozen document is the fixture-evaluation freeze and no chain commitment exists), evidence strength `exploratory`. This registration adds a recorded pre-run document hash (`registration` field of the run source) but does not upgrade that label.

## 7. Reproducibility and audit outputs

`live-freeze --method live-organic-v3` writes a new content-addressed snapshot (`live-<start>-<end>-live-organic-v3-<hash12>`), never overwrites, and records the queries, the `registry_identity` and `route_day_quality` tables, the resolved stablecoin set, the unresolved list and the window truncation. `live --snapshot <dir> --method live-organic-v3` rebuilds the inputs purely from the pinned files and must reproduce `research_run.json` byte for byte. The run source carries a route audit: rows, SUCCESS swaps and known USD volume by route class, mapped/unmapped/NULL counts, unmapped reasons, stale NULL rows, and the stablecoin share. The study runs once from the pinned snapshot; the result is reported whatever it is.

## 8. Not decided here

p_raw verdict gating, the ForeComp cube-root M finding (FND-20261112-001), the publishing key pin and the BigQuery segment query remain owner decisions. Segment targets stay NOT_COMPUTABLE. Nothing is published and no BigQuery job is run.
