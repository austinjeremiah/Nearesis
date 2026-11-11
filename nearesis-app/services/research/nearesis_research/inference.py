"""Statistical comparison, uncertainty, FDR and falsification."""

from __future__ import annotations

import numpy as np
import statsmodels.api as sm
from scipy import stats

from .core import rng


def diebold_mariano(abs_e_base: np.ndarray, abs_e_cand: np.ndarray, horizon: int) -> dict:
    """One-sided DM test on absolute-error loss differential d = |e0| - |e1| (positive = candidate better). HAC
    (Newey-West) standard error with maxlags = horizon, Student-t reference with n-1 df (conservative)."""
    d = np.asarray(abs_e_base) - np.asarray(abs_e_cand)
    n = len(d)
    if n < 5 or np.allclose(d, d[0]) and n:
        return {"n": n, "mean_diff": float(d.mean()) if n else None, "t": None, "p_one_sided": None}
    fit = sm.OLS(d, np.ones(n)).fit(cov_type="HAC", cov_kwds={"maxlags": max(horizon, 1)})
    t = float(fit.tvalues[0])
    return {"n": n, "mean_diff": float(d.mean()), "t": t, "p_one_sided": float(stats.t.sf(t, df=n - 1))}


def block_bootstrap_ci(d: np.ndarray, block: int, n_boot: int, seed: int, label: str, level: float = 0.95) -> dict:
    d = np.asarray(d, dtype=float)
    n = len(d)
    if n < 2 * block:
        return {"lo": None, "hi": None, "level": level, "n_boot": 0}
    r = rng(seed, "bootstrap", label)
    nb = int(np.ceil(n / block))
    starts = r.integers(0, n - block + 1, size=(n_boot, nb))
    means = np.array([np.concatenate([d[s : s + block] for s in row])[:n].mean() for row in starts])
    a = (1 - level) / 2
    return {"lo": float(np.quantile(means, a)), "hi": float(np.quantile(means, 1 - a)), "level": level, "n_boot": n_boot}


def benjamini_hochberg(pvals: list[float | None], q: float) -> dict:
    """BH step-up over the pre-registered family. None p-values (untestable) stay in the family count as p=1."""
    m = len(pvals)
    p = np.array([1.0 if v is None else v for v in pvals])
    order = np.argsort(p, kind="stable")
    ranked = p[order]
    adj_sorted = np.minimum.accumulate((ranked * m / (np.arange(m) + 1))[::-1])[::-1]
    adj_sorted = np.minimum(adj_sorted, 1.0)
    adj = np.empty(m)
    adj[order] = adj_sorted
    return {"adjusted": adj.tolist(), "reject": (adj <= q).tolist(), "m": m, "q": q}


def placebo_shift_pvalue(real_delta: float, placebo_deltas: list[float]) -> float:
    """Share of placebo (time-shifted predictor) improvements at least as large as the real one (+1 smoothing)."""
    k = sum(1 for v in placebo_deltas if v >= real_delta)
    return (k + 1) / (len(placebo_deltas) + 1)


# ---- Q14: loss metrics and the two-sided paired comparison with a serial-correlation-robust variance ----

def mae(e: np.ndarray) -> float:
    return float(np.mean(np.abs(e)))


def bias(e: np.ndarray) -> float:
    """Mean signed error, forecast minus actual."""
    return float(np.mean(e))


def smape(actual: np.ndarray, forecast: np.ndarray) -> float:
    """sMAPE = mean(2|f-a| / (|a|+|f|)). Zero rule (frozen): a term whose denominator is 0 contributes 0, never NaN."""
    a, f = np.asarray(actual, float), np.asarray(forecast, float)
    den = np.abs(a) + np.abs(f)
    return float(np.mean(np.where(den == 0, 0.0, 2 * np.abs(f - a) / np.where(den == 0, 1.0, den))))


def long_run_variance(d: np.ndarray, max_lags: int, kernel: str = "bartlett") -> float:
    """Bartlett-weighted sum of autocovariances (population divisor n). max_lags=0 gives the i.i.d. variance."""
    d = np.asarray(d, float)
    n = len(d)
    c = d - d.mean()
    v = float(c @ c) / n
    for k in range(1, max_lags + 1):
        w = 1.0 - k / (max_lags + 1) if kernel == "bartlett" else 1.0
        v += 2 * w * float(c[k:] @ c[:-k]) / n
    return v


def dm_paired(d: np.ndarray, max_lags: int, variance: str = "hac") -> dict:
    """Two-sided Diebold-Mariano test on the loss differential d. Statistic = mean(d) / sqrt(V/n) with a Bartlett HAC
    long-run variance V (variance='hac'); variance='iid' ignores serial correlation. Reference: Student t with n-1 df."""
    d = np.asarray(d, float)
    n = len(d)
    v = long_run_variance(d, max_lags if variance == "hac" else 0)
    if n < 3 or v <= 0:
        return {"n": n, "statistic": None, "p_value": None, "variance": v}
    t = float(d.mean() / np.sqrt(v / n))
    return {"n": n, "statistic": t, "p_value": float(2 * stats.t.sf(abs(t), df=n - 1)), "variance": v}


def paired_comparison(abs_e_base: np.ndarray, abs_e_cand: np.ndarray, frozen) -> dict:
    """delta_MAE = MAE(base) - MAE(cand) with a frozen-method interval and a DM test; no p-value below the frozen minimum
    number of origins (INSUFFICIENT_DATA)."""
    q = frozen.get("q14")
    d = np.asarray(abs_e_base, float) - np.asarray(abs_e_cand, float)
    n = len(d)
    iv = q["interval"]
    out = {"n_origins": n, "delta_mae": float(d.mean()) if n else None, "interval": {"method": iv["method"], "level": iv["level"]}}
    if n < q["minOriginsForPValue"]:
        out.update(status="INSUFFICIENT_DATA", p_value=None, statistic=None, reason=f"{n} origins; frozen minimum is {q['minOriginsForPValue']}")
        out["interval"].update(lo=None, hi=None)
        return out
    r = dm_paired(d, q["dm"]["maxLags"])
    ci = block_bootstrap_ci(d, iv["block"], iv["nBoot"], iv["bootstrapSeed"], "q14", iv["level"])
    out.update(status="OK", p_value=r["p_value"], statistic=r["statistic"])
    out["interval"].update(lo=ci["lo"], hi=ci["hi"])
    return out
