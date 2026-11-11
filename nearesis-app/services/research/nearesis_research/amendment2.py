"""Amendment 002 machinery: calibration over the 12 original null scenarios, applicability checks and power, the
mechanical qualification rule, and the evaluation freeze. Reads only the amendment's own frozen block.

Subcommands: `calibrate`, `applicability`, `freeze-eval`. Calibration writes nothing about evaluation seeds; the
evaluation freeze refuses to run unless the primary method qualified."""

from __future__ import annotations

import hashlib
import json
import resource
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy import signal, stats

from . import dm_fixed_smoothing as F
from .amendment import load_amendment as load_amendment1
from .amendment import prior_seeds
from .dm_amended import dm_candidate
from .frozen import APP_ROOT, CANONICALISATION, document_hash, extract_params

DOCS = APP_ROOT / "docs" / "research"
DOC = DOCS / "PREREGISTRATION-AMENDMENT-002.md"
FREEZE = DOCS / "PREREGISTRATION-AMENDMENT-002.freeze.json"
CALIBRATION = DOCS / "PREREGISTRATION-AMENDMENT-002.calibration.json"
APPLICABILITY = DOCS / "PREREGISTRATION-AMENDMENT-002.applicability.json"
EVAL_FREEZE = DOCS / "PREREGISTRATION-AMENDMENT-002.evaluation-freeze.json"
LABEL = F.LABEL


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _json_hash(obj) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def load_amendment() -> tuple[dict, str]:
    text = DOC.read_text(encoding="utf-8")
    rec = json.loads(FREEZE.read_text())
    h = document_hash(text)
    if h != rec["documentHash"]:
        raise RuntimeError("amendment 002 document hash differs from its freeze record")
    return extract_params(text), h


# ---- generators (the null generator is the production Q14 generator, vectorised through the same recurrence) ----

def ar1_series(seed: int, n: int, phi: float, mean: float, sigma: float, burn: int) -> np.ndarray:
    r = np.random.default_rng(seed)
    e = r.normal(0, sigma, n + burn)
    e[0] = 0.0
    x = signal.lfilter([1.0], [1.0, -phi], e)  # x[0] = 0, x[i] = phi x[i-1] + e[i]: identical recurrence to the Q14 generator
    return mean + x[burn:]


def ma_overlap_series(seed: int, n: int, h: int) -> np.ndarray:
    e = np.random.default_rng(seed).normal(0, 1, n + h - 1)
    return np.convolve(e, np.ones(h), mode="valid")


def forecaster_series(seed: int, n: int, phi: float, c: float, burn: int = 100) -> np.ndarray:
    eta = ar1_series(seed, n, phi, 0.0, 1.0, burn)
    u = np.random.default_rng(np.random.SeedSequence([seed, 5])).normal(0, 1, n)
    return np.abs(eta - c * u) - np.abs(eta)


def wilson(k: int, n: int, z: float = 1.959964) -> list[float]:
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return [float(centre - half), float(centre + half)]


def _dist(x: np.ndarray) -> dict:
    x = x[np.isfinite(x)]
    if x.size == 0:
        return {}
    q = np.quantile(x, [0.01, 0.05, 0.5, 0.95, 0.99])
    return {"mean": float(x.mean()), "sd": float(x.std()), "p01": float(q[0]), "p05": float(q[1]), "p50": float(q[2]), "p95": float(q[3]), "p99": float(q[4])}


def hln_rm_batch(X: np.ndarray) -> np.ndarray:
    """ForeComp dm.test.r.m at h = 1 (HLN factor, i.i.d. variance, Student t with n-1 df): reject indicator."""
    n = X.shape[1]
    C = X - X.mean(axis=1, keepdims=True)
    v = (C * C).sum(axis=1) / n / n
    t = X.mean(axis=1) / np.sqrt(v) * np.sqrt((n - 1) / n)
    return 2 * stats.t.sf(np.abs(t), df=n - 1) < F.ALPHA


# ---- one cell, all methods on identical series ----

