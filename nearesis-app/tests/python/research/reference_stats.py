"""Independent reference implementations for Q14, written only for the tests (production code never imports this module).
Plain loops and exact rationals; the only library call is the regularised incomplete beta for the Student-t tail."""

from __future__ import annotations

import math
from fractions import Fraction

from scipy.special import betainc


def mae_exact(actual, forecast) -> Fraction:
    return sum(abs(Fraction(f) - Fraction(a)) for a, f in zip(actual, forecast)) / len(actual)


def bias_exact(actual, forecast) -> Fraction:
    return sum(Fraction(f) - Fraction(a) for a, f in zip(actual, forecast)) / len(actual)


def smape_exact(actual, forecast) -> Fraction:
    """mean over i of 2|f-a|/(|a|+|f|), a zero denominator contributing 0 (the frozen zero rule)."""
    terms = []
    for a, f in zip(actual, forecast):
        a, f = Fraction(a), Fraction(f)
        den = abs(a) + abs(f)
        terms.append(Fraction(0) if den == 0 else 2 * abs(f - a) / den)
    return sum(terms) / len(terms)


def dm_reference(d: list[float], max_lags: int) -> dict:
    """Diebold-Mariano two-sided test: mean(d)/sqrt(V/n) where V = gamma_0 + 2 * sum_{k=1..K} (1 - k/(K+1)) gamma_k (Bartlett),
    gamma_k = (1/n) sum_{t>k} (d_t - dbar)(d_{t-k} - dbar); p-value from t with n-1 df via the incomplete beta function."""
    n = len(d)
    dbar = sum(d) / n

    def gamma(k: int) -> float:
        return sum((d[t] - dbar) * (d[t - k] - dbar) for t in range(k, n)) / n

    v = gamma(0)
    for k in range(1, max_lags + 1):
        v += 2 * (1 - k / (max_lags + 1)) * gamma(k)
    t = dbar / math.sqrt(v / n)
    nu = n - 1
    p = float(betainc(nu / 2.0, 0.5, nu / (nu + t * t)))
    return {"statistic": t, "p_value": p, "variance": v}
