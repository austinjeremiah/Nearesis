"""Experiment runner, robustness, falsification, verdict engine."""

from __future__ import annotations

from typing import Callable

import numpy as np
import pandas as pd
import statsmodels.api as sm

from . import METHOD_VERSION, SCHEMA_VERSION
from .core import json_hash, rng
from .dataset import Dataset, Inputs, Spec, build_dataset, LockboxError
from . import dm_fixed_smoothing as fs
from .amendment2 import calibration_summary
from .inference import benjamini_hochberg, block_bootstrap_ci, diebold_mariano, placebo_shift_pvalue
from .leakage import LeakageError, check_leakage
from .models import MODEL_CLASSES, SIMPLE_BASELINES, losses, rolling_origin
from .prereg import CANDIDATES, verify_prereg

STATUSES = ("SUPPORTED", "MIXED", "UNSUPPORTED", "INSUFFICIENT_DATA", "NOT_REPRODUCIBLE")


def _spec(pre: dict, h: int, **kw) -> Spec:
    fs = pre["featureSpec"]
    return Spec(
        horizon=h,
        lag_grid=tuple(fs["lagGrid"]),
        y_lags=tuple(fs["yLags"]),
        price_lags=tuple(fs["priceLags"]),
        intents_accounts=tuple(pre["accountExclusionRule"]["intentsGeneratedAccounts"]),
        lockbox_days=pre["split"]["lockboxDays"],
        min_train=pre["split"]["minTrain"],
        regime_split=pre["split"]["regimeSplit"],
        **kw,
    )


def _compare(bt, cand: str, h: int, thr: dict, seed: int, label: str) -> dict:
    eb, ec = bt.abs_err("baseline"), bt.abs_err(cand)
    n = len(eb)
    if n == 0:
        return {"candidate": cand, "horizon": h, "n_origins": 0, "status": "INSUFFICIENT_DATA"}
    d = eb - ec
    dm = {**diebold_mariano(eb, ec, h), "status": "legacy_exploratory", "note": "HAC DM with maxlags=horizon and one-sided Student t; not calibrated, not a significance claim (amendment 002)"}
    nested = fs.nested_policy("baseline", cand)
    inference = fs.compare_paired(d, horizon=h, nested=nested, calibration=calibration_summary(), seed=seed)
    inference["loss"] = "absolute_error_log1p"
    if nested:
        inference["clark_west_exploratory"] = fs.clark_west(bt.preds["baseline"] - bt.actual, bt.preds[cand] - bt.actual, bt.preds["baseline"], bt.preds[cand])
    inference["conclusion"] = fs.conclusion_state(inference)
    bs = thr["bootstrap"]
    ci = block_bootstrap_ci(d, bs["block"], bs["n"], seed, label, bs["level"])
    mae0, mae1 = float(eb.mean()), float(ec.mean())
    return {
        "candidate": cand,
        "horizon": h,
        "n_origins": n,
        "mae_baseline": mae0,
        "mae_candidate": mae1,
        "delta_mae": mae0 - mae1,
        "relative_improvement": (mae0 - mae1) / mae0 if mae0 > 0 else None,
        "dm": dm,
        "inference": inference,
        "p_raw": dm["p_one_sided"],
        "delta_mae_ci": ci,
    }


def _full_losses(bt) -> dict:
    out = {}
    for k in bt.preds:
        out[k] = losses(bt.actual, bt.preds[k]) if len(bt.actual) else None
    return out


def _delta_for(rows, ds, cand_cols_name, fsets, thr, window=None, mask=None, min_train=None) -> dict:
    m = np.ones(len(rows), bool) if mask is None else mask
    bt = rolling_origin(rows, fsets, m, min_train or ds.spec.min_train, ds.spec.step, window, models=tuple(fsets), baselines=False)
    if len(bt.actual) == 0:
        return {"status": "INSUFFICIENT_DATA", "n_origins": 0}
    eb, ec = bt.abs_err("baseline"), bt.abs_err(cand_cols_name)
    return {"status": "OK", "n_origins": len(eb), "delta_mae": float(eb.mean() - ec.mean()), "relative_improvement": float((eb.mean() - ec.mean()) / eb.mean())}


