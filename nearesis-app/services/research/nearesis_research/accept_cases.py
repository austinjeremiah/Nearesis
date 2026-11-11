"""Measurements for acceptance tests Q01-Q10. Each case runs the real engine and returns plain measurements; the
TypeScript wrapper (services/research/test/acceptance/Q*.accept.test.ts) asserts the ch.16 PASS conditions on them."""

from __future__ import annotations

import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
from statsmodels.stats.multitest import multipletests

from .artifacts import compare_runs
from .cli import repro_cmd, run_fixture
from .core import json_hash, rng
from .dataset import Inputs, Spec, build_dataset, top_accounts
from .experiment import run_experiment
from .fixtures import INTENTS_ACCOUNTS, KNOWN_LAG, make_fixture
from .inference import benjamini_hochberg
from .leakage import LeakageError, check_leakage
from .narrative import facts_of, render_narrative, verify_narrative
from .prereg import default_prereg, verify_prereg

SEED = 20261111


def _run(kind, pre=None, seed=SEED, n_days=None, daily=None, tamper=None):
    fx = make_fixture(kind, seed) if n_days is None else make_fixture(kind, seed, n_days=n_days)
    pre = pre or default_prereg(seed)
    src = {"label": fx.label, "fixture": kind, "fixtureHash": fx.hash, "reproductionCommand": repro_cmd(kind, seed)}
    inp = Inputs(fx.daily if daily is None else daily, fx.accounts)
    return fx, pre, run_experiment(inp, pre, src, tamper=tamper)


def q01():
    fx, pre, a = _run("signal")
    est = a["estimates"]["byHorizonCandidate"]
    lag = a["falsification"]["lagComparison"]
    best = max(lag, key=lambda k: lag[k]["delta_mae"])
    return {
        "fixtureHash": fx.hash,
        "status": a["status"],
        "knownLag": KNOWN_LAG,
        "bestSingleLagAtH1": int(best),
        "expectedBestLag": KNOWN_LAG - 1,
        "intents": est["1:intents"],
        "combined": est["1:combined"],
        "price": est["1:price"],
        "holdout": {k: a["estimates"]["holdout"].get(k) for k in ("n_origins", "relative_improvement", "p_raw", "pass")},
        "placebo": a["falsification"]["placebo"],
        "minRel": pre["thresholds"]["minRelativeImprovement"],
        "q": pre["fdr"]["q"],
        "unsupportedHorizons": {k: v["fdr_reject"] for k, v in est.items() if not k.startswith("1:")},
    }


def q02():
    fx, pre, a = _run("nosignal")
    est = a["estimates"]["byHorizonCandidate"]
    losses = a["estimates"]["losses"]["development"]
    finite = all(math.isfinite(v["mae_log"]) and v["mae_log"] > 0 for v in losses.values())
    # false-positive control over independent no-signal draws
    statuses = []
    rejects = 0
    for s in range(1, 21):
        _, _, b = _run("nosignal", default_prereg(1000 + s), seed=1000 + s)
        statuses.append(b["status"])
        rejects += sum(1 for r in b["estimates"]["byHorizonCandidate"].values() if r.get("fdr_reject"))
    return {
        "fixtureHash": fx.hash,
        "status": a["status"],
        "metricsFinite": finite,
        "losses": {k: v["mae_log"] for k, v in losses.items()},
        "fdrRejectsMainSeed": sum(1 for r in est.values() if r.get("fdr_reject")),
        "repeatSeeds": 20,
        "repeatSupported": statuses.count("SUPPORTED"),
        "repeatFdrRejects": rejects,
        "holdoutOpened": a["inputSnapshot"]["lockbox"]["opened"],
    }


