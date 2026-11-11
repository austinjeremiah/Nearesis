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


def dm_candidate_reference(d: list[float], cand: dict, rho_clip: float, andrews_const: float, horizon: int = 1) -> dict:
    """Independent plain-loop reference for the amendment-001 candidates (written from the amendment text only; production
    code never imports this module). Student-t tail through the regularised incomplete beta."""
    n = len(d)
    dbar = sum(d) / n
    c = [x - dbar for x in d]

    def rho_of(c):
        num = sum(c[t] * c[t - 1] for t in range(1, len(c)))
        den = sum(c[t - 1] ** 2 for t in range(1, len(c)))
        r = num / den if den > 0 else 0.0
        return max(-rho_clip, min(rho_clip, r))

    rule = cand["lag"]
    if rule["rule"] == "fixed":
        lag = rule["value"]
    elif rule["rule"] == "nw94":
        lag = math.floor(4 * (n / 100) ** (2 / 9))
    else:
        r = rho_of(c)
        a1 = 4 * r * r / ((1 - r) ** 2 * (1 + r) ** 2)
        lag = min(math.floor(andrews_const * (a1 * n) ** (1 / 3)), n - 2)

    def lrv(x, divisor):
        def g(k):
            return sum(x[t] * x[t - k] for t in range(k, len(x))) / divisor

        v = g(0)
        for k in range(1, lag + 1):
            v += 2 * (1 - k / (lag + 1)) * g(k)
        return v

    if cand["prewhiten"]:
        r = rho_of(c)
        u = [c[t] - r * c[t - 1] for t in range(1, n)]
        v = lrv(u, n - 1) / (1 - r) ** 2
    else:
        v = lrv(c, n)
    t = dbar / math.sqrt(v / n)
    if cand["hln"]:
        h = horizon
        t *= math.sqrt((n + 1 - 2 * h + h * (h - 1) / n) / n)
    nu = n - 1
    return {"statistic": t, "p_value": float(betainc(nu / 2.0, 0.5, nu / (nu + t * t))), "variance": v, "lag": lag}