def _robustness(inputs: Inputs, pre: dict, ds: Dataset, prim_bt, seed: int) -> dict:
    thr = pre["thresholds"]
    h = pre["primaryHorizon"]
    cand = pre["primaryCandidate"]
    fs2 = {"baseline": ds.feature_sets["baseline"], cand: ds.feature_sets[cand]}
    checks: dict[str, dict] = {}
    for w in (30, 90, 180):
        checks[f"rolling_window_{w}d"] = _delta_for(ds.rows, ds, cand, fs2, thr, window=w, min_train=min(w, 25))
    for pct in pre["accountExclusionRule"]["sensitivityTopPct"]:
        if inputs.accounts is None and inputs.cohort_tx and pct in inputs.cohort_tx and inputs.target_aggregate is not None:
            from .robustness import cohort_row

            cr = cohort_row(inputs, pct, _spec(pre, h), cand, thr, pre["hash"])
            checks[f"top_{pct}pct_accounts_removed"] = ({"status": "OK", **{k: cr["estimates"][0][k] for k in ("delta_mae", "relative_improvement")}, "n_origins": cr["n_origins"], "rule": cr["rule"]} if cr["status"] == "OK" else {"status": "INSUFFICIENT_DATA", "reason": cr["reason"], "rule": cr["rule"]})
            continue
        if inputs.accounts is None:
            checks[f"top_{pct}pct_accounts_removed"] = {"status": "NOT_TESTABLE", "reason": "no account-level data in this input"}
            continue
        ds2 = build_dataset(inputs, _spec(pre, h, top_pct=float(pct)), pre["hash"])
        r = _delta_for(ds2.rows, ds2, cand, {"baseline": ds2.feature_sets["baseline"], cand: ds2.feature_sets[cand]}, thr)
        r["excludedAccounts"] = ds2.excluded_accounts
        checks[f"top_{pct}pct_accounts_removed"] = r
    # exclude top 5% spike target days from scoring (models unchanged)
    tgt = prim_bt.actual
    keep = tgt <= np.quantile(tgt, 0.95)
    eb, ec = prim_bt.abs_err("baseline")[keep], prim_bt.abs_err(cand)[keep]
    checks["outlier_days_excluded"] = {"status": "OK", "n_origins": int(keep.sum()), "delta_mae": float(eb.mean() - ec.mean()), "relative_improvement": float((eb.mean() - ec.mean()) / eb.mean())}
    # post-regime window: trained on post-regime rows only, never mixed with the pre-regime window
    n_post = len(ds.post_rows)
    if n_post - 0 < ds.spec.min_train + 1:
        checks["post_oct27_regime"] = {"status": "INSUFFICIENT_DATA", "n_rows": n_post, "reason": f"needs more than {ds.spec.min_train} post-regime rows"}
    else:
        checks["post_oct27_regime"] = _delta_for(ds.post_rows, ds, cand, fs2, thr)
    checks["stablecoin_only_routes"] = {"status": "NOT_TESTABLE", "reason": "route/asset-level volume is not part of this input"}
    testable = [v for v in checks.values() if v.get("status") == "OK" and k_is_scored(v)]
    pos = sum(1 for v in testable if v["delta_mae"] > 0)
    share = pos / len(testable) if testable else None
    lag_tab = {}
    base = ds.feature_sets["baseline"]
    for L in ds.spec.lag_grid:
        fs = {"baseline": base, "single": base + [f"x_lag{L}"]}
        lag_tab[str(L)] = _delta_for(ds.rows, ds, "single", fs, thr)
    return {"checks": checks, "agree_share": share, "n_testable": len(testable), "n_positive": pos, "lag_comparison": lag_tab}


def k_is_scored(v: dict) -> bool:
    return "delta_mae" in v