def q03():
    fx = make_fixture("signal")
    pre = default_prereg(SEED)
    src = {"label": fx.label, "fixtureHash": fx.hash}
    inp = Inputs(fx.daily, fx.accounts)

    def inject(ds):
        s = np.log1p(ds.raw["x"]).shift(-2).reindex(pd.DatetimeIndex(ds.rows["origin"]))
        ds.rows["x_lag2"] = s.to_numpy()  # tomorrow+1's value presented as lag-2 feature

    out = {"fixtureHash": fx.hash}
    try:
        run_experiment(inp, pre, src, tamper=inject)
        out["blocked"] = False
        out["codes"] = []
    except LeakageError as e:
        out["blocked"] = True
        out["codes"] = sorted({f["code"] for f in e.report.findings})
        out["columns"] = sorted({f["column"] for f in e.report.findings})
    clean = check_leakage(build_dataset(inp, Spec(horizon=7), pre["hash"]))
    out["cleanFindings"] = len(clean.findings)
    out["cleanColumnsChecked"] = clean.checked_columns
    overlap = check_leakage(build_dataset(inp, Spec(horizon=7, exclude_intents=False), pre["hash"]))
    out["overlapCodes"] = sorted({f["code"] for f in overlap.findings})
    ds = build_dataset(inp, Spec(horizon=7), pre["hash"])
    ds.manifest["x_lag2"]["lag"] = -2
    out["negativeLagCodes"] = sorted({f["code"] for f in check_leakage(ds).findings})
    return out


def q04():
    fx, pre, a1 = _run("signal")
    _, _, a2 = _run("signal")
    cmp_ = compare_runs(a1, a2)
    _, _, a3 = _run("signal", default_prereg(SEED + 1), seed=SEED + 1)
    with tempfile.TemporaryDirectory() as d:
        env_cmd = [sys.executable, "-I", "-m", "nearesis_research.cli"]
        import os

        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
        env.pop("PYTHONHOME", None)
        r = subprocess.run([sys.executable, "-m", "nearesis_research.cli", "run", "--fixture", "signal", "--seed", str(SEED), "--out", d], env=env, capture_output=True, text=True)
        p = subprocess.run([sys.executable, "-m", "nearesis_research.cli", "reproduce", "--dir", d], env=env, capture_output=True, text=True)
        sub = json.loads(p.stdout) if p.returncode == 0 else {"reproducible": False, "stderr": p.stderr[-300:]}
        wrote_status = r.returncode
    return {
        "fixtureHash": fx.hash,
        "sameSeed": cmp_,
        "hashesEqual": a1["artifactHashes"] == a2["artifactHashes"],
        "tolerance": 1e-9,
        "differentSeedChangesCI": a3["uncertainty"]["deltaMaeCI"] != a1["uncertainty"]["deltaMaeCI"] or a3["inputSnapshot"]["datasetHash"] != a1["inputSnapshot"]["datasetHash"],
        "freshProcessRun": wrote_status,
        "freshProcessReproduce": sub,
        "method": "canonical-JSON sha256 per section plus max abs float diff",
    }


def q05():
    fx = make_fixture("signal")
    pre = default_prereg(SEED)
    inp = Inputs(fx.daily, fx.accounts)
    split = pd.Timestamp(pre["split"]["regimeSplit"])
    res = {"fixtureHash": fx.hash, "regimeSplit": str(split.date()), "byHorizon": {}}
    for h in (1, 7, 14):
        ds = build_dataset(inp, Spec(horizon=h), pre["hash"])
        lock = ds.lockbox.open(pre["hash"])
        res["byHorizon"][str(h)] = {
            "devMaxTarget": str(ds.rows["target_date"].max().date()),
            "lockMaxTarget": str(lock["target_date"].max().date()),
            "devOrLockCrossesSplit": bool((ds.rows["target_date"] >= split).any() or (lock["target_date"] >= split).any()),
            "postMinOrigin": str(ds.post_rows["origin"].min().date()),
            "postBeforeSplit": bool((ds.post_rows["origin"] < split).any()),
            "straddleExcluded": ds.straddle_rows,
            "expectedStraddle": h,
            "regimes": sorted(set(ds.rows["regime"]) | set(ds.post_rows["regime"])),
        }
    _, _, a = _run("signal")
    res["artifactPostWindow"] = a["windows"]["postRegime"]
    res["postCheck"] = a["falsification"]["robustness"]["checks"]["post_oct27_regime"]
    # a long-enough post window is analysed on its own training data only
    _, _, a2 = _run("signal", n_days=560)
    res["postCheckLong"] = a2["falsification"]["robustness"]["checks"]["post_oct27_regime"]
    res["postRowsLong"] = a2["windows"]["postRegime"]["rows"]
    res["minTrain"] = pre["split"]["minTrain"]
    return res


