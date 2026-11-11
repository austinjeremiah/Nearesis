"""Robustness matrix for Q18. Variant list, windows, cohort rules and the sign-flip rule come from the frozen
preregistration. Every named variant is a row; a variant that cannot be computed is NOT_COMPUTABLE with a reason, never
omitted and never zero-filled."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .dataset import Inputs, Spec, build_dataset
from .experiment import _delta_for
from .frozen import Frozen
from .models import rolling_origin


class MatrixConfigInvalid(ValueError):
    def __init__(self, missing: list[str], extra: list[str]):
        super().__init__(f"robustness configuration does not match the preregistered family: missing {missing}, unexpected {extra}")
        self.missing, self.extra = missing, extra


def validate_config(variants: list[str], frozen: Frozen) -> None:
    want = list(frozen.get("q18.variants"))
    miss = [v for v in want if v not in variants]
    extra = [v for v in variants if v not in want]
    if miss or extra:
        raise MatrixConfigInvalid(miss, extra)


def _spec(frozen: Frozen, **kw) -> Spec:
    e = frozen.get("experiment")
    return Spec(horizon=e["primaryHorizon"], lag_grid=tuple(e["lagGrid"]), lockbox_days=e["lockboxDays"], min_train=e["minTrain"], regime_split=e["regimeSplit"], **kw)


def _row(res: dict, **extra) -> dict:
    if res.get("status") == "OK":
        return {"status": "OK", "n_origins": res["n_origins"], "estimates": [{"name": "all", "delta_mae": res["delta_mae"], "relative_improvement": res["relative_improvement"]}], **extra}
    return {"status": "NOT_COMPUTABLE", "reason": res.get("reason", "no scored origins under the preregistered minimum training length"), **extra}


def _swap_x(inputs: Inputs, series: pd.Series) -> Inputs:
    d = inputs.daily.copy()
    d["intents_volume_usd"] = d["date"].map(series).to_numpy()
    return Inputs(d, inputs.accounts, inputs.target_aggregate, inputs.label)


def run_matrix(inputs: Inputs, route_volume: pd.DataFrame | None, frozen: Frozen, variants: list[str] | None = None) -> dict:
    validate_config(variants if variants is not None else list(frozen.get("q18.variants")), frozen)
    q = frozen.get("q18")
    e = frozen.get("experiment")
    thr = e["thresholds"]
    cand = e["primaryCandidate"]
    spec = _spec(frozen)
    ds = build_dataset(inputs, spec, frozen.doc_hash)
    fs = {"baseline": ds.feature_sets["baseline"], cand: ds.feature_sets[cand]}
    prim = _delta_for(ds.rows, ds, cand, fs, thr)
    primary = {"status": prim["status"], "delta_mae": prim.get("delta_mae"), "relative_improvement": prim.get("relative_improvement"), "n_origins": prim.get("n_origins")}
    days = len(pd.date_range(inputs.daily["date"].min(), inputs.daily["date"].max(), freq="D"))
    rows: dict[str, dict] = {}
    for w in q["windows"]:
        need = w + q["windowMinExtraDays"]
        if days < need:
            rows[f"window_{w}d"] = {"status": "NOT_COMPUTABLE", "reason": f"series has {days} calendar days; a {w}-day window needs {need}"}
        else:
            rows[f"window_{w}d"] = _row(_delta_for(ds.rows, ds, cand, fs, thr, window=w, min_train=min(w, 25)))
    for pct in q["topCohortPct"]:
        name = f"top_{pct}pct_accounts_removed"
        if inputs.accounts is None:
            rows[name] = {"status": "NOT_COMPUTABLE", "reason": "no account-level data in this input"}
            continue
        ds2 = build_dataset(inputs, _spec(frozen, top_pct=float(pct)), frozen.doc_hash)
        r = _row(_delta_for(ds2.rows, ds2, cand, {"baseline": ds2.feature_sets["baseline"], cand: ds2.feature_sets[cand]}, thr))
        r["excludedAccounts"] = ds2.excluded_accounts
        rows[name] = r
    bt = rolling_origin(ds.rows, fs, np.ones(len(ds.rows), bool), spec.min_train, 1, models=("baseline", cand), baselines=False)
    keep = bt.actual <= np.quantile(bt.actual, q["outlierQuantile"])
    eb, ec = bt.abs_err("baseline")[keep], bt.abs_err(cand)[keep]
    rows["outlier_days_excluded"] = _row({"status": "OK", "n_origins": int(keep.sum()), "delta_mae": float(eb.mean() - ec.mean()), "relative_improvement": float((eb.mean() - ec.mean()) / eb.mean())})
    for cls, name in (("stablecoin", "stablecoin_only_routes"), ("non_stablecoin", "non_stablecoin_routes")):
        present = route_volume is not None and (route_volume["route_class"] == cls).any()
        if not present:
            rows[name] = {"status": "NOT_COMPUTABLE", "reason": f"no '{cls}' route rows in the input (route class absent, not zero)"}
            continue
        s = route_volume[route_volume["route_class"] == cls].set_index("date")["volume"]
        i2 = _swap_x(inputs, s)
        d2 = build_dataset(i2, spec, frozen.doc_hash)
        rows[name] = _row(_delta_for(d2.rows, d2, cand, {"baseline": d2.feature_sets["baseline"], cand: d2.feature_sets[cand]}, thr))
    rows["pre_oct27_regime"] = _row(prim, note="the pre-regime window is the development window; never mixed with post-regime rows")
    n_post = len(ds.post_rows)
    if n_post < q["minPostRegimeRows"]:
        rows["post_oct27_regime"] = {"status": "NOT_COMPUTABLE", "reason": f"{n_post} post-regime rows; the frozen minimum is {q['minPostRegimeRows']}"}
    else:
        rows["post_oct27_regime"] = _row(_delta_for(ds.post_rows, ds, cand, fs, thr))
    rows["public_vs_confidential"] = {"status": "NOT_COMPUTABLE", "reason": "confidential execution is unobserved in public data (ch.14); it is not assumed zero"}
    if inputs.accounts is None:
        rows["segment_targets"] = {"status": "NOT_COMPUTABLE", "reason": "no account-level data for segment targets"}
    else:
        start = ds.lockbox.first_origin or pd.Timestamp(inputs.daily["date"].max())
        a = inputs.accounts[(inputs.accounts["date"] < start) & (~inputs.accounts["account"].isin(spec.intents_accounts))]
        tot = a.groupby("account")["actions"].sum().sort_values(ascending=False, kind="stable")
        head = sorted(tot.index[: q["segmentHeadAccounts"]].tolist())
        ests, reasons = [], []
        for seg, accts in (("head", head), ("tail", sorted(set(tot.index) - set(head)))):
            acc = inputs.accounts[inputs.accounts["account"].isin(accts)]
            dsg = build_dataset(Inputs(inputs.daily, acc), spec, frozen.doc_hash)
            r = _delta_for(dsg.rows, dsg, cand, {"baseline": dsg.feature_sets["baseline"], cand: dsg.feature_sets[cand]}, thr)
            if r.get("status") == "OK":
                ests.append({"name": seg, "delta_mae": r["delta_mae"], "relative_improvement": r["relative_improvement"]})
            else:
                reasons.append(seg)
        rows["segment_targets"] = {"status": "OK", "estimates": ests, "n_origins": None} if ests and not reasons else {"status": "NOT_COMPUTABLE", "reason": f"segments without scored origins: {reasons}"}
    assert set(rows) == set(q["variants"]), (set(rows) ^ set(q["variants"]))
    return {"primary": primary, "rows": {k: rows[k] for k in q["variants"]}, "signFlipRule": q["signFlipRule"]}


def apply_sign_flip_rule(primary_delta: float, matrix_rows: dict, headline_status: str) -> dict:
    """A computed variant whose delta_mae sign is opposite to the primary caps the headline at MIXED."""
    flips = []
    for name, r in matrix_rows.items():
        if r["status"] != "OK":
            continue
        for est in r["estimates"]:
            if est["delta_mae"] is not None and np.sign(est["delta_mae"]) == -np.sign(primary_delta) and est["delta_mae"] != 0:
                flips.append(f"{name}:{est['name']}")
    status = headline_status
    if flips and headline_status == "SUPPORTED":
        status = "MIXED"
    return {"flips": flips, "headlineBefore": headline_status, "headlineAfter": status}
