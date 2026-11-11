"""Target construction for Q12: four target families at 1/7/14-day horizons, organic and unadjusted, each its own result.

Definitions (frozen names in q12): per calendar day, successful_actions = sum of actions, unique_signer_proxies = distinct
accounts with a row, contract_diversity = distinct contracts with a row, application_tagged_actions = sum of actions over
rows that carry an application tag. `organic` keeps rows tagged exactly an organic tag; every other tag, including
`unclassified`, is excluded (declared rule `unclassified_is_not_organic`). `unadjusted` keeps all rows. A calendar day with
no rows is missing (NaN), a present day whose kept rows are empty is 0. The target at origin t is the value on day t+h."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .core import json_hash
from .frozen import Frozen
from .inference import benjamini_hochberg, block_bootstrap_ci, dm_paired
from .verdict import grade


def _calendar(rows: pd.DataFrame) -> pd.DatetimeIndex:
    return pd.date_range(rows["date"].min(), rows["date"].max(), freq="D")


def _family_value(df: pd.DataFrame, family: str) -> pd.Series:
    g = df.groupby("date")
    if family == "successful_actions":
        return g["actions"].sum()
    if family == "unique_signer_proxies":
        return g["account"].nunique()
    if family == "contract_diversity":
        return g["contract"].nunique()
    if family == "application_tagged_actions":
        return df[df["app"].notna() & (df["app"] != "")].groupby("date")["actions"].sum()
    raise ValueError(family)


def daily_series(rows: pd.DataFrame, family: str, variant: str, frozen: Frozen, organic_rule: str = "declared") -> pd.Series:
    q = frozen.get("q12")
    cal = _calendar(rows)
    present = pd.DatetimeIndex(rows["date"].unique())
    if variant == "organic":
        if organic_rule == "declared":
            kept = rows[rows["tag"].isin(q["organicTags"])]
        else:  # control only: treat unclassified as organic (not the frozen rule)
            kept = rows[~rows["tag"].isin(q["excludedFromOrganic"])]
    elif variant == "unadjusted":
        kept = rows
    else:
        raise ValueError(variant)
    s = _family_value(kept, family).reindex(cal)
    s[cal.isin(present) & s.isna()] = 0.0
    s[~cal.isin(present)] = np.nan
    return s.astype(float)


def target_series(daily: pd.Series, h: int) -> pd.DataFrame:
    """Row per origin t: raw value at t+h and its log1p. Uses nothing after t+h by construction (a pure shift)."""
    raw = daily.shift(-h)
    return pd.DataFrame({"raw": raw, "log1p": np.log1p(raw)})


def build_targets(rows: pd.DataFrame, frozen: Frozen, organic_rule: str = "declared") -> dict:
    q = frozen.get("q12")
    out = {}
    for fam in q["families"]:
        for h in q["horizons"]:
            for variant in ("organic", "unadjusted"):
                out[f"{fam}|{h}|{variant}"] = target_series(daily_series(rows, fam, variant, frozen, organic_rule), h)
    return out


def series_hash(t: pd.DataFrame) -> str:
    return "sha256:" + json_hash({"raw": t["raw"].tolist(), "log1p": t["log1p"].tolist()})


def _baseline_errors(daily: pd.Series, h: int) -> tuple[np.ndarray, np.ndarray]:
    """Absolute log1p errors of naive_last and seasonal_naive forecasts of day t+h made at origin t."""
    ly = np.log1p(daily)
    actual = ly.shift(-h)
    k = int(np.ceil(h / 7))
    naive = ly
    seas = ly.shift(7 * k - h)
    ok = actual.notna() & naive.notna() & seas.notna()
    return (actual - naive)[ok].abs().to_numpy(), (actual - seas)[ok].abs().to_numpy()


def per_target_results(rows: pd.DataFrame, frozen: Frozen) -> dict:
    """Each target series gets its own estimate (delta MAE, naive_last minus seasonal_naive), uncertainty and verdict. The
    frozen FDR family is the whole target grid. These are descriptive baseline comparisons on a SYNTHETIC fixture."""
    q = frozen.get("q12")
    thr = frozen.get("experiment.thresholds")
    fdr = frozen.get("experiment.fdr")
    keys, parts = [], {}
    for fam in q["families"]:
        for h in q["horizons"]:
            for variant in ("organic", "unadjusted"):
                k = f"{fam}|{h}|{variant}"
                eb, ec = _baseline_errors(daily_series(rows, fam, variant, frozen), h)
                d = eb - ec
                n = len(d)
                dm = dm_paired(d, max(h, 1)) if n >= 5 else {"p_value": None}
                ci = block_bootstrap_ci(d, thr["bootstrap"]["block"], thr["bootstrap"]["n"], frozen.get("q14.interval.bootstrapSeed"), k, thr["bootstrap"]["level"])
                p_one = None if dm["p_value"] is None else (dm["p_value"] / 2 if d.mean() > 0 else 1 - dm["p_value"] / 2)
                parts[k] = {"n_origins": n, "delta_mae": float(d.mean()) if n else None, "relative_improvement": float(d.mean() / eb.mean()) if n and eb.mean() > 0 else None, "ci": ci, "p_one_sided": p_one}
                keys.append(k)
    bh = benjamini_hochberg([parts[k]["p_one_sided"] for k in keys], fdr["q"])
    out = {}
    for k, adj, rej in zip(keys, bh["adjusted"], bh["reject"]):
        r = parts[k]
        lo = r["ci"]["lo"]
        enough = r["n_origins"] >= thr["minDevOrigins"]
        dev_pass = bool(enough and rej and (r["relative_improvement"] or 0) >= thr["minRelativeImprovement"] and lo is not None and lo > 0)
        g = grade({"enoughDevOrigins": enough, "devPass": dev_pass, "holdout": "none"}, frozen)
        out[k] = {"estimate": {"delta_mae": r["delta_mae"], "relative_improvement": r["relative_improvement"], "n_origins": r["n_origins"], "p_adjusted": adj},
                  "uncertainty": {"delta_mae_ci": r["ci"]}, "verdict": {"status": g["status"], "evidenceStrength": g["evidenceStrength"]}}
    return out


def combined_average(results: dict, frozen: Frozen) -> dict:
    """A request for one 'average across targets' result is answered, labelled non-primary, with every component listed."""
    vals = [r["estimate"]["delta_mae"] for r in results.values() if r["estimate"]["delta_mae"] is not None]
    return {"label": frozen.get("q12.combinedResultLabel"), "primary": False, "mean_delta_mae": float(np.mean(vals)), "components": sorted(results), "componentVerdicts": {k: r["verdict"]["status"] for k, r in sorted(results.items())}}