def q06():
    fx = make_fixture("signal")
    pre = default_prereg(SEED)
    acc = fx.accounts
    inp = Inputs(fx.daily, acc)
    ds = build_dataset(inp, Spec(horizon=7, top_pct=1.0), pre["hash"])
    lock = ds.lockbox.open(pre["hash"])
    drop = set(ds.excluded_accounts) | set(INTENTS_ACCOUNTS)
    ind = acc[~acc["account"].isin(drop)].groupby("date")["actions"].sum()
    mism = {}
    for name, rows in (("dev", ds.rows), ("lockbox", lock), ("post", ds.post_rows)):
        exp = np.log1p(ind.reindex(pd.DatetimeIndex(rows["target_date"])).to_numpy())
        mism[name] = {"rows": int(len(rows)), "maxAbsDiff": float(np.max(np.abs(exp - rows["target"].to_numpy())))}
    holdout_start = lock["origin"].min()
    pool = acc[(acc["date"] < holdout_start) & (~acc["account"].isin(INTENTS_ACCOUNTS))]
    tot = pool.groupby("account")["actions"].sum().sort_values(ascending=False)
    expected_k = math.ceil(len(tot) * 0.01)
    independent = sorted(tot.index[:expected_k].tolist())
    # future-period change must not alter the set; development-period change must
    fut = acc.copy()
    fut.loc[(fut["date"] >= holdout_start) & (fut["account"] == "acct0150.near"), "actions"] *= 10_000
    ds_f = build_dataset(Inputs(fx.daily, fut), Spec(horizon=7, top_pct=1.0), pre["hash"])
    dev_mod = acc.copy()
    dev_mod.loc[(dev_mod["date"] < holdout_start) & (dev_mod["account"] == "acct0150.near"), "actions"] *= 10_000
    ds_d = build_dataset(Inputs(fx.daily, dev_mod), Spec(horizon=7, top_pct=1.0), pre["hash"])
    _, _, a = _run("signal")
    res = a["falsification"]["robustness"]["checks"]["top_1pct_accounts_removed"]
    return {
        "fixtureHash": fx.hash,
        "excluded": ds.excluded_accounts,
        "independentExcluded": independent,
        "expectedCount": expected_k,
        "perSplit": mism,
        "excludedAfterFutureChange": ds_f.excluded_accounts,
        "excludedAfterDevChange": ds_d.excluded_accounts,
        "artifactSensitivity": {"status": res["status"], "excluded": res.get("excludedAccounts"), "delta_mae": res.get("delta_mae")},
    }


def q07():
    fx = make_fixture("signal")
    pre = default_prereg(SEED)
    miss_day = pd.Timestamp("2026-03-10")
    daily = fx.daily.copy()
    daily.loc[daily["date"] == miss_day, "price_close"] = np.nan
    ds = build_dataset(Inputs(daily, fx.accounts), Spec(horizon=7), pre["hash"])
    ds_full = build_dataset(Inputs(fx.daily, fx.accounts), Spec(horizon=7), pre["hash"])
    pre_origins = set(ds.rows["origin"]) | set(ds.lockbox._rows["origin"]) | set(ds.post_rows["origin"])
    full_origins = set(ds_full.rows["origin"]) | set(ds_full.lockbox._rows["origin"]) | set(ds_full.post_rows["origin"])
    removed = sorted(str(d.date()) for d in full_origins - pre_origins)
    ret = ds.raw["ret"]
    ydiff = ds.raw["y"].equals(ds_full.raw["y"])
    drops = [d for d in ds.dropped if d["origin"] in removed]
    # volume gap on its own day: NaN, never zero
    dv = fx.daily.copy()
    dv.loc[dv["date"] == miss_day, "intents_volume_usd"] = np.nan
    dsv = build_dataset(Inputs(dv, fx.accounts), Spec(horizon=7), pre["hash"])
    _, _, a = _run("signal", daily=daily)
    return {
        "fixtureHash": fx.hash,
        "retNaNDays": sorted(str(d.date()) for d in ret.index[ret.isna()]),
        "removedOrigins": removed,
        "expectedRemoved": ["2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14"],
        "dropReasonsOnlyPriceCols": all(set(d["reasons"]) <= {"ret_lag1", "ret_lag2", "ret_lag3"} for d in drops),
        "dropsRecorded": len(drops),
        "targetUnchanged": ydiff,
        "volumeNaNisZero": bool(np.log1p(dsv.raw["x"]).loc[miss_day] == 0.0) if not np.isnan(dsv.raw["x"].loc[miss_day]) else False,
        "volumeDayIsNaN": bool(np.isnan(dsv.raw["x"].loc[miss_day])),
        "missingRetIsZeroOrFilled": bool(not np.isnan(ret.loc[miss_day])),
        "experimentStatus": a["status"],
        "reportedDropCount": a["inputSnapshot"]["droppedSamples"]["count"],
        "nullPolicy": a["inputSnapshot"]["droppedSamples"]["protocol"],
    }