def run_cell(X: np.ndarray, seeds: list[int], *, true_lrv: float | None, baselines: bool, bootstrap: bool = True) -> dict:
    N, n = X.shape
    out: dict = {"n_series": N, "n": n}
    t0 = time.perf_counter()
    P = F.wpe_batch(X)
    pt = time.perf_counter() - t0
    rejP = np.where(P["ok"], P["p"] < F.ALPHA, False)
    out["P"] = {
        "rejections": int(rejP.sum()), "rate": float(rejP.mean()), "wilson95": wilson(int(rejP.sum()), N),
        "invalid_or_degenerate": int((~P["ok"]).sum()), "m": int(P["m"]), "df": int(P["df"]),
        "critical_value": float(stats.t.ppf(0.975, 2 * P["m"])), "statistic_distribution": _dist(P["t"]),
        "lrv_ratio_est_over_true": None if true_lrv is None else _dist(P["omega"] / true_lrv), "runtime_s": pt,
    }
    t0 = time.perf_counter()
    S = F.bartlett_fixed_b_batch(X)
    st = time.perf_counter() - t0
    rejS = S["reject"]
    out["S"] = {
        "rejections": int(rejS.sum()), "rate": float(rejS.mean()), "wilson95": wilson(int(rejS.sum()), N),
        "invalid_or_degenerate": int((~S["ok"]).sum()), "M": int(S["M"]), "b": float(S["b"]), "critical_value": float(S["crit"]),
        "statistic_distribution": _dist(S["t"]), "lrv_ratio_est_over_true": None if true_lrv is None else _dist(S["lrv"] / true_lrv), "runtime_s": st,
    }
    if bootstrap:
        t0 = time.perf_counter()
        rej = np.zeros(N, bool)
        inval = 0
        ts, crits = np.empty(N), np.empty(N)
        for i in range(N):
            b = F.bootstrap_test(X[i], seeds[i])
            if b["p"] is None:
                inval += 1
                ts[i] = crits[i] = np.nan
            else:
                rej[i] = b["p"] < F.ALPHA
                ts[i], crits[i] = b["t"], b["crit95"] if b["crit95"] is not None else np.nan
        bt = time.perf_counter() - t0
        out["B"] = {
            "rejections": int(rej.sum()), "rate": float(rej.mean()), "wilson95": wilson(int(rej.sum()), N), "invalid_or_degenerate": inval,
            "reps": F.BOOT_REPS, "blockMean": F.boot_lag(n), "statistic_distribution": _dist(ts), "critical_value_distribution": _dist(crits), "runtime_s": bt,
        }
    if baselines:
        p1, _ = load_amendment1()
        cands = {c["id"]: c for c in p1["candidates"]}
        for cid in ("E0", "E8"):
            rej = 0
            for i in range(N):
                pv = dm_candidate(X[i], cands[cid], p1)["p_value"]
                rej += int(pv is not None and pv < F.ALPHA)
            out[cid] = {"rejections": rej, "rate": rej / N, "wilson95": wilson(rej, N)}
        rh = hln_rm_batch(X)
        out["HLN_rm_h1"] = {"rejections": int(rh.sum()), "rate": float(rh.mean()), "wilson95": wilson(int(rh.sum()), N)}
    out["peak_rss_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024)  # macOS reports bytes
    return out


def cell_seeds(base: int, stride: int, c: int, count: int) -> list[int]:
    return list(range(base + stride * c, base + stride * c + count))


def qualification(cells: dict, params: dict, method: str) -> dict:
    cal, rule = params["calibration"], params["selectionRule"]
    primary = f"phi={cal['primaryCell']['phi']},n={cal['primaryCell']['n']}"
    rates = {k: v[method]["rate"] for k, v in cells.items()}
    ok_p = rule["primaryCellSizeBand"][0] <= rates[primary] <= rule["primaryCellSizeBand"][1]
    failing = [k for k, r in rates.items() if k != primary and not (rule["otherCellSizeBand"][0] <= r <= rule["otherCellSizeBand"][1])]
    return {"primaryCellOk": ok_p, "primaryCellRate": rates[primary], "failingOtherCells": failing, "maxAbsDeviation": max(abs(r - params["amendment"]["alpha"]) for r in rates.values()), "qualifies": ok_p and not failing}


def all_seed_sets(params: dict) -> dict[str, set[int]]:
    sets = {}
    cal = params["calibration"]
    sets["calibration"] = {s for c in range(len(cal["phi"]) * len(cal["n"])) for s in cell_seeds(cal["seedBase"], cal["seedCellStride"], c, cal["seedsPerCell"])}
    oc = params["overlapCheck"]
    sets["overlap"] = {s for c in range(len(oc["horizons"]) * len(oc["n"])) for s in cell_seeds(oc["seedBase"], oc["seedCellStride"], c, oc["seedsPerCell"])}
    pr = params["applicabilityProbe"]
    sets["probe"] = {s for c in range(len(pr["phi"]) * len(pr["n"])) for s in cell_seeds(pr["seedBase"], pr["seedCellStride"], c, pr["seedsPerCell"])}
    pa = params["powerA"]
    sets["powerA"] = {s for c in range(len(pa["phi"]) * len(pa["n"]) * len(pa["mu"])) for s in cell_seeds(pa["seedBase"], pa["seedCellStride"], c, pa["seedsPerCell"])}
    pb = params["powerB"]
    sets["powerB"] = {s for c in range(len(pb["c"]) * len(pb["n"])) for s in cell_seeds(pb["seedBase"], pb["seedCellStride"], c, pb["seedsPerCell"])} | {pb["truthSeed"]}
    return sets


def assert_disjoint(params: dict) -> None:
    sets = all_seed_sets(params)
    names = list(sets)
    for i, a in enumerate(names):
        for b in names[i + 1 :]:
            assert not (sets[a] & sets[b]), f"seed sets {a} and {b} overlap"
    prior = prior_seeds()
    p1, _ = load_amendment1()
    c1 = p1["calibration"]
    a1 = {c1["seedBase"] + c1["seedCellStride"] * c + r for c in range(12) for r in range(c1["seedsPerCell"])}
    for name, s in sets.items():
        assert not (s & prior), f"{name} overlaps an original seed"
        assert not (s & a1), f"{name} overlaps amendment 001 calibration seeds"
        assert min(s) > 999_999


def calibrate() -> dict:
    params, h = load_amendment()
    assert_disjoint(params)
    cal, dgp = params["calibration"], params["calibration"]["dgp"]
    cells, c = {}, 0
    for phi in cal["phi"]:
        for n in cal["n"]:
            seeds = cell_seeds(cal["seedBase"], cal["seedCellStride"], c, cal["seedsPerCell"])
            X = np.stack([ar1_series(s, n, phi, dgp["mean"], dgp["sigma"], dgp["burnIn"]) for s in seeds])
            key = f"phi={phi},n={n}"
            cells[key] = run_cell(X, seeds, true_lrv=dgp["sigma"] ** 2 / (1 - phi) ** 2, baselines=True)
            cells[key].update(phi=phi, seedFirst=seeds[0], seedLast=seeds[-1])
            print(key, {m: cells[key][m]["rate"] for m in ("P", "S", "B", "E0", "E8", "HLN_rm_h1")}, flush=True)
            c += 1
    quals = {m: qualification(cells, params, m) for m in ("P", "S", "B")}
    result = {
        "schema": "preregistration-amendment-calibration@2", "label": LABEL, "amendmentDocumentHash": h, "methodVersion": F.METHOD_VERSION,
        "calibratedAt": _now(), "seedsPerCell": cal["seedsPerCell"], "cells": cells, "qualification": quals,
        "certifiedMethod": "P", "qualified": bool(quals["P"]["qualifies"]),
        "outcome": "primary_qualified" if quals["P"]["qualifies"] else params["selectionRule"]["noQualifierOutcome"],
        "sensitivityValidated": {"S": bool(quals["S"]["qualifies"]), "B": bool(quals["B"]["qualifies"])},
        "amendment001Reference": params["amendment"]["amendment001"]["calibrationResultHash"],
    }

    def strip(o):
        if isinstance(o, dict):
            return {k: strip(v) for k, v in o.items() if k not in ("runtime_s", "peak_rss_mb")}
        return o

    result["resultHash"] = _json_hash(strip({k: v for k, v in result.items() if k not in ("calibratedAt", "resultHash")}))
    CALIBRATION.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return result


def applicability() -> dict:
    params, h = load_amendment()
    assert_disjoint(params)
    out: dict = {"schema": "preregistration-amendment-applicability@2", "label": LABEL, "amendmentDocumentHash": h, "ranAt": _now()}
    oc = params["overlapCheck"]
    ov, c = {}, 0
    for hz in oc["horizons"]:
        for n in oc["n"]:
            seeds = cell_seeds(oc["seedBase"], oc["seedCellStride"], c, oc["seedsPerCell"])
            X = np.stack([ma_overlap_series(s, n, hz) for s in seeds])
            r = run_cell(X, seeds, true_lrv=float(hz * hz), baselines=False)
            r["eligible"] = bool(oc["band"][0] <= r["P"]["rate"] <= oc["band"][1])
            ov[f"h={hz},n={n}"] = r
            print("overlap", hz, n, r["P"]["rate"], r["S"]["rate"], r["B"]["rate"], flush=True)
            c += 1
    out["overlapCheck"] = ov
    pr, pc, probes = params["applicabilityProbe"], 0, {}
    dgp = params["calibration"]["dgp"]
    for phi in pr["phi"]:
        for n in pr["n"]:
            seeds = cell_seeds(pr["seedBase"], pr["seedCellStride"], pc, pr["seedsPerCell"])
            X = np.stack([ar1_series(s, n, phi, 0.0, 1.0, dgp["burnIn"]) for s in seeds])
            probes[f"phi={phi},n={n}"] = run_cell(X, seeds, true_lrv=1 / (1 - phi) ** 2, baselines=False)
            print("probe", phi, n, probes[f"phi={phi},n={n}"]["P"]["rate"], flush=True)
            pc += 1
    out["applicabilityProbe"] = probes
    pa, c, powA = params["powerA"], 0, {}
    for phi in pa["phi"]:
        for n in pa["n"]:
            for mu, lab in zip(pa["mu"], pa["labels"]):
                seeds = cell_seeds(pa["seedBase"], pa["seedCellStride"], c, pa["seedsPerCell"])
                X = np.stack([ar1_series(s, n, phi, mu, 1.0, dgp["burnIn"]) for s in seeds])
                r = run_cell(X, seeds, true_lrv=1 / (1 - phi) ** 2, baselines=False)
                dbar = X.mean(axis=1)
                r.update(trueMeanDifference=mu, signal=lab, estimatedMeanDifference={"mean": float(dbar.mean()), "p025": float(np.quantile(dbar, 0.025)), "p975": float(np.quantile(dbar, 0.975))})
                powA[f"phi={phi},n={n},signal={lab}"] = r
                print("powerA", phi, n, lab, r["P"]["rate"], r["S"]["rate"], r["B"]["rate"], flush=True)
                c += 1
    out["powerA"] = powA
    pb, c, powB = params["powerB"], 0, {}
    for cc, lab in zip(pb["c"], pb["labels"]):
        truth = float(forecaster_series(pb["truthSeed"], pb["truthDraws"], pb["phiEtaA"], cc).mean())
        for n in params["powerB"]["n"]:
            seeds = cell_seeds(pb["seedBase"], pb["seedCellStride"], c, pb["seedsPerCell"])
            X = np.stack([forecaster_series(s, n, pb["phiEtaA"], cc) for s in seeds])
            r = run_cell(X, seeds, true_lrv=None, baselines=False)
            dbar = X.mean(axis=1)
            r.update(trueMeanDifference=truth, signal=lab, c=cc, estimatedMeanDifference={"mean": float(dbar.mean()), "p025": float(np.quantile(dbar, 0.025)), "p975": float(np.quantile(dbar, 0.975))})
            powB[f"c={cc},n={n},signal={lab}"] = r
            print("powerB", cc, n, lab, r["P"]["rate"], r["S"]["rate"], r["B"]["rate"], flush=True)
            c += 1
    out["powerB"] = powB
    big = [v for k, v in {**powA, **powB}.items() if "n=300" in k and "signal=strong" in k]
    out["powerInadequate"] = bool(any(v["P"]["rate"] < 0.05 for v in big))
    out["overlapEligible"] = {k: v["eligible"] for k, v in ov.items()}

    def strip(o):
        if isinstance(o, dict):
            return {k: strip(v) for k, v in o.items() if k not in ("runtime_s", "peak_rss_mb")}
        return o

    out["resultHash"] = _json_hash(strip({k: v for k, v in out.items() if k not in ("ranAt", "resultHash")}))
    APPLICABILITY.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")
    return out


def calibration_summary() -> dict | None:
    """Machine-readable calibration reference attached to every comparison artifact. None if amendment 002 was not calibrated."""
    if not CALIBRATION.exists():
        return None
    cal = json.loads(CALIBRATION.read_text())
    ov = json.loads(APPLICABILITY.read_text()).get("overlapEligible", {}) if APPLICABILITY.exists() else {}
    return {"qualified": bool(cal["qualified"]), "outcome": cal["outcome"], "resultHash": cal["resultHash"], "amendmentDocumentHash": cal["amendmentDocumentHash"], "overlapEligible": ov, "sensitivityValidated": cal.get("sensitivityValidated", {})}


def derive_eval_seeds(amend_hash: str, cal_hash: str, params: dict, excluded: set[int]) -> list[int]:
    es = params["evaluationSeeds"]
    seeds, taken = [], set(excluded)
    for i in range(es["count"]):
        k = 0
        while True:
            msg = f"{amend_hash}|{cal_hash}|{i}" + (f"|{k}" if k else "")
            v = int.from_bytes(hashlib.sha256(msg.encode("ascii")).digest()[:4], "big")
            s = es["base"] + v % es["modulus"]
            if s not in taken:
                break
            k += 1
        seeds.append(s)
        taken.add(s)
    return seeds


def freeze_eval() -> dict:
    if EVAL_FREEZE.exists():
        raise RuntimeError("evaluation freeze already exists; never re-frozen")
    params, h = load_amendment()
    cal = json.loads(CALIBRATION.read_text())
    if not cal["qualified"]:
        raise RuntimeError("primary method did not qualify: Q14 remains FAIL; no evaluation seeds are drawn")
    if cal["amendmentDocumentHash"] != h:
        raise RuntimeError("calibration result does not belong to this amendment")
    excluded = set(prior_seeds())
    for s in all_seed_sets(params).values():
        excluded |= s
    p1, _ = load_amendment1()
    c1 = p1["calibration"]
    excluded |= {c1["seedBase"] + c1["seedCellStride"] * c + r for c in range(12) for r in range(c1["seedsPerCell"])}
    seeds = derive_eval_seeds(h, cal["resultHash"], params, excluded)
    body = {"schema": "preregistration-amendment-evaluation-freeze@2", "label": LABEL, "amendmentDocumentHash": h, "calibrationResultHash": cal["resultHash"], "methodVersion": F.METHOD_VERSION, "nullSeeds": seeds, "band": params["amendment"]["bandUnchanged"], "alpha": params["amendment"]["alpha"], "canonicalisation": CANONICALISATION}
    rec = {**body, "frozenAt": _now(), "freezeHash": _json_hash(body)}
    EVAL_FREEZE.write_text(json.dumps(rec, indent=2, sort_keys=True) + "\n")
    return rec


if __name__ == "__main__":
    cmd = sys.argv[1:]
    if cmd == ["calibrate"]:
        r = calibrate()
        print(json.dumps({"qualified": r["qualified"], "outcome": r["outcome"], "hash": r["resultHash"], "S": r["sensitivityValidated"]["S"], "B": r["sensitivityValidated"]["B"]}))
    elif cmd == ["applicability"]:
        r = applicability()
        print(json.dumps({"hash": r["resultHash"], "overlapEligible": r["overlapEligible"], "powerInadequate": r["powerInadequate"]}))
    elif cmd == ["freeze-eval"]:
        r = freeze_eval()
        print(json.dumps({"freezeHash": r["freezeHash"], "frozenAt": r["frozenAt"], "seeds": len(r["nullSeeds"])}))
    else:
        raise SystemExit("usage: amendment2 calibrate | applicability | freeze-eval")