def _placebo(pre: dict, ds: Dataset, real_delta: float, seed: int) -> dict:
    thr = pre["thresholds"]["placebo"]
    cand = pre["primaryCandidate"]
    rows = ds.rows
    x = ds.raw["x"]
    n = len(x)
    r = rng(seed, "placebo")
    shifts = sorted(set(int(v) for v in r.integers(30, n - 30, size=thr["n"])))
    xcols = [c for c in ds.feature_sets[cand] if c.startswith("x_lag")]
    deltas = []
    fs2 = {"baseline": ds.feature_sets["baseline"], cand: ds.feature_sets[cand]}
    for s in shifts:
        px = pd.Series(np.roll(x.to_numpy(), s), index=x.index)
        lx = np.log1p(px)
        rr = rows.copy()
        for c in xcols:
            L = int(c.replace("x_lag", ""))
            rr[c] = lx.shift(L).reindex(pd.DatetimeIndex(rr["origin"])).to_numpy()
        rr = rr[rr[xcols].notna().all(axis=1)].reset_index(drop=True)
        res = _delta_for(rr, ds, cand, fs2, pre["thresholds"])
        if res.get("status") == "OK":
            deltas.append(res["delta_mae"])
    p = placebo_shift_pvalue(real_delta, deltas) if deltas else None
    return {
        "test": "circular_time_shift_placebo_of_intents_series",
        "n_placebos": len(deltas),
        "placebo_delta_mae": {"mean": float(np.mean(deltas)) if deltas else None, "max": float(np.max(deltas)) if deltas else None, "q95": float(np.quantile(deltas, 0.95)) if deltas else None},
        "real_delta_mae": real_delta,
        "p_value": p,
        "alpha": thr["alpha"],
        "passed": bool(p is not None and p <= thr["alpha"]),
    }


def run_experiment(
    inputs: Inputs,
    pre: dict,
    source: dict,
    tamper: Callable[[Dataset], None] | None = None,
    seed: int | None = None,
) -> dict:
    """Runs the full preregistered analysis and returns the artifact dict. Raises LeakageError (nothing published)
    if the leakage detector finds anything. `tamper` is a test-only adversarial hook applied after dataset build."""
    seed = pre["randomSeed"] if seed is None else seed
    thr = pre["thresholds"]
    prereg_ok = verify_prereg(pre)
    results, datasets, backtests = {}, {}, {}
    leak_reports = {}
    for h in pre["horizons"]:
        ds = build_dataset(inputs, _spec(pre, h), pre["hash"])
        if tamper is not None:
            tamper(ds)
        rep = check_leakage(ds)
        leak_reports[h] = rep.to_dict()
        if not rep.clean:
            raise LeakageError(rep)
        bt = rolling_origin(ds.rows, ds.feature_sets, np.ones(len(ds.rows), bool), ds.spec.min_train, ds.spec.step)
        datasets[h], backtests[h] = ds, bt
        results[h] = {c: _compare(bt, c, h, thr, seed, f"{c}-{h}") for c in CANDIDATES}
    # --- multiple-comparison family (pre-registered, fixed size) ---
    fam = pre["family"]
    pvals = [results[f["horizon"]][f["candidate"]].get("p_raw") for f in fam]
    bh = benjamini_hochberg(pvals, pre["fdr"]["q"])
    for f, adj, rej in zip(fam, bh["adjusted"], bh["reject"]):
        results[f["horizon"]][f["candidate"]]["p_adjusted"] = adj
        results[f["horizon"]][f["candidate"]]["fdr_reject"] = bool(rej)
    # --- primary comparison and verdict ---
    ph, pc = pre["primaryHorizon"], pre["primaryCandidate"]
    prim = results[ph][pc]
    ds = datasets[ph]
    verdict_in: dict = {"reasons": [], "gates": {}}
    robust = placebo = holdout = None
    n_dev = prim.get("n_origins", 0)
    enough = n_dev >= thr["minDevOrigins"]
    rel = prim.get("relative_improvement")
    ci_lo = (prim.get("delta_mae_ci") or {}).get("lo")
    dev_pass = bool(
        enough
        and prim.get("fdr_reject")
        and rel is not None
        and rel >= thr["minRelativeImprovement"]
        and ci_lo is not None
        and ci_lo > 0
    )
    verdict_in["gates"]["dev_enough_origins"] = enough
    verdict_in["gates"]["dev_fdr_effect_ci"] = dev_pass
    lockbox_state = {"n": ds.lockbox.n, "hash": ds.lockbox.hash, "opened": False}
    if dev_pass:
        prim_bt = backtests[ph]
        robust = _robustness(inputs, pre, ds, prim_bt, seed)
        placebo = _placebo(pre, ds, prim["delta_mae"], seed)
        try:
            lock_rows = ds.lockbox.open(pre["hash"])
            lockbox_state["opened"] = True
        except LockboxError as e:  # pragma: no cover
            lock_rows = None
            verdict_in["reasons"].append(str(e))
        if lock_rows is not None and len(lock_rows) >= thr["minHoldoutOrigins"]:
            allrows = pd.concat([ds.rows, lock_rows], ignore_index=True)
            mask = allrows["origin"].isin(lock_rows["origin"]).to_numpy()
            hbt = rolling_origin(allrows, ds.feature_sets, mask, ds.spec.min_train, 1)
            hc = _compare(hbt, pc, ph, thr, seed, f"holdout-{pc}-{ph}")
            hc["losses"] = _full_losses(hbt)
            hc["pass"] = bool(
                hc.get("p_raw") is not None
                and hc["p_raw"] <= thr["holdoutAlpha"]
                and (hc["relative_improvement"] or 0) >= thr["minRelativeImprovement"]
            )
            holdout = hc
        else:
            holdout = {"status": "INSUFFICIENT_DATA", "n_origins": 0 if lock_rows is None else len(lock_rows), "required": thr["minHoldoutOrigins"]}
    verdict = _verdict(pre, prereg_ok, prim, dev_pass, enough, robust, placebo, holdout, thr, ds)
    # --- assemble artifacts ---
    return _artifacts(inputs, pre, source, results, bh, datasets, backtests, leak_reports, robust, placebo, holdout, lockbox_state, verdict, seed, prereg_ok)


