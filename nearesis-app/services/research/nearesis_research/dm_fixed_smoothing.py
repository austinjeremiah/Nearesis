"""Fixed-smoothing forecast comparison (preregistration amendment 002, post_hoc_methodological_correction).

Primary P: Coroneo and Iacone (2020) weighted-periodogram long-run variance with the Daniell kernel, m = floor(n^(1/3)),
statistic referred to Student t with 2m degrees of freedom (fixed-m asymptotics, eqs. 7 to 9).
Secondary S (sensitivity only): Kiefer and Vogelsang (2005) fixed-b Bartlett test, M = floor(n^(1/2)), cubic quantile
approximation of the fixed-b limit. Robustness B (sensitivity only): null-centred studentised stationary block bootstrap.

Sign convention: d = L(base) - L(candidate), positive favours the candidate. Nothing here chooses a method by its p-value.
All parameters come from `docs/research/PREREGISTRATION-AMENDMENT-002.md`'s frozen block (see `amendment2.py`)."""

from __future__ import annotations

import math

import numpy as np
from scipy import stats

LABEL = "post_hoc_methodological_correction"
METHOD_VERSION = "fixed-smoothing-dm/1.0.0"
KV_COEF_0975 = (1.9600, 2.9694, 0.4160, -0.5324)  # Coroneo and Iacone (2020) Sec. 4.1, from Kiefer and Vogelsang (2005)
MIN_ORIGINS = 20
MIN_CALIBRATED_N = 60
BOOT_REPS = 499
ALPHA = 0.05
DEGENERATE_REL = 1e-20  # a variance estimate below this fraction of mean(d^2) is rounding noise: DEGENERATE_VARIANCE

VALID = "VALID"
INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
METHOD_NOT_VALIDATED = "METHOD_NOT_VALIDATED"
DEGENERATE_VARIANCE = "DEGENERATE_VARIANCE"
INVALID_INPUT = "INVALID_INPUT"


def wpe_m(n: int) -> int:
    return max(1, int(math.floor(n ** (1 / 3) + 1e-12)))


def bartlett_M(n: int) -> int:
    return max(1, int(math.floor(math.sqrt(n) + 1e-12)))


def boot_lag(n: int) -> int:
    return max(2, int(math.floor(n ** (1 / 3) + 1e-12)))


def kv_critical_975(b: float) -> float:
    a0, a1, a2, a3 = KV_COEF_0975
    return a0 + a1 * b + a2 * b**2 + a3 * b**3


# ---- batch kernels (rows are independent series); the scalar API calls these with one row ----

