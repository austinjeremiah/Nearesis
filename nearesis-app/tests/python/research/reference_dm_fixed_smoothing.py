"""Independent oracle for amendment 002 (pure Python: no numpy, no scipy, nothing imported from nearesis_research).

Written from Coroneo and Iacone (2020) equations (7) to (9) and the documented `ForeComp::dm.test.wpe.fb` definition
(explicit complex exponential sums; Student t tail from the exact elementary closed form for even degrees of freedom,
Abramowitz and Stegun 26.7.4) and from the Kiefer and Vogelsang Bartlett definition with the Coroneo and Iacone Sec. 4.1
quantile polynomial. ForeComp itself could not be executed here (no local R runtime), see the amendment, section 9."""

import cmath
import math
import random

KV = (1.9600, 2.9694, 0.4160, -0.5324)


def t_two_sided_p_even_df(t: float, df: int) -> float:
    assert df % 2 == 0
    a = abs(t)
    x = df / (df + a * a)
    s, term = 0.0, 1.0
    for k in range(df // 2):
        if k > 0:
            term *= (2 * k - 1) / (2 * k) * x
        s += term
    return 1.0 - (a / math.sqrt(df + a * a)) * s


def wpe(d):
    n = len(d)
    m = int(math.floor(n ** (1.0 / 3.0) + 1e-12))
    mean = sum(d) / n
    acc = 0.0
    for j in range(1, m + 1):
        lam = 2 * math.pi * j / n
        z = sum(d[t - 1] * cmath.exp(-1j * lam * t) for t in range(1, n + 1))
        i_j = abs(z / math.sqrt(2 * math.pi * n)) ** 2
        acc += i_j
    omega = 2 * math.pi * acc / m
    if not omega > 1e-20 * (sum(x * x for x in d) / n):
        return {"m": m, "df": 2 * m, "omega": omega, "statistic": None, "p_value": None}
    t = math.sqrt(n) * mean / math.sqrt(omega)
    return {"m": m, "df": 2 * m, "omega": omega, "statistic": t, "p_value": t_two_sided_p_even_df(t, 2 * m)}


def bartlett_fixed_b(d):
    n = len(d)
    M = int(math.floor(math.sqrt(n) + 1e-12))
    mean = sum(d) / n
    c = [x - mean for x in d]
    g = lambda k: sum(c[t] * c[t - k] for t in range(k, n)) / n
    lrv = g(0) + 2 * sum((1 - k / M) * g(k) for k in range(1, M))
    b = M / n
    crit = KV[0] + KV[1] * b + KV[2] * b**2 + KV[3] * b**3
    if not lrv > 1e-20 * (sum(x * x for x in d) / n):
        return {"M": M, "b": b, "critical_value": crit, "lrv": lrv, "statistic": None, "reject": None}
    t = mean / math.sqrt(lrv / n)
    return {"M": M, "b": b, "critical_value": crit, "lrv": lrv, "statistic": t, "reject": abs(t) > crit}


def kv_limit_quantile_975(b: float, n: int = 400, reps: int = 12000, seed: int = 99) -> float:
    """Monte Carlo 0.975 quantile of |t| for iid data with Bartlett bandwidth M = b n (the fixed-b limit as n grows)."""
    r = random.Random(seed)
    M = max(1, round(b * n))
    ts = []
    for _ in range(reps):
        x = [r.gauss(0, 1) for _ in range(n)]
        mean = sum(x) / n
        c = [v - mean for v in x]
        lrv = sum(v * v for v in c) / n
        for k in range(1, M):
            lrv += 2 * (1 - k / M) * sum(c[t] * c[t - k] for t in range(k, n)) / n
        ts.append(abs(mean / math.sqrt(lrv / n)))
    ts.sort()
    return ts[int(0.95 * reps)]  # two-sided 5 percent: |t| 0.95 quantile == t 0.975 quantile


def lcg_series(seed: int, n: int, phi: float, mean: float = 0.0, burn: int = 50):
    """Deterministic AR(1) from a pure-Python generator (Box-Muller on random.Random), independent of numpy."""
    r = random.Random(seed)
    x, out = 0.0, []
    for i in range(n + burn):
        x = phi * x + r.gauss(0, 1)
        if i >= burn:
            out.append(mean + x)
    return out