def _verdict(pre, prereg_ok, prim, dev_pass, enough, robust, placebo, holdout, thr, ds) -> dict:
    reasons = []
    if not prereg_ok:
        return {"status": "NOT_REPRODUCIBLE", "evidenceStrength": "exploratory", "reasons": ["preregistration hash does not match its content"], "thresholdsFrom": "frozen_preregistration"}
    if not ds.complete:
        reasons.append("dataset not complete: " + "; ".join(ds.incomplete_reasons))
        return {"status": "INSUFFICIENT_DATA", "evidenceStrength": "exploratory", "reasons": reasons, "thresholdsFrom": "frozen_preregistration"}
    if not enough:
        return {"status": "INSUFFICIENT_DATA", "evidenceStrength": "exploratory", "reasons": [f"only {prim.get('n_origins', 0)} development origins; preregistered minimum is {thr['minDevOrigins']}"], "thresholdsFrom": "frozen_preregistration"}
    if not dev_pass:
        return {"status": "UNSUPPORTED", "evidenceStrength": "pre_registered", "reasons": ["development comparison did not meet the preregistered FDR, effect-size and CI criteria; lockbox left sealed"], "thresholdsFrom": "frozen_preregistration"}
    if holdout is None or holdout.get("status") == "INSUFFICIENT_DATA":
        return {"status": "INSUFFICIENT_DATA", "evidenceStrength": "pre_registered", "reasons": [f"holdout has fewer than {thr['minHoldoutOrigins']} origins; a development-only win cannot be SUPPORTED"], "thresholdsFrom": "frozen_preregistration"}
    fails = []
    if not holdout["pass"]:
        fails.append("holdout did not confirm the development effect")
    if robust["agree_share"] is None or robust["agree_share"] < thr["robustnessAgreeShare"]:
        fails.append(f"robustness agreement {robust['agree_share']} below {thr['robustnessAgreeShare']}")
    if not placebo["passed"]:
        fails.append("placebo/falsification test not passed")
    if fails:
        return {"status": "MIXED", "evidenceStrength": "pre_registered", "reasons": fails, "thresholdsFrom": "frozen_preregistration"}
    return {"status": "SUPPORTED", "evidenceStrength": "out_of_sample", "reasons": ["development, lockbox holdout, robustness and falsification all met preregistered thresholds; predictive only, not causal"], "thresholdsFrom": "frozen_preregistration"}