def q08():
    pre = default_prereg(SEED)
    fam = pre["family"]
    p = rng(SEED, "q08").uniform(0, 1, 9).tolist()
    mine = benjamini_hochberg(p, 0.05)
    ref = multipletests(p, alpha=0.05, method="fdr_bh")
    nullp = rng(SEED, "q08null").uniform(0, 1, (4000, 9))
    any_rej = sum(1 for row in nullp if any(benjamini_hochberg(row.tolist(), 0.05)["reject"]))
    tampered = {**pre, "family": fam[:3]}
    tampered_verdict = verify_prereg(tampered)
    fx, _, a = _run("signal")
    est = a["estimates"]["fdr"]
    return {
        "fixtureHash": fx.hash,
        "familySize": len(fam),
        "familyDeclaredBeforeRun": bool(verify_prereg(pre)),
        "fdr": pre["fdr"],
        "bhMatchesStatsmodels": bool(np.allclose(mine["adjusted"], ref[1])) and mine["reject"] == ref[0].tolist(),
        "adjustedNeverBelowRaw": all(a_ >= p_ - 1e-15 for a_, p_ in zip(mine["adjusted"], p)),
        "nullFamilyAnyRejectRate": any_rej / len(nullp),
        "tamperedFamilyAccepted": tampered_verdict,
        "artifactFamilyM": est["m"],
        "artifactAdjustedGeRaw": all(
            r["p_adjusted"] >= (r["p_raw"] or 0) - 1e-15 for r in a["estimates"]["byHorizonCandidate"].values() if r.get("p_raw") is not None
        ),
        "verdictAfterFamilyTamper": run_experiment(Inputs(fx.daily, fx.accounts), tampered, {"label": "SYNTHETIC"})["status"],
    }


def q09():
    out = {}
    fx = make_fixture("signal")
    for label, pre, n_days in (
        ("emptyLockbox", default_prereg(SEED, lockbox_days=0), None),
        ("shortLockbox", default_prereg(SEED, lockbox_days=5), None),
        ("tooFewDevOrigins", default_prereg(SEED), 70),
    ):
        _, _, a = _run("signal", pre=pre, n_days=n_days)
        out[label] = {"status": a["status"], "reasons": a["verdict"]["reasons"], "lockboxN": a["inputSnapshot"]["lockbox"]["n"], "devOrigins": a["estimates"]["primary"].get("n_origins")}
    # control: the same signal with a proper holdout is SUPPORTED, so the INSUFFICIENT results are caused by the holdout
    _, _, ok = _run("signal")
    out["control"] = {"status": ok["status"]}
    out["fixtureHash"] = fx.hash
    return out


def q10():
    fx, pre, a = _run("signal")
    facts = facts_of(a)
    text = render_narrative(a)
    ok = verify_narrative(text, facts)
    first_num = next(t for t in ["0.0361", "0.1450", "75.1%"] if t in text)
    bad = text.replace(first_num, "9.9999" if "%" not in first_num else "99.9%", 1)
    bad2 = text + " The effect was 88.8% on holdout."
    return {
        "fixtureHash": fx.hash,
        "narrative": text,
        "facts": facts,
        "verifyOk": ok,
        "tamperedDetected": not verify_narrative(bad, facts)["ok"],
        "tamperedUnmatched": verify_narrative(bad, facts)["unmatched"],
        "extraClaimDetected": not verify_narrative(bad2, facts)["ok"],
        "numericTokens": len(__import__("re").findall(r"-?\d+(?:\.\d+)?%?", text)),
    }


CASES = {f"Q{n:02d}": globals()[f"q{n:02d}"] for n in range(1, 11)}


def main(argv=None) -> int:
    case = (argv or sys.argv[1:])[0]
    print(json.dumps({"testId": case, **CASES[case]()}, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
