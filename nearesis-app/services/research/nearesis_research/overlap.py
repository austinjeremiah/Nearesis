"""Mechanical-overlap detector (ch.02 rejection cases, Q13). The decision is made on row identity, never on correlation."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .core import frame_hash, sha256_hex, rng
from .dataset import Inputs, Spec, build_dataset
from .experiment import _compare
from .frozen import Frozen
from .models import rolling_origin
from .verdict import grade


def detect_overlap(predictor_row_ids: set[str], target_row_ids: set[str], frozen: Frozen) -> dict:
    q = frozen.get("q13")
    shared = sorted(set(predictor_row_ids) & set(target_row_ids))
    return {
        "detector": q["detector"],
        "shared_row_count": len(shared),
        "shared_row_ids_sample": shared[:5],
        "blocked": len(shared) >= q["minSharedRowsToBlock"],
        "reason_code": q["reasonCode"] if len(shared) >= q["minSharedRowsToBlock"] else None,
    }


def make_overlap_fixture(seed: int = 20261111, n_days: int = 160) -> dict:
    """SYNTHETIC rows with explicit row IDs. `overlap` builds the predictor from a subset of the target's rows;
    `disjoint` builds it from different rows whose daily total is almost perfectly correlated with the target."""
    r = rng(seed, "overlap-fixture")
    dates = pd.date_range("2026-04-01", periods=n_days, freq="D")
    base = 400 + 60 * np.sin(2 * np.pi * np.arange(n_days) / 7) + np.cumsum(r.normal(0, 4, n_days))
    rows = []
    for i, d in enumerate(dates):
        w = r.dirichlet(np.ones(10))
        for a in range(10):
            rows.append((f"t:{d.date()}:a{a}", d, f"a{a}", int(round(base[i] * w[a]))))
    target = pd.DataFrame(rows, columns=["row_id", "date", "account", "actions"])
    y = target.groupby("date")["actions"].sum()
    head_ids = set(target[target["account"].isin(["a0", "a1", "a2", "a3"])]["row_id"])
    over = target[target["row_id"].isin(head_ids)]
    x_over = over.groupby("date")["actions"].sum().reindex(dates).astype(float)
    pr = rng(seed, "disjoint-predictor")
    p_rows = [(f"p:{d.date()}", d, float(y.loc[d] * 0.5 + pr.normal(0, 2.0))) for d in dates]
    pred = pd.DataFrame(p_rows, columns=["row_id", "date", "volume"])
    x_disj = pred.set_index("date")["volume"].reindex(dates)
    corr = float(np.corrcoef(y.to_numpy(), x_disj.to_numpy())[0, 1])
    price = np.exp(np.cumsum(rng(seed, "overlap-price").normal(0, 0.02, n_days)) + 1.0)
    return {
        "target_rows": target,
        "overlap": {"predictor_row_ids": head_ids, "x": x_over},
        "disjoint": {"predictor_row_ids": set(pred["row_id"]), "x": x_disj, "corr_with_target": corr},
        "dates": dates,
        "price": pd.Series(price, index=dates),
        "hash": sha256_hex(frame_hash(target) + frame_hash(pred)),
    }


def run_claim(fx: dict, variant: str, frozen: Frozen) -> dict:
    """Runs the claim 'lagged predictor x improves the forecast of the target' for one variant. The overlap check runs
    before any model is fitted; a blocked claim reports no performance numbers."""
    v = fx[variant]
    target_ids = set(fx["target_rows"]["row_id"])
    ov = detect_overlap(v["predictor_row_ids"], target_ids, frozen)
    if ov["blocked"]:
        return {"status": frozen.get("q13.blockedStatus"), "reason_code": ov["reason_code"], "shared_row_count": ov["shared_row_count"], "overlap": ov, "variant": variant}
    daily = pd.DataFrame({"date": fx["dates"], "intents_volume_usd": v["x"].to_numpy(), "price_close": fx["price"].to_numpy()})
    acc = fx["target_rows"][["date", "account", "actions"]]
    spec = Spec(horizon=1, lag_grid=(1, 2), intents_accounts=(), min_train=frozen.get("experiment.minTrain"), lockbox_days=frozen.get("experiment.lockboxDays"), regime_split="2099-01-01")
    ds = build_dataset(Inputs(daily, acc), spec, frozen.doc_hash)
    thr = frozen.get("experiment.thresholds")
    bt = rolling_origin(ds.rows, ds.feature_sets, np.ones(len(ds.rows), bool), spec.min_train, 1, models=("baseline", "intents"), baselines=False)
    cmp_ = _compare(bt, "intents", 1, thr, frozen.get("q14.interval.bootstrapSeed"), "q13")
    lo = (cmp_.get("delta_mae_ci") or {}).get("lo")
    enough = cmp_.get("n_origins", 0) >= thr["minDevOrigins"]
    dev_pass = bool(enough and (cmp_.get("relative_improvement") or 0) >= thr["minRelativeImprovement"] and lo is not None and lo > 0)
    g = grade({"enoughDevOrigins": enough, "devPass": dev_pass, "holdout": "none"}, frozen)
    return {"status": g["status"], "evidenceStrength": g["evidenceStrength"], "reason_code": None, "shared_row_count": 0, "overlap": ov, "variant": variant, "n_origins": cmp_.get("n_origins"), "relative_improvement": cmp_.get("relative_improvement")}