def _hac_estimates(pre: dict, ds: Dataset) -> dict:
    cand = pre["primaryCandidate"]
    cols = ds.feature_sets[cand]
    X = sm.add_constant(ds.rows[cols].to_numpy(dtype=float))
    y = ds.rows["target"].to_numpy()
    fit = sm.OLS(y, X).fit(cov_type="HAC", cov_kwds={"maxlags": max(ds.spec.horizon, 1)})
    ci = fit.conf_int()
    names = ["const"] + cols
    return {"model": cand, "estimator": "OLS_HAC_in_development_window_descriptive", "n": int(fit.nobs), "coefficients": [{"name": n, "coef": float(b), "se": float(s), "ci95": [float(lo), float(hi)]} for n, b, s, (lo, hi) in zip(names, fit.params, fit.bse, ci)]}


def _artifacts(inputs, pre, source, results, bh, datasets, backtests, leak_reports, robust, placebo, holdout, lockbox_state, verdict, seed, prereg_ok) -> dict:
    ph, pc = pre["primaryHorizon"], pre["primaryCandidate"]
    ds = datasets[ph]
    bt = backtests[ph]
    manifest_cols = {k: v for k, v in ds.manifest.items()}
    counter = []
    for h, res in results.items():
        for c, r in res.items():
            if r.get("n_origins", 0) == 0:
                counter.append({"kind": "no_origins", "candidate": c, "horizon": h})
            elif not r.get("fdr_reject") or (r.get("delta_mae") or 0) <= 0:
                counter.append({"kind": "no_fdr_significant_gain", "candidate": c, "horizon": h, "delta_mae": r.get("delta_mae"), "p_adjusted": r.get("p_adjusted")})
    if robust:
        for k, v in robust["checks"].items():
            if v.get("status") == "OK" and v["delta_mae"] <= 0:
                counter.append({"kind": "robustness_check_contradicts", "check": k, "delta_mae": v["delta_mae"]})
            if v.get("status") in ("INSUFFICIENT_DATA", "NOT_TESTABLE"):
                counter.append({"kind": "untestable", "check": k, "status": v["status"]})
    if holdout and holdout.get("pass") is False:
        counter.append({"kind": "holdout_failed", "delta_mae": holdout.get("delta_mae")})
    limitations = [
        "Predictive (Granger-style) evidence only; causality is excluded from the claim.",
        "Private/confidential Intents execution after the 2026-10-27 regime is unobserved, not zero.",
        f"Post-regime window is analysed separately and has {len(ds.post_rows)} usable rows.",
        "Models are ridge regressions on log1p-scale features; no nonlinear model class is claimed.",
    ] + ds.incomplete_reasons
    for k in ("registration", "stablecoinRoutes"):
        if source.get(k):
            limitations.append(str(source[k]))
    if source.get("label") == "SYNTHETIC":
        limitations.append("SYNTHETIC fixture: results demonstrate method behaviour only and make no claim about real NEAR data.")
    infs = {f"{h}:{c}": r["inference"] for h, res in results.items() for c, r in res.items() if "inference" in r}
    not_valid = sorted(k for k, v in infs.items() if v["status"] != fs.VALID)
    if not_valid:
        limitations.append(
            f"Statistical significance is not claimed for {len(not_valid)} of {len(infs)} comparisons: every candidate model contains the baseline (nested), so Diebold-Mariano inference is not valid under the null, and the fixed-m method's calibration status is attached to each comparison (amendment 002, post_hoc_methodological_correction)."
        )
    hypothesis = {"text": pre["hypothesis"], "primaryOutcome": pre["primaryOutcome"], "primaryComparison": f"{pc} vs baseline", "primaryHorizon": ph, "causalClaim": "excluded"}
    snapshot = {
        "label": source.get("label"),
        "source": source,
        "developmentRows": int(len(ds.rows)),
        "lockbox": lockbox_state,
        "postRegimeRows": int(len(ds.post_rows)),
        "straddleRowsExcluded": ds.straddle_rows,
        "datasetHash": ds.hash,
        "coverage": ds.coverage,
        "complete": ds.complete,
        "droppedSamples": {"count": len(ds.dropped), "protocol": pre["nullPolicy"], "items": ds.dropped[:100]},
        "excludedAccounts": ds.excluded_accounts,
        "leakageChecks": {str(h): r for h, r in leak_reports.items()},
        "regimeSplit": pre["split"]["regimeSplit"],
    }
    features = {"horizon": ph, "target": {"transform": "log1p", "definition": "organic successful actions at origin+h"}, "columns": manifest_cols, "featureSets": ds.feature_sets, "lagAlignment": "calendar-day shift on a complete UTC-day index; missing day = NaN"}
    models = {"classes": list(MODEL_CLASSES), "estimator": "standardised ridge, alpha=1.0, scaler fit on training rows per origin", "simpleBaselines": list(SIMPLE_BASELINES), "libraryVersions": _versions()}
    windows = {
        "design": "rolling_origin_expanding",
        "development": {"firstOrigin": _d(ds.rows["origin"].min()), "lastOrigin": _d(ds.rows["origin"].max()), "scoredOrigins": int(len(bt.actual))},
        "lockbox": {"n": lockbox_state["n"], "opened": lockbox_state["opened"], "hash": lockbox_state["hash"]},
        "postRegime": {"rows": int(len(ds.post_rows)), "analysedSeparately": True},
    }
    estimates = {
        "primary": results[ph][pc],
        "byHorizonCandidate": {f"{h}:{c}": r for h, res in results.items() for c, r in res.items()},
        "fdr": {**bh, "family": pre["family"]},
        "inferenceSummary": {
            "methodVersion": fs.METHOD_VERSION,
            "label": fs.LABEL,
            "calibration": calibration_summary(),
            "comparisons": {k: {"status": v["status"], "nested": v["nested"], "significanceClaimAllowed": v["significance_claim_allowed"], "conclusion": v["conclusion"]["state"]} for k, v in infs.items()},
            "primaryStatisticalClaim": "supported" if infs.get(f"{ph}:{pc}", {}).get("significance_claim_allowed") else "not_supported",
        },
        "losses": {"development": _full_losses(bt), "holdout": (holdout or {}).get("losses")},
        "descriptiveCoefficients": _hac_estimates(pre, ds),
        "holdout": holdout,
    }
    uncertainty = {"deltaMaeCI": results[ph][pc].get("delta_mae_ci"), "method": "moving-block bootstrap on absolute-error differential", "holdoutDeltaMaeCI": (holdout or {}).get("delta_mae_ci"), "validOrigins": results[ph][pc].get("n_origins")}
    falsification = {"placebo": placebo, "leakage": {str(h): r["clean"] for h, r in leak_reports.items()}, "lagComparison": (robust or {}).get("lag_comparison"), "robustness": robust}
    reproduction = {"command": source.get("reproductionCommand"), "seed": seed, "preregistrationHash": pre["hash"], "libraryVersions": _versions(), "tolerance": {"absolute": 1e-9, "canonicalJsonDigits": 10}}
    sections = {
        "hypothesis": hypothesis,
        "preregistration": pre,
        "inputSnapshot": snapshot,
        "features": features,
        "models": models,
        "windows": windows,
        "estimates": estimates,
        "uncertainty": uncertainty,
        "counterevidence": counter,
        "limitations": limitations,
        "falsification": falsification,
        "reproduction": reproduction,
    }
    return {
        "schemaVersion": SCHEMA_VERSION,
        "methodVersion": METHOD_VERSION,
        "experimentId": pre["experimentId"],
        "status": verdict["status"],
        "evidenceStrength": verdict["evidenceStrength"],
        "verdict": verdict,
        "claimScope": "synthetic_fixture_only_no_live_claim" if source.get("label") == "SYNTHETIC" else "live_dataset_subject_to_coverage",
        "preregistrationVerified": prereg_ok,
        **sections,
        "artifactHashes": {k: "sha256:" + json_hash(v) for k, v in sections.items()},
    }


def _d(t) -> str:
    return pd.Timestamp(t).strftime("%Y-%m-%d")


def _versions() -> dict:
    import scipy, sklearn, statsmodels

    return {"numpy": np.__version__, "pandas": pd.__version__, "scipy": scipy.__version__, "statsmodels": statsmodels.__version__, "scikit-learn": sklearn.__version__}
