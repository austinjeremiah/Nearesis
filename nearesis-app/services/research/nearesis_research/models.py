"""Four model classes (baseline, intents, price, combined), simple baselines, rolling-origin backtest and losses.

All preprocessing (standardisation) is fit on training rows only, per origin. Loss is computed on the log1p scale
(primary) and, for reporting, on the raw scale after expm1 back-transform."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

MODEL_CLASSES = ("baseline", "intents", "price", "combined")
SIMPLE_BASELINES = {"naive_last": "bl_naive", "seasonal_naive": "bl_snaive", "moving_avg_7": "bl_ma7"}
RIDGE_ALPHA = 1.0


def ridge_fit_predict(Xtr: np.ndarray, ytr: np.ndarray, Xte: np.ndarray, alpha: float = RIDGE_ALPHA) -> np.ndarray:
    mu = Xtr.mean(axis=0)
    sd = Xtr.std(axis=0)
    sd[sd == 0] = 1.0
    Z = (Xtr - mu) / sd
    yb = ytr.mean()
    w = np.linalg.solve(Z.T @ Z + alpha * np.eye(Z.shape[1]), Z.T @ (ytr - yb))
    return yb + ((Xte - mu) / sd) @ w


@dataclass
class BacktestResult:
    origins: pd.DatetimeIndex
    target_dates: pd.DatetimeIndex
    actual: np.ndarray  # log1p scale
    preds: dict  # model/baseline -> predictions (log1p scale)
    n_train: np.ndarray

    def abs_err(self, name: str) -> np.ndarray:
        return np.abs(self.actual - self.preds[name])


def rolling_origin(
    rows: pd.DataFrame,
    feature_sets: dict,
    eval_mask: np.ndarray,
    min_train: int,
    step: int = 1,
    window: int | None = None,
    models: tuple = MODEL_CLASSES,
    baselines: bool = True,
) -> BacktestResult:
    """Expanding (or fixed `window`-day) rolling origin. For the origin o, training rows are exactly those whose target
    is already known at o (target_date <= o); no random splits are used. `eval_mask` marks origins that are scored."""
    rows = rows.reset_index(drop=True)
    origins = rows["origin"].to_numpy()
    tdates = rows["target_date"].to_numpy()
    y = rows["target"].to_numpy()
    idx = np.flatnonzero(eval_mask)[::step]
    mats = {m: rows[feature_sets[m]].to_numpy(dtype=float) for m in models}
    out = {m: [] for m in models}
    if baselines:
        for b in SIMPLE_BASELINES:
            out[b] = []
    keep, ntr = [], []
    for i in idx:
        known = tdates <= origins[i]
        if window is not None:
            known &= origins >= origins[i] - np.timedelta64(window, "D")
        tr = np.flatnonzero(known)
        if len(tr) < min_train:
            continue
        keep.append(i)
        ntr.append(len(tr))
        for m in models:
            X = mats[m]
            out[m].append(float(ridge_fit_predict(X[tr], y[tr], X[i : i + 1])[0]))
        if baselines:
            for b, col in SIMPLE_BASELINES.items():
                out[b].append(float(rows[col].iloc[i]))
    keep_a = np.array(keep, dtype=int)
    return BacktestResult(
        origins=pd.DatetimeIndex(origins[keep_a]),
        target_dates=pd.DatetimeIndex(tdates[keep_a]),
        actual=y[keep_a],
        preds={k: np.array(v) for k, v in out.items()},
        n_train=np.array(ntr, dtype=int),
    )


def losses(actual_log: np.ndarray, pred_log: np.ndarray) -> dict:
    """MAE/RMSE/bias on log1p scale; MAE and sMAPE on raw scale. sMAPE zero rule: a term with |a|+|f|==0 is 0."""
    e = pred_log - actual_log
    a, f = np.expm1(actual_log), np.expm1(pred_log)
    den = np.abs(a) + np.abs(f)
    smape_terms = np.where(den == 0, 0.0, 2 * np.abs(f - a) / np.where(den == 0, 1, den))
    return {
        "mae_log": float(np.mean(np.abs(e))),
        "rmse_log": float(np.sqrt(np.mean(e**2))),
        "bias_log": float(np.mean(e)),
        "mae_raw": float(np.mean(np.abs(f - a))),
        "smape_raw": float(np.mean(smape_terms)),
        "n": int(len(e)),
    }
