"""Amended Diebold-Mariano estimators (preregistration amendment 001, post_hoc_methodological_correction).

Every candidate is described by a config dict taken from the amendment's frozen block (`docs/research/
PREREGISTRATION-AMENDMENT-001.md`); nothing here chooses a lag, constant or correction itself. The label of every result
produced through this module is `post_hoc_methodological_correction`."""

from __future__ import annotations

import math

import numpy as np
from scipy import stats

LABEL = "post_hoc_methodological_correction"


def _gamma(x: np.ndarray, k: int, divisor: int) -> float:
    return float(x[k:] @ x[: len(x) - k]) / divisor


def bartlett_lrv(x: np.ndarray, lag: int, divisor: int) -> float:
    v = _gamma(x, 0, divisor)
    for k in range(1, lag + 1):
        v += 2 * (1 - k / (lag + 1)) * _gamma(x, k, divisor)
    return v


def ar1_rho(c: np.ndarray, clip: float) -> float:
    den = float(c[:-1] @ c[:-1])
    rho = float(c[1:] @ c[:-1]) / den if den > 0 else 0.0
    return max(-clip, min(clip, rho))


def nw94_lag(n: int) -> int:
    return int(math.floor(4 * (n / 100) ** (2 / 9)))


def andrews_lag(c: np.ndarray, n: int, clip: float, const: float) -> int:
    rho = ar1_rho(c, clip)
    alpha1 = 4 * rho * rho / (((1 - rho) ** 2) * ((1 + rho) ** 2))
    s = const * (alpha1 * n) ** (1 / 3)
    return int(min(math.floor(s), n - 2))


def resolve_lag(rule: dict, c: np.ndarray, n: int, clip: float, const: float) -> int:
    if rule["rule"] == "fixed":
        return int(rule["value"])
    if rule["rule"] == "nw94":
        return nw94_lag(n)
    if rule["rule"] == "andrews_ar1":
        return andrews_lag(c, n, clip, const)
    raise ValueError(f"unknown lag rule {rule['rule']}")


def long_run_variance(d: np.ndarray, cand: dict, clip: float, const: float) -> tuple[float, int]:
    d = np.asarray(d, float)
    n = len(d)
    c = d - d.mean()
    if cand["prewhiten"]:
        rho = ar1_rho(c, clip)
        u = c[1:] - rho * c[:-1]
        lag = resolve_lag(cand["lag"], c, n, clip, const)
        return bartlett_lrv(u, lag, n - 1) / (1 - rho) ** 2, lag
    lag = resolve_lag(cand["lag"], c, n, clip, const)
    return bartlett_lrv(c, lag, n), lag


def dm_candidate(d: np.ndarray, cand: dict, params: dict, horizon: int = 1) -> dict:
    """Two-sided DM test on the loss differential d with the candidate's variance and small-sample factor."""
    d = np.asarray(d, float)
    n = len(d)
    v, lag = long_run_variance(d, cand, params["rhoClip"], params["andrewsConstant"])
    if n < 3 or not v > 0:
        return {"n": n, "statistic": None, "p_value": None, "variance": v, "lag": lag, "candidate": cand["id"], "label": LABEL}
    t = float(d.mean() / math.sqrt(v / n))
    if cand["hln"]:
        h = horizon
        t *= math.sqrt((n + 1 - 2 * h + h * (h - 1) / n) / n)
    return {"n": n, "statistic": t, "p_value": float(2 * stats.t.sf(abs(t), df=n - 1)), "variance": v, "lag": lag, "candidate": cand["id"], "label": LABEL}
