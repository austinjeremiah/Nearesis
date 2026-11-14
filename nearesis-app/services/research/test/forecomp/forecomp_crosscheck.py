"""Cross-check of the Python fixed-m WPE, fixed-b Bartlett and dm.test.r.m emulation against CRAN ForeComp 1.0.0 (via Rscript).

Tolerances and inputs are declared in crosscheck-spec.json, which was committed before any comparison was run.
Nothing here imports or alters a frozen file; calibration and Q14 inputs are only regenerated from their recorded seeds."""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
APP = HERE.parents[3]
SPEC = json.loads((HERE / "crosscheck-spec.json").read_text())
TOL = SPEC["tolerances"]
ALPHA = SPEC["alpha"]
R_SCRIPT = HERE / "forecomp_ref.R"
REQUIRED_FORECOMP = "1.0.0"


def rscript_path() -> str | None:
    env = os.environ.get("NEARESIS_RSCRIPT")
    if env and Path(env).exists():
        return env
    local = APP / ".toolchain" / "bin" / "Rscript"
    if local.exists():
        return str(local)
    return shutil.which("Rscript")


def r_availability() -> tuple[bool, str]:
    """(available, reason). NOT_RUN reasons are explicit so a skipped test can never be mistaken for a pass."""
    rs = rscript_path()
    if rs is None:
        return False, "NOT_RUN: Rscript not found (set NEARESIS_RSCRIPT or install the pinned R environment, see services/research/test/forecomp/r-env.yml)"
    try:
        p = subprocess.run([rs, "-e", 'cat(as.character(packageVersion("ForeComp")), as.character(packageVersion("jsonlite")))'], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, f"NOT_RUN: Rscript failed to start ({e})"
    if p.returncode != 0:
        return False, "NOT_RUN: R packages ForeComp and jsonlite are not installed in this R environment"
    got = p.stdout.split()[0]
    if got != REQUIRED_FORECOMP:
        return False, f"NOT_RUN: ForeComp {got} installed, pinned version is {REQUIRED_FORECOMP}"
    return True, "available"


def _py_m(n: int) -> int:
    from nearesis_research import dm_fixed_smoothing as F

    return F.wpe_m(n)


def run_r(series: list[tuple[str, np.ndarray]], workdir: Path | None = None) -> dict[str, dict]:
    rs = rscript_path()
    assert rs
    with tempfile.TemporaryDirectory(dir=workdir) as td:
        inp, out = Path(td) / "in.json", Path(td) / "out.json"
        inp.write_text(json.dumps({"series": [{"id": i, "d": [float(x) for x in d], "m": _py_m(len(d))} for i, d in series]}))
        p = subprocess.run([rs, str(R_SCRIPT), str(inp), str(out)], capture_output=True, text=True, timeout=3000)
        if p.returncode != 0:
            raise RuntimeError(f"Rscript failed: {p.stderr[-2000:]}")
        return {r["id"]: r for r in json.loads(out.read_text())}


def _f(x):
    if x is None:
        return math.nan
    if isinstance(x, str):
        return {"NaN": math.nan, "NA": math.nan, "Inf": math.inf, "-Inf": -math.inf}[x]
    return float(x)


def _rel_ok(a: float, b: float, rel: float, floor: float) -> bool:
    return abs(a - b) <= rel * max(floor, abs(b))


def python_side(d: np.ndarray) -> dict:
    from nearesis_research import amendment2 as A
    from nearesis_research import dm_fixed_smoothing as F

    p = F.wpe_test(d)
    s = F.bartlett_fixed_b_test(d)
    h = bool(A.hln_rm_batch(d[None, :])[0]) if len(d) > 2 else None
    return {"wpe": p, "bt": s, "rm": h}


def compare_one(sid: str, d: np.ndarray, r: dict, py: dict, agg: dict) -> None:
    n = len(d)
    ms = float((d * d).mean())
    cat = agg
    # ---- P: weighted periodogram
    w, pw = r["wpe_pm"], py["wpe"]  # R run with the caller-supplied (mathematically intended) M, see forecomp_ref.R
    rs, rp = _f(w["stat"]), _f(w["pval"])
    if int(r["M_default"]) != pw["m"]:
        dd_ = cat["P"].setdefault("M_default_differs_at_n", {})
        dd_[str(n)] = dd_.get(str(n), 0) + 1
    else:
        cat["P"]["default_M_compared"] = cat["P"].get("default_M_compared", 0) + 1
        dw = r["wpe"]
        if pw["statistic"] is not None and not _rel_ok(pw["statistic"], _f(dw["stat"]), TOL["statisticRel"], TOL["statisticAbsFloor"]):
            cat["P"]["failures"].append({"id": sid, "kind": ["statistic_at_R_default_M"], "py": pw["statistic"], "r": dw["stat"]})
    if pw["statistic"] is None:
        # Python declared the variance degenerate: R's spectral level (independent base-R fft) must be rounding noise, or its statistic non-finite
        rom = _f(r.get("omega_fft"))
        ok = (not math.isfinite(rs)) or (math.isfinite(rom) and rom < 1e-12 * ms)
        rvar = rom
        cat["P"]["degenerate_python"] += 1
        if ok:
            cat["P"]["degenerate_agree"] += 1
        else:
            cat["P"]["failures"].append({"id": sid, "kind": "python_degenerate_but_R_variance_not_noise", "rStat": rs, "rVar": rvar, "meanSq": ms})
    else:
        cat["P"]["compared"] += 1
        ps, pp = pw["statistic"], pw["p_value"]
        ds, dp = abs(ps - rs) / max(TOL["statisticAbsFloor"], abs(rs)), abs(pp - rp)
        cat["P"]["maxStatRel"] = max(cat["P"]["maxStatRel"], ds if math.isfinite(ds) else math.inf)
        cat["P"]["maxPAbs"] = max(cat["P"]["maxPAbs"], dp if math.isfinite(dp) else math.inf)
        bad = []
        if not _rel_ok(ps, rs, TOL["statisticRel"], TOL["statisticAbsFloor"]):
            bad.append("statistic")
        if not dp <= TOL["pValueAbs"]:
            bad.append("pValue")
        if pw["m"] != math.floor(n ** (1 / 3) + 1e-12):
            bad.append("m")
        pr, rr = pp < ALPHA, w["rej"]
        if abs(rp - ALPHA) <= TOL["rejectBoundary"]:
            cat["P"]["boundary"] += 1
        elif pr != rr:
            bad.append("reject")
        cat["P"]["rejectAgree"] += int(pr == rr)
        if bad:
            cat["P"]["failures"].append({"id": sid, "kind": bad, "py": [ps, pp], "r": [rs, rp]})
    # ---- S: fixed-b Bartlett
    b, sb = r["bt"], py["bt"]
    rbs = _f(b["stat"])
    if sb["statistic"] is None:
        mean = float(d.mean())
        rvar = (math.sqrt(n) * mean / rbs) ** 2 if math.isfinite(rbs) and rbs != 0 else math.nan
        ok = (not math.isfinite(rbs)) or (math.isfinite(rvar) and rvar < 1e-12 * ms)
        cat["S"]["degenerate_python"] += 1
        if ok:
            cat["S"]["degenerate_agree"] += 1
        else:
            cat["S"]["failures"].append({"id": sid, "kind": "python_degenerate_but_R_variance_not_noise", "rStat": rbs, "rVar": rvar, "meanSq": ms})
    else:
        cat["S"]["compared"] += 1
        ds = abs(sb["statistic"] - rbs) / max(TOL["statisticAbsFloor"], abs(rbs))
        cat["S"]["maxStatRel"] = max(cat["S"]["maxStatRel"], ds if math.isfinite(ds) else math.inf)
        bad = []
        if not _rel_ok(sb["statistic"], rbs, TOL["statisticRel"], TOL["statisticAbsFloor"]):
            bad.append("statistic")
        mM = min(math.floor(math.sqrt(n) + 1e-12), n)
        rcrit = 1.96 + 2.9694 * (mM / n) + 0.416 * (mM / n) ** 2 - 0.5324 * (mM / n) ** 3  # ForeComp's printed 5% constants, for the critical-value check
        if abs(sb["critical_value"] - rcrit) > TOL["criticalValueAbs"]:
            bad.append("criticalValue")
        if abs(abs(rbs) - rcrit) <= TOL["rejectBoundary"]:
            cat["S"]["boundary"] += 1
        elif sb["reject"] != b["rej"]:
            bad.append("reject")
        cat["S"]["rejectAgree"] += int(sb["reject"] == b["rej"])
        if bad:
            cat["S"]["failures"].append({"id": sid, "kind": bad, "py": [sb["statistic"], sb["reject"]], "r": [rbs, b["rej"]]})
    # ---- H: dm.test.r.m emulation (h = 1), reject indicator
    if py["rm"] is not None:
        rm = r["rm"]
        rrp = _f(rm["pval"])
        if math.isfinite(rrp):
            cat["H"]["compared"] += 1
            if abs(rrp - ALPHA) <= TOL["rejectBoundary"]:
                cat["H"]["boundary"] += 1
            elif py["rm"] != rm["rej"]:
                cat["H"]["failures"].append({"id": sid, "kind": ["reject"], "py": py["rm"], "r": [rm["stat"], rm["pval"], rm["rej"]]})
            cat["H"]["rejectAgree"] += int(py["rm"] == rm["rej"])
        else:
            cat["H"]["r_nonfinite"] += 1


def new_agg() -> dict:
    return {m: {"compared": 0, "rejectAgree": 0, "boundary": 0, "maxStatRel": 0.0, "maxPAbs": 0.0, "degenerate_python": 0, "degenerate_agree": 0, "r_nonfinite": 0, "disagreements": 0, "failures": []} for m in ("P", "S", "H")}


def crosscheck(series: list[tuple[str, np.ndarray]], ref_out: dict | None = None) -> dict:
    ref = run_r(series)
    if ref_out is not None:
        ref_out.update(ref)
    agg = new_agg()
    for sid, d in series:
        compare_one(sid, d, ref[sid], python_side(np.asarray(d, float)), agg)
    agg["n_series"] = len(series)
    agg["forecomp"] = next(iter(ref.values()))["forecomp"] if ref else None
    agg["rversion"] = next(iter(ref.values()))["rversion"] if ref else None
    agg["failureCount"] = sum(len(agg[m]["failures"]) for m in "PSH")
    agg["boundaryCount"] = sum(agg[m]["boundary"] for m in "PSH")
    return agg


# ---- input sets ----

def frozen_vector_series() -> list[tuple[str, np.ndarray]]:
    vec = json.loads((APP / "packages/test-fixtures/research/dm-fixed-smoothing-vectors.json").read_text())
    # cases with non-finite entries are the INVALID_INPUT vectors: ForeComp has no invalid-input state, so they are not comparable
    return [(f"vec:{c['name']}", np.array(c["d"], float)) for c in vec["cases"] if "d" in c and np.isfinite(np.array(c["d"], float)).all()]


def calibration_series(per_cell: int | None) -> list[tuple[str, np.ndarray]]:
    from nearesis_research import amendment2 as A

    params, _ = A.load_amendment()
    cal, dgp = params["calibration"], params["calibration"]["dgp"]
    out, c = [], 0
    for phi in cal["phi"]:
        for n in cal["n"]:
            seeds = A.cell_seeds(cal["seedBase"], cal["seedCellStride"], c, cal["seedsPerCell"])
            if per_cell:
                seeds = seeds[:per_cell]
            out += [(f"cal:phi={phi},n={n}:{s}", A.ar1_series(s, n, phi, dgp["mean"], dgp["sigma"], dgp["burnIn"])) for s in seeds]
            c += 1
    return out


def q14_series() -> list[tuple[str, np.ndarray]]:
    from nearesis_research import accept_cases_g07 as G
    from nearesis_research import amendment2 as A
    from nearesis_research.frozen import extract_params

    ev = json.loads(A.EVAL_FREEZE.read_text())
    pre = (APP / "docs/research/PREREGISTRATION.md").read_text(encoding="utf-8")
    q = extract_params(pre)["q14"]
    ns, ar = q["nullSimulation"], q["ar1Differential"]
    out = [(f"q14:eval:{s}", G._ar1(s, ns["n"], ns["phi"], ns["mean"], ns["sigma"])) for s in ev["nullSeeds"]]
    out.append(("q14:ar1Differential", G._ar1(ar["seed"], ar["n"], ar["phi"], ar["mean"], ar["sigma"])))
    return out


def randomized_series(per_scenario: int = 200) -> list[tuple[str, np.ndarray]]:
    sc = SPEC["inputs"]["randomized"]
    master = sc["masterSeed"]
    ns = (12, 20, 30, 60, 150, 300, 1000)
    kinds = [("ar1-0.5g", -0.5, "n", 0.0), ("ar1-0g", 0.0, "n", 0.0), ("ar1+0.5g", 0.5, "n", 0.0), ("ar1+0.9g", 0.9, "n", 0.0), ("ar1+0.5t3", 0.5, "t", 0.0), ("ar1+0.5drift", 0.5, "n", 0.3)]
    out, idx = [], 0
    for n in ns:
        for name, phi, dist, mean in kinds:
            rng = np.random.default_rng(np.random.SeedSequence([master, idx]))
            for k in range(per_scenario):
                e = rng.standard_normal(n + 100) if dist == "n" else rng.standard_t(3, n + 100)
                x = np.zeros(n + 100)
                for i in range(1, n + 100):
                    x[i] = phi * x[i - 1] + e[i]
                out.append((f"rnd:{name}:n={n}:{k}", mean + x[100:]))
            idx += 1
    return out


def calibration_count_check(ref: dict) -> dict:
    """R rejection counts per calibration cell against the committed calibration record (read-only), P method, alpha 0.05."""
    from nearesis_research import amendment2 as A

    cal = json.loads(A.CALIBRATION.read_text())
    out = {}
    for key, cell in cal["cells"].items():
        rr = [v for k, v in ref.items() if k.startswith(f"cal:{key}:")]
        r_rej = sum(1 for v in rr if v["wpe_pm"]["rej"] is True)
        out[key] = {"series": len(rr), "rRejections": r_rej, "committedRejections": cell["P"]["rejections"], "equal": r_rej == cell["P"]["rejections"]}
    return out


def edge_series() -> list[tuple[str, np.ndarray]]:
    rng = np.random.default_rng(np.random.SeedSequence([SPEC["inputs"]["randomized"]["masterSeed"], 9999]))
    base = rng.standard_normal(60)
    out = [
        ("edge:constant", np.full(40, 0.7)), ("edge:zeros", np.zeros(40)), ("edge:near-constant", 0.7 + 1e-15 * rng.standard_normal(40)),
        ("edge:huge-scale", 1e9 * base), ("edge:tiny-scale", 1e-9 * base), ("edge:level-1e6", 1e6 + base * 0.0 + base), ("edge:alternating", np.tile([1.0, -1.0], 30)),
        ("edge:linear-trend", np.linspace(-1, 1, 60)),
    ]
    for n in (2, 3, 4, 5, 8):
        out.append((f"edge:short-n{n}", rng.standard_normal(n)))
    return out


if __name__ == "__main__":
    import sys

    ok, why = r_availability()
    if not ok:
        raise SystemExit(why)
    full = "--full" in sys.argv
    res = {}
    for name, ser in (("frozenVectors", frozen_vector_series()), ("calibration", calibration_series(None if full else 25)), ("q14Frozen", q14_series()), ("randomized", randomized_series()), ("edge", edge_series())):
        ref_all: dict = {}
        res[name] = crosscheck(ser, ref_all)
        if name == "calibration" and full:
            res["calibrationCounts"] = calibration_count_check(ref_all)
        print(name, res[name]["n_series"], "failures", res[name]["failureCount"], "boundary", res[name]["boundaryCount"], flush=True)
    out = [a for a in sys.argv[1:] if not a.startswith("--")]
    if out:
        Path(out[0]).write_text(json.dumps(res, indent=2, default=str))