def wpe_batch(X: np.ndarray) -> dict:
    """Statistic and p-value of the WPE fixed-m test for each row of X (N, n)."""
    X = np.atleast_2d(np.asarray(X, float))
    n = X.shape[1]
    m = wpe_m(n)
    F = np.fft.fft(X, axis=1)[:, 1 : m + 1]  # sum_t d_t exp(-i lambda_j t) up to a unit phase; modulus is what matters
    omega = (np.abs(F) ** 2).sum(axis=1) / (n * m)  # (2 pi / m) sum_j I(lambda_j), I = |F|^2 / (2 pi n)
    mean = X.mean(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        t = np.sqrt(n) * mean / np.sqrt(omega)
    ok = omega > DEGENERATE_REL * (X * X).mean(axis=1)  # relative rule: constant series leave only rounding noise
    ok &= omega > 0
    t = np.where(ok, t, np.nan)
    p = 2 * stats.t.sf(np.abs(t), df=2 * m)
    return {"t": t, "p": p, "omega": omega, "m": m, "df": 2 * m, "mean": mean, "ok": ok}


def bartlett_lrv_batch(X: np.ndarray, M: int) -> np.ndarray:
    """gamma_0 + 2 sum_{k=1..M-1} (1 - k/M) gamma_k on the centred rows (biased autocovariances, divisor n)."""
    X = np.atleast_2d(np.asarray(X, float))
    n = X.shape[1]
    C = X - X.mean(axis=1, keepdims=True)
    v = (C * C).sum(axis=1) / n
    for k in range(1, min(M, n)):
        v = v + 2 * (1 - k / M) * (C[:, k:] * C[:, : n - k]).sum(axis=1) / n
    return v


def bartlett_fixed_b_batch(X: np.ndarray) -> dict:
    X = np.atleast_2d(np.asarray(X, float))
    n = X.shape[1]
    M = min(bartlett_M(n), n)
    b = M / n
    crit = kv_critical_975(b)
    lrv = bartlett_lrv_batch(X, M)
    mean = X.mean(axis=1)
    ok = lrv > DEGENERATE_REL * (X * X).mean(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        t = np.where(ok, mean / np.sqrt(np.where(ok, lrv, 1.0) / n), np.nan)
    return {"t": t, "reject": np.where(ok, np.abs(t) > crit, False), "lrv": lrv, "M": M, "b": b, "crit": crit, "ok": ok}


def stationary_bootstrap_indices(rng: np.random.Generator, n: int, reps: int, mean_block: int) -> np.ndarray:
    """Politis and Romano (1994) stationary bootstrap: circular blocks with geometric lengths of mean `mean_block`."""
    p = 1.0 / mean_block
    restart = rng.random((reps, n)) < p
    restart[:, 0] = True
    starts = rng.integers(0, n, size=(reps, n))
    pos = np.arange(n)
    last = np.maximum.accumulate(np.where(restart, pos, 0), axis=1)
    base = np.take_along_axis(starts, last, axis=1)
    return (base + pos - last) % n


def bootstrap_test(d: np.ndarray, seed: int, reps: int = BOOT_REPS) -> dict:
    d = np.asarray(d, float)
    n = len(d)
    M0 = boot_lag(n)
    lrv = bartlett_lrv_batch(d[None, :], M0)[0]
    if not lrv > 1e-300:
        return {"t": None, "p": None, "M0": M0, "reps": reps, "blockMean": boot_lag(n)}
    t = float(d.mean() / math.sqrt(lrv / n))
    rng = np.random.default_rng(np.random.SeedSequence([int(seed), 2]))
    idx = stationary_bootstrap_indices(rng, n, reps, boot_lag(n))
    Db = d[idx]
    lrv_b = bartlett_lrv_batch(Db, M0)
    with np.errstate(divide="ignore", invalid="ignore"):
        tb = (Db.mean(axis=1) - d.mean()) / np.sqrt(lrv_b / n)
    exceed = ~(np.abs(tb) < abs(t))  # NaN (degenerate resample) counts as exceeding: conservative
    fin = np.abs(tb[np.isfinite(tb)])
    crit = float(np.quantile(fin, 0.95)) if fin.size else None
    return {"t": t, "p": float((1 + exceed.sum()) / (1 + reps)), "M0": M0, "reps": reps, "blockMean": boot_lag(n), "crit95": crit}


# ---- scalar API ----

def acf_diagnostics(d: np.ndarray, lags: int = 3) -> dict:
    d = np.asarray(d, float)
    c = d - d.mean()
    den = float(c @ c)
    out = {f"acf{k}": (float(c[k:] @ c[:-k]) / den if den > 0 and len(c) > k else None) for k in range(1, lags + 1)}
    return out


def wpe_test(d) -> dict:
    d = np.asarray(d, float)
    r = wpe_batch(d[None, :])
    if not bool(r["ok"][0]):
        return {"statistic": None, "p_value": None, "m": int(r["m"]), "df": int(r["df"]), "omega": float(r["omega"][0])}
    return {"statistic": float(r["t"][0]), "p_value": float(r["p"][0]), "m": int(r["m"]), "df": int(r["df"]), "omega": float(r["omega"][0])}


def bartlett_fixed_b_test(d) -> dict:
    d = np.asarray(d, float)
    r = bartlett_fixed_b_batch(d[None, :])
    if not bool(r["ok"][0]):
        return {"statistic": None, "reject": None, "M": int(r["M"]), "b": float(r["b"]), "critical_value": float(r["crit"]), "lrv": float(r["lrv"][0])}
    return {"statistic": float(r["t"][0]), "reject": bool(r["reject"][0]), "M": int(r["M"]), "b": float(r["b"]), "critical_value": float(r["crit"]), "lrv": float(r["lrv"][0])}


def nested_policy(base: str, cand: str) -> bool:
    """True when the pair is nested (or unknown, treated as nested). Classification fixed in amendment 002 section 3."""
    ridge = {"baseline", "intents", "price", "combined"}
    contains = {("baseline", "intents"), ("baseline", "price"), ("baseline", "combined"), ("intents", "combined"), ("price", "combined")}
    if base in ridge and cand in ridge:
        return (base, cand) in contains or (cand, base) in contains
    benchmarks_nested_in_ridge = {"naive_last"}
    benchmarks_not_nested = {"seasonal_naive", "moving_avg_7"}
    pair = {base, cand}
    for a, b in ((base, cand), (cand, base)):
        if a in benchmarks_nested_in_ridge and b in ridge:
            return True
        if a in benchmarks_not_nested and b in ridge:
            return False
    if pair <= (benchmarks_nested_in_ridge | benchmarks_not_nested):
        return False
    return True


def clark_west(e_base, e_cand, yhat_base, yhat_cand) -> dict:
    """Exploratory Clark and West (2007) adjusted-MSPE statistic (one-sided, positive favours the larger candidate model),
    with the WPE variance. Not calibrated by amendment 002: never a significance claim."""
    e0, e1 = np.asarray(e_base, float), np.asarray(e_cand, float)
    adj = e0**2 - (e1**2 - (np.asarray(yhat_base, float) - np.asarray(yhat_cand, float)) ** 2)
    r = wpe_test(adj)
    p = None if r["statistic"] is None else float(stats.t.sf(r["statistic"], df=r["df"]))
    return {"statistic": r["statistic"], "p_one_sided": p, "status": "exploratory_only", "n": len(adj)}


def compare_paired(
    d,
    *,
    horizon: int = 1,
    nested: bool = False,
    calibration: dict | None = None,
    seed: int = 0,
    with_bootstrap: bool = True,
) -> dict:
    """Full amended comparison of one loss differential. `calibration` is the machine-readable calibration summary
    (`amendment2.calibration_summary()`); without it the method is treated as not calibrated.

    Returns the structured inference record. `significance_claim_allowed` is true only for status VALID with the primary
    method rejecting; it is never derived from S or B."""
    arr = np.asarray(d, float) if d is not None else np.array([])
    n = int(arr.size)
    base = {
        "method": {"id": "wpe_fixed_m_daniell", "version": METHOD_VERSION, "label": LABEL, "role": "primary"},
        "sensitivity_methods": [],
        "n_origins": n,
        "horizon": horizon,
        "nested": nested,
        "sign_convention": "d = loss(base) - loss(candidate); positive favours candidate",
        "alpha": ALPHA,
        "sided": "two",
        "assumptions": ["stationary loss differential", "finite long-run variance", "no model estimation uncertainty in d (non-nested comparison)"],
        "calibration_reference": None if calibration is None else {"qualified": calibration.get("qualified"), "resultHash": calibration.get("resultHash"), "amendmentDocumentHash": calibration.get("amendmentDocumentHash")},
        "limitations": [],
        "significance_claim_allowed": False,
    }
    if n == 0 or not np.all(np.isfinite(arr)) or arr.ndim != 1:
        return {**base, "status": INVALID_INPUT, "mean_diff": None, "statistic": None, "p_value": None, "reason": "empty, non-finite or non-1-d loss differential"}
    base["mean_diff"] = float(arr.mean())
    base["autocorrelation"] = acf_diagnostics(arr)
    base["effective_sample"] = {"n_origins": n, "note": "overlapping horizons reduce information" if horizon > 1 else "horizon 1"}
    if n < MIN_ORIGINS:
        return {**base, "status": INSUFFICIENT_DATA, "statistic": None, "p_value": None, "reason": f"{n} origins; frozen minimum is {MIN_ORIGINS}"}
    if float(np.ptp(arr)) == 0.0:
        return {**base, "status": DEGENERATE_VARIANCE, "statistic": None, "p_value": None, "reason": "constant loss differential"}
    p = wpe_test(arr)
    base["m"] = p["m"]
    base["df"] = p["df"]
    base["statistic"] = p["statistic"]
    base["p_value"] = p["p_value"]
    if p["statistic"] is None:
        return {**base, "status": DEGENERATE_VARIANCE, "reason": "non-positive long-run variance estimate"}
    s = bartlett_fixed_b_test(arr)
    sens = [{"id": "bartlett_fixed_b", "role": "sensitivity_only", "statistic": s["statistic"], "reject": s["reject"], "M": s["M"], "b": s["b"], "critical_value": s["critical_value"], "p_value": None}]
    if with_bootstrap:
        b = bootstrap_test(arr, seed)
        sens.append({"id": "stationary_bootstrap_studentised", "role": "sensitivity_only", "statistic": b["t"], "p_value": b["p"], "reject": None if b["p"] is None else bool(b["p"] < ALPHA), "reps": b["reps"], "blockMean": b["blockMean"]})
    base["sensitivity_methods"] = sens
    rej_p = bool(p["p_value"] < ALPHA)
    others = [x["reject"] for x in sens if x["reject"] is not None]
    base["agreement"] = "not_available" if not others else ("agree" if all(o == rej_p for o in others) else "disagree")
    # eligibility
    reason = None
    status = VALID
    qualified = bool(calibration and calibration.get("qualified"))
    if nested:
        status, reason = METHOD_NOT_VALIDATED, "nested models: ordinary DM inference is not valid under the null; Clark and West is exploratory only"
    elif not qualified:
        status, reason = METHOD_NOT_VALIDATED, "the fixed-m comparison method did not qualify in calibration (or no calibration is attached)"
    elif n < MIN_CALIBRATED_N:
        status, reason = METHOD_NOT_VALIDATED, f"{n} origins is below the smallest calibrated sample size {MIN_CALIBRATED_N}"
    elif horizon != 1:
        ok_h = (calibration.get("overlapEligible") or {}).get(f"h={horizon},n={150 if n < 300 else 300}") if horizon in (7, 14) and n >= 150 else False
        if not ok_h:
            status, reason = METHOD_NOT_VALIDATED, "multistep overlap size check not passed for this horizon and sample size"
    base["status"] = status
    if reason:
        base["reason"] = reason
        base["limitations"].append(reason)
    if horizon > 1:
        base["limitations"].append("overlapping multistep forecast errors: serial dependence of the loss differential beyond horizon 1")
    base["limitations"].append("amendment 002 is a post-hoc methodological correction; not pre_registered strength")
    base["significance_claim_allowed"] = bool(status == VALID and rej_p)
    return base


def conclusion_state(inference: dict) -> dict:
    """The four distinct conclusions the UI and the agents must keep apart. Observed lower error is never significance."""
    md = inference.get("mean_diff")
    observed = None if md is None else bool(md > 0)
    st = inference.get("status")
    if st == VALID and inference.get("significance_claim_allowed"):
        state = "evidence_supports_difference"
    elif st == VALID:
        state = "insufficient_to_distinguish"
    elif st in (INSUFFICIENT_DATA, DEGENERATE_VARIANCE):
        state = "insufficient_to_distinguish"
    elif st == METHOD_NOT_VALIDATED:
        state = "comparison_method_not_validated"
    else:
        state = "comparison_invalid_input"
    return {"state": state, "observed_candidate_lower_error": observed, "statistically_meaningful_difference": state == "evidence_supports_difference", "causal_claim": "excluded"}
