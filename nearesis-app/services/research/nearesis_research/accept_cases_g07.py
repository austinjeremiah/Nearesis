"""Measurements for acceptance tests Q11-Q22 (ch.16b). Every case loads the frozen preregistration through
`nearesis_research.frozen`; no case supplies a threshold, seed, band or rule itself. The TypeScript wrappers assert the
ch.16b PASS conditions on what is measured here."""

from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unicodedata
import uuid
from fractions import Fraction
from pathlib import Path

import numpy as np
import pandas as pd

from .adversarial import branch_inputs, run_protocol, _h
from .core import json_hash, rng
from .dataset import HoldoutAccessError, Inputs, LockboxError, Spec, build_dataset
from .experiment import run_experiment
from .fixtures import make_fixture
from .frozen import APP_ROOT, DOC_PATH, FREEZE_PATH, FreezeViolation, FrozenParameterMissing, canonical_bytes, document_hash, load_frozen
from .inference import bias, block_bootstrap_ci, dm_paired, mae, paired_comparison, smape
from .lockbox_protocol import HoldoutProtocol, SecondEvaluationRefused
from .manifest import (build_manifest, chart_vectors, environment_record, first_difference, thesis_cells, validate_manifest, verify_file_hashes)
from .models import AccessRecorder
from .negative_controls import leaky_scaler_rolling_origin
from .overlap import make_overlap_fixture, run_claim
from .prereg import default_prereg
from .publication import publishable
from .registration import manifest_of, run_bound_experiment
from .robustness import MatrixConfigInvalid, apply_sign_flip_rule, run_matrix
from .rolling import EvaluationRefused, evaluate_rolling_origin, spec_from_frozen
from .targets import build_targets, combined_average, per_target_results, series_hash
from .thesis import generate_thesis, validate_thesis
from .verdict import DEFAULTS, VerdictTampered, conformance, grade, ingest_model_text, seal, spike_check, verify_sealed

SEED = 20261111
FIXTURES = APP_ROOT / "packages" / "test-fixtures" / "research"
sys.path.insert(0, str(APP_ROOT / "tests" / "python" / "research"))


def _alt(frozen_text_from: str, to: str, audit_dir: Path | None = None, count: int = 1):
    text = DOC_PATH.read_text(encoding="utf-8")
    assert text.count(frozen_text_from) >= 1, frozen_text_from
    return load_frozen(doc_text=text.replace(frozen_text_from, to, count), audit_dir=audit_dir or Path(tempfile.mkdtemp(prefix="g07-audit-")))


def _frozen_meta(f) -> dict:
    return {"intact": f.intact, "documentHash": f.doc_hash, "frozenAt": f.record["frozenAt"], "firstResultAt": f.first_result_at(), "violations": f.violations}


def q11():
    f = load_frozen()
    q = f.get("q11")
    fx = make_fixture("signal", SEED, n_days=q["fixtureDays"])
    inputs = Inputs(fx.daily, fx.accounts)
    rec = AccessRecorder()
    res = evaluate_rolling_origin(inputs, f, recorder=rec)
    n, h, lock, mt = q["fixtureDays"], q["horizon"], f.get("experiment.lockboxDays"), q["minTrainingLength"]
    first = max(max(q["lagGrid"]), 6, 4)  # deepest feature lookback: lag grid, 7-day mean / 6-day lag, price return lag 3 + 1
    last = n - 1 - h
    lock_first = last - (lock - 1)
    dev_rows = (lock_first - h) - first + 1
    recount = dev_rows - (mt + h - 1)
    ends_before_split = (pd.Timestamp(fx.daily["date"].max()) + pd.Timedelta(days=h)) < pd.Timestamp(f.get("experiment.regimeSplit"))
    # negative control: scaler fitted on the full series
    ds = build_dataset(inputs, spec_from_frozen(f), f.doc_hash)
    leak_rec = AccessRecorder()
    leaky_scaler_rolling_origin(ds, tuple(q["models"].values()), mt, leak_rec)
    # random k-fold through the public interface
    try:
        evaluate_rolling_origin(inputs, f, scheme="kfold")
        kfold = {"refused": False}
    except EvaluationRefused as e:
        kfold = {"refused": True, **e.to_dict()}
    # a short fixture: fewer valid origins than the frozen minimum
    short = make_fixture("signal", SEED, n_days=q["shortFixtureDays"])
    short_res = evaluate_rolling_origin(Inputs(short.daily, short.accounts), f)
    # frozen file edited / missing: refused
    refusals = {}
    for label, alt in (("editedAfterFreeze", _alt('"minValidOrigins": 60', '"minValidOrigins": 5')), ("missingParameter", _alt('"minTrainingLength": 60,', ""))):
        try:
            evaluate_rolling_origin(inputs, alt)
            refusals[label] = {"refused": False}
        except FreezeViolation as e:
            refusals[label] = {"refused": True, "violations": e.violations}
    return {
        "fixtureHash": fx.hash,
        "frozen": _frozen_meta(f),
        "validOrigins": res["validOrigins"],
        "recountedOrigins": recount,
        "recountInputs": {"days": n, "horizon": h, "minTraining": mt, "firstOriginIndex": first, "devRows": dev_rows, "lockboxDays": lock, "fixtureEndsBeforeRegimeSplit": bool(ends_before_split)},
        "status": res["status"],
        "chronological": res["strictlyChronologicalNonOverlappingTargets"],
        "fitCalls": res["fitCalls"],
        "violations": len(res["violations"]),
        "accessLogSample": rec.log[:2] + rec.log[-2:],
        "negativeControl": {"fitCalls": len(leak_rec.log), "violations": len(leak_rec.violations()), "firstViolation": (leak_rec.violations() or [None])[0]},
        "kfold": kfold,
        "short": {"status": short_res["status"], "validOrigins": short_res["validOrigins"], "minValidOrigins": short_res["minValidOrigins"]},
        "refusals": refusals,
        "frozenValuesUsed": {"horizon": h, "lagGrid": q["lagGrid"], "minTrainingLength": mt, "minValidOrigins": q["minValidOrigins"]},
    }


def _golden():
    return json.loads((FIXTURES / "targets-labelled" / "golden.json").read_text())


def q12():
    f = load_frozen()
    rows = pd.read_csv(FIXTURES / "targets-labelled" / "rows.csv", parse_dates=["date"], keep_default_na=False, na_values=[""])
    rows["app"] = rows["app"].where(rows["app"] != "", None)
    golden = _golden()
    tol = f.get("q12.tolerance")
    out = build_targets(rows, f)
    mism = []
    hashes = {}
    for key, g in golden["series"].items():
        got = out[key]
        hashes[key] = series_hash(got)
        gr = np.array([np.nan if v is None else v for v in g["raw"]], float)
        gl = np.array([np.nan if v is None else v for v in g["log1p"]], float)
        raw_ok = bool(np.array_equal(np.nan_to_num(gr, nan=-1), np.nan_to_num(got["raw"].to_numpy(), nan=-1)))  # counts: exact
        log_ok = bool(np.allclose(gl, got["log1p"].to_numpy(), rtol=0, atol=tol, equal_nan=True))
        if not (raw_ok and log_ok):
            mism.append(key)
    fam_h = sorted({k.rsplit("|", 1)[0] for k in out})
    distinct = {k: bool(not np.array_equal(np.nan_to_num(out[f"{k}|organic"]["raw"].to_numpy(), nan=-1), np.nan_to_num(out[f"{k}|unadjusted"]["raw"].to_numpy(), nan=-1))) for k in fam_h}
    results = per_target_results(rows, f)
    comb = combined_average(results, f)
    # (e) target at t uses only data defined for t+h: rows after t+h are perturbed; the value at t must not move
    dates = pd.date_range(rows["date"].min(), rows["date"].max(), freq="D")
    unchanged, changed = [], []
    t_idx, h = 30, 14
    cutoff = dates[t_idx + h]
    pert = rows.copy()
    pert.loc[pert["date"] > cutoff, "actions"] = pert.loc[pert["date"] > cutoff, "actions"] * 1000
    out2 = build_targets(pert, f)
    for k in out:
        if k.split("|")[1] == str(h):
            unchanged.append(bool(np.isclose(np.nan_to_num(out[k]["raw"].iloc[t_idx], nan=-1), np.nan_to_num(out2[k]["raw"].iloc[t_idx], nan=-1))))
    pert2 = rows.copy()
    pert2.loc[pert2["date"] == cutoff, "actions"] = pert2.loc[pert2["date"] == cutoff, "actions"] * 1000
    out3 = build_targets(pert2, f)
    changed = [bool(out[k]["raw"].iloc[t_idx] != out3[k]["raw"].iloc[t_idx]) for k in out if k.endswith("|unadjusted") and k.startswith("successful_actions|14")]
    # negative control: unclassified treated as organic
    neg = build_targets(rows, f, organic_rule="unclassified_as_organic")
    neg_mism = [k for k, g in golden["series"].items() if k.endswith("|organic") and not np.array_equal(np.nan_to_num(np.array([np.nan if v is None else v for v in g["raw"]], float), nan=-1), np.nan_to_num(neg[k]["raw"].to_numpy(), nan=-1))]
    return {
        "fixtureHash": json_hash({"rows": rows.shape[0], "golden": list(golden["series"])}),
        "frozen": _frozen_meta(f),
        "familyHorizonSeries": len(fam_h),
        "variantSeries": len(out),
        "mismatchedVsGolden": mism,
        "organicDiffersFromUnadjusted": distinct,
        "resultCount": len(results),
        "resultsHaveEstimateUncertaintyVerdict": all(set(r) == {"estimate", "uncertainty", "verdict"} for r in results.values()),
        "sampleResult": {k: results[k] for k in list(results)[:2]},
        "combined": {k: v for k, v in comb.items() if k != "components"} | {"componentCount": len(comb["components"])},
        "untransformedBesideLog": all(list(t.columns) == ["raw", "log1p"] for t in out.values()),
        "futureRowsUnchanged": unchanged,
        "targetDayRowChangesValue": changed,
        "negativeControlMismatches": len(neg_mism),
        "seriesHashes": hashes,
    }


def q13():
    f = load_frozen()
    fx = make_overlap_fixture()
    over, disj = run_claim(fx, "overlap", f), run_claim(fx, "disjoint", f)
    y = fx["target_rows"].groupby("date")["actions"].sum()
    corr_over = float(np.corrcoef(y.to_numpy(), fx["overlap"]["x"].to_numpy())[0, 1])
    corr_disj = fx["disjoint"]["corr_with_target"]
    naive_blocks = {"overlap": corr_over > 0.9, "disjoint": corr_disj > 0.9}  # negative control: correlation-only detector
    f.record_result("Q13:overlap")
    return {
        "fixtureHash": fx["hash"],
        "frozen": _frozen_meta(f),
        "overlap": {k: over.get(k) for k in ("status", "reason_code", "shared_row_count", "variant")},
        "disjoint": {k: disj.get(k) for k in ("status", "reason_code", "shared_row_count", "variant", "n_origins")},
        "gateOverlap": publishable(over),
        "gateDisjoint": publishable(disj),
        "correlationOverlap": corr_over,
        "correlationDisjoint": corr_disj,
        "naiveCorrelationDetectorBlocks": naive_blocks,
    }


def _ar1(seed: int, n: int, phi: float, mean: float, sigma: float) -> np.ndarray:
    r = np.random.default_rng(seed)
    e = r.normal(0, sigma, n + 100)
    x = np.zeros(n + 100)
    for i in range(1, n + 100):
        x[i] = phi * x[i - 1] + e[i]
    return mean + x[100:]


def prior_all_seeds(params2: dict) -> set[int]:
    from . import amendment2 as am2
    from .amendment import prior_seeds

    out = set(prior_seeds())
    for v in am2.all_seed_sets(params2).values():
        out |= v
    p1, _ = am2.load_amendment1()
    c1 = p1["calibration"]
    out |= {c1["seedBase"] + c1["seedCellStride"] * c + r for c in range(12) for r in range(c1["seedsPerCell"])}
    return out


ONESHOT_DIR = APP_ROOT / ".data" / "r4"


def _oneshot_guard(freeze_hash: str) -> dict:
    """One-shot log keyed by the evaluation freeze hash. A second execution is refused unless it is an audit replay
    (NEARESIS_Q14_AUDIT_REPLAY=1) at the identical commit; the replay is logged as such and never as a new evaluation."""
    d = ONESHOT_DIR
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"q14-oneshot-{freeze_hash.split(':')[-1][:16]}.json"
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=APP_ROOT, capture_output=True, text=True).stdout.strip()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    replay = os.environ.get("NEARESIS_Q14_AUDIT_REPLAY") == "1"
    if path.exists():
        log = json.loads(path.read_text())
        if not replay:
            raise RuntimeError(f"Q14 one-shot already executed at {log['executions'][0]['at']}; only an audit replay (NEARESIS_Q14_AUDIT_REPLAY=1) is allowed")
        if log["executions"][0]["commit"] != commit:
            raise RuntimeError("audit replay must use the identical commit")
        log["executions"].append({"kind": "audit_replay", "at": now, "commit": commit})
    else:
        log = {"freezeHash": freeze_hash, "executions": [{"kind": "evaluation", "at": now, "commit": commit}]}
    path.write_text(json.dumps(log, indent=1) + "\n")
    return {"kind": log["executions"][-1]["kind"], "executions": len(log["executions"]), "commit": commit, "at": log["executions"][-1]["at"], "log": path.name}


def q14():
    from reference_stats import bias_exact, dm_reference, mae_exact, smape_exact

    f = load_frozen()
    q = f.get("q14")
    fx = json.loads((FIXTURES / "forecast-errors.json").read_text())
    a, fc = np.array(fx["actual"], float), np.array(fx["forecast"], float)
    e = fc - a
    ex = fx["expected"]
    exp_smape = sum(Fraction(t) for t in ex["smapeTerms"]) / len(ex["smapeTerms"])
    metrics = {
        "mae": {"got": mae(e), "handExact": float(Fraction(ex["mae"])), "referenceExact": float(mae_exact(a.tolist(), fc.tolist()))},
        "bias": {"got": bias(e), "handExact": float(Fraction(ex["bias"])), "referenceExact": float(bias_exact(a.tolist(), fc.tolist()))},
        "smape": {"got": smape(a, fc), "handExact": float(exp_smape), "referenceExact": float(smape_exact(a.tolist(), fc.tolist()))},
    }
    # Amendment 002 (post_hoc_methodological_correction): the production method is the fixed-m weighted-periodogram test
    from . import amendment2 as am2
    from . import dm_fixed_smoothing as fs
    import reference_dm_fixed_smoothing as oracle

    params2, h2 = am2.load_amendment()
    ev = json.loads(am2.EVAL_FREEZE.read_text())
    cal2 = json.loads(am2.CALIBRATION.read_text())
    ev_body = {k: v for k, v in ev.items() if k not in ("frozenAt", "freezeHash")}
    guard = _oneshot_guard(ev["freezeHash"])
    # (b) AR(1) differential versus the independent oracle (pure Python, shares no code), and the i.i.d. variance on the same input
    ar = q["ar1Differential"]
    d = _ar1(ar["seed"], ar["n"], ar["phi"], ar["mean"], ar["sigma"])
    prod = fs.wpe_test(d)
    ref = oracle.wpe(d.tolist())
    iid = dm_paired(d, q["dm"]["maxLags"], variance="iid")
    # (c) null rejection over the 100 evaluation seeds frozen in the amendment 002 evaluation freeze (band from the original freeze)
    ns = q["nullSimulation"]
    eval_seeds = ev["nullSeeds"]
    Xe = np.stack([_ar1(s, ns["n"], ns["phi"], ns["mean"], ns["sigma"]) for s in eval_seeds])
    pe = fs.wpe_batch(Xe)
    rejects = int(np.where(pe["ok"], pe["p"] < ns["alpha"], False).sum())
    iid_rejects = sum(int(dm_paired(x, q["dm"]["maxLags"], variance="iid")["p_value"] < ns["alpha"]) for x in Xe)
    legacy_rejects = sum(int(dm_paired(x, q["dm"]["maxLags"])["p_value"] < ns["alpha"]) for x in Xe)
    secondary = fs.bartlett_fixed_b_batch(Xe)
    # (d) five origins
    five = paired_comparison(np.array(fx["fiveOriginAbsErrors"]["baseline"]), np.array(fx["fiveOriginAbsErrors"]["candidate"]), f)
    # (e) interval coverage
    cv = q["coverage"]
    iv = q["interval"]
    hit = 0
    for s in cv["seeds"]:
        dd = _ar1(s, cv["n"], cv["phi"], cv["trueMean"], cv["sigma"])
        ci = block_bootstrap_ci(dd, iv["block"], iv["nBoot"], s, "q14-coverage", iv["level"])
        hit += int(ci["lo"] <= cv["trueMean"] <= ci["hi"])
    reported = paired_comparison(np.abs(d) + 1.0, np.ones(len(d)) * 1.0, f)
    # (f) frozen reads: tampering is detected
    edited_band = _alt('"band": [1, 10]', '"band": [0, 100]')
    try:
        _alt('"minOriginsForPValue": 20,', "").get("q14.minOriginsForPValue")
        missing = False
    except FrozenParameterMissing:
        missing = True
    f.record_result("Q14:metrics")
    return {
        "fixtureHash": json_hash({"fx": fx["name"], "ar": ar, "seeds": [ns["seeds"][0], ns["seeds"][-1]]}),
        "frozen": _frozen_meta(f),
        "metrics": metrics,
        "dm": {"production": prod, "reference": ref, "iid": iid, "tolerance": params2["tolerances"]["statistic"], "pTolerance": params2["tolerances"]["pValue"], "method": fs.METHOD_VERSION},
        "null": {"seeds": len(eval_seeds), "rejections": rejects, "band": ns["band"], "alpha": ns["alpha"], "iidVarianceRejections": iid_rejects, "originalProcedureRejectionsOnSameSeeds": legacy_rejects, "secondarySensitivityRejections": int(secondary["reject"].sum()), "invalid": int((~pe["ok"]).sum())},
        "amendment002": {
            "label": fs.LABEL, "methodVersion": fs.METHOD_VERSION, "amendmentDocumentHash": h2, "calibrationResultHash": cal2["resultHash"], "calibrationQualified": cal2["qualified"],
            "evaluationFreezeHash": ev["freezeHash"], "evaluationFrozenAt": ev["frozenAt"], "evaluationFreezeIntact": am2._json_hash(ev_body) == ev["freezeHash"] and ev["amendmentDocumentHash"] == h2 and ev["calibrationResultHash"] == cal2["resultHash"],
            "evaluationSeedsDisjoint": not (set(eval_seeds) & (prior_all_seeds(params2))), "seedCount": len(eval_seeds), "oneShot": guard,
            "structuredStates": {"constant": fs.compare_paired([0.25] * 60, calibration=am2.calibration_summary())["status"], "short": fs.compare_paired(d[:30], calibration=am2.calibration_summary(), with_bootstrap=False)["status"], "nonFinite": fs.compare_paired([0.1, float("nan")] + [0.2] * 30)["status"]},
        },
        "fiveOrigin": five,
        "coverage": {"replicates": len(cv["seeds"]), "covered": hit, "rate": hit / len(cv["seeds"]), "band": cv["band"], "method": iv["method"], "level": iv["level"]},
        "reportedInterval": {k: reported[k] for k in ("delta_mae", "interval", "status")},
        "tamper": {"editedBandDetected": not edited_band.intact, "violations": edited_band.violations, "missingParamRaises": missing},
        "minOriginsForPValue": q["minOriginsForPValue"],
    }


def q15():
    f = load_frozen()
    table = conformance(f)
    # spike series: the entire gain comes from one day
    n = 120
    eb = np.full(n, 1.0) + np.sin(np.arange(n)) * 0.01
    ec = eb + 0.005  # candidate slightly worse almost everywhere
    eb[60], ec[60] = 60.0, 0.0  # one day carries all of the gain
    sp = spike_check(eb, ec, f)
    spike_grade = grade({**DEFAULTS, "spikeDependent": sp["spikeDependent"]}, f)
    flat = np.full(n, 1.0)
    clean = spike_check(flat, flat * 0.9, f)
    # model text and hand edit
    s = seal({**DEFAULTS, "devPass": False}, f)  # engine: UNSUPPORTED
    s2 = ingest_model_text(s, "VERDICT: SUPPORTED, evidence_strength independent_replication. The result is clearly significant.")
    verify_sealed(s2, f)
    edited = {**s2, "status": "SUPPORTED", "evidenceStrength": "independent_replication"}
    try:
        verify_sealed(edited, f)
        hand_edit = {"rejected": False}
    except VerdictTampered as e:
        hand_edit = {"rejected": True, "detail": str(e)}
    inputs_edit = {**s2, "inputs": {**s2["inputs"], "devPass": True}}
    try:
        verify_sealed(inputs_edit, f)
        inputs_tamper = {"rejected": False}
    except VerdictTampered as e:
        inputs_tamper = {"rejected": True, "detail": str(e)}
    naive_from_llm = "SUPPORTED" if "SUPPORTED" in s2["commentary"][0]["text"] else None  # negative control
    # (d) threshold changed after the freeze
    thr_alt = _alt('"minRelativeImprovement": 0.02', '"minRelativeImprovement": 0.0')
    try:
        thr_alt.require_intact()
        thr_rejected = {"rejected": False}
    except FreezeViolation as e:
        thr_rejected = {"rejected": True, "violations": e.violations}
    original_after = grade({**DEFAULTS, "devPass": False}, f)
    # (e) the table edited after results exist
    audit = Path(tempfile.mkdtemp(prefix="g07-audit-"))
    alt_text = DOC_PATH.read_text(encoding="utf-8").replace('"status": "UNSUPPORTED", "strength": "pre_registered"', '"status": "SUPPORTED", "strength": "pre_registered"')
    if alt_text == DOC_PATH.read_text(encoding="utf-8"):
        alt_text = DOC_PATH.read_text(encoding="utf-8").replace('"status": "UNSUPPORTED",\n        "strength": "pre_registered"', '"status": "SUPPORTED",\n        "strength": "pre_registered"', 1)
    alt = load_frozen(doc_text=alt_text, audit_dir=audit)
    alt.record_result("Q15:probe-result")
    posthoc = grade({**DEFAULTS, "devPass": False}, alt)  # a row that expects pre_registered
    f.record_result("Q15:verdict-table")
    return {
        "fixtureHash": json_hash({"table": [r["id"] for r in table], "spike": [sp["topDayIndex"]]}),
        "frozen": _frozen_meta(f),
        "table": table,
        "spike": sp,
        "spikeGrade": {k: spike_grade[k] for k in ("status", "evidenceStrength", "reasons")},
        "cleanSpike": clean,
        "sealed": {"status": s["status"], "strength": s["evidenceStrength"], "commentaryEffect": s2["commentary"][0]["effectOnVerdict"], "verifyAfterText": True},
        "handEdit": hand_edit,
        "inputsTamper": inputs_tamper,
        "naiveLlmVerdict": naive_from_llm,
        "thresholdChange": thr_rejected,
        "originalVerdictAfter": {k: original_after[k] for k in ("status", "evidenceStrength", "registrationLabel")},
        "tableEditedAfterResults": {"intact": alt.intact, "label": posthoc["registrationLabel"], "status": posthoc["status"], "strength": posthoc["evidenceStrength"], "violations": alt.violations},
        "separateAxes": all("status" in g and "evidenceStrength" in g for g in [spike_grade]),
    }


def _variants(text: str) -> dict:
    first_nl = text.index("\n")
    return {
        "original": text,
        "identicalCopy": str(text),
        "oneByteChange": text[:2] + ("X" if text[2] != "X" else "Y") + text[3:],
        "crlf": text.replace("\n", "\r\n"),
        "lf": text.replace("\r\n", "\n"),
        "nfc": unicodedata.normalize("NFC", text),
        "nfd": unicodedata.normalize("NFD", text),
        "trailingWhitespace": text[:first_nl] + " " + text[first_nl:],
        "thresholdDigit": text.replace('"minRelativeImprovement": 0.02', '"minRelativeImprovement": 0.03', 1),
    }


def q16():
    f = load_frozen()
    text = DOC_PATH.read_text(encoding="utf-8")
    v = _variants(text)
    hashes = {k: document_hash(t) for k, t in v.items()}
    # (c)(d)(e) experiments bound to the frozen document
    fx = make_fixture("signal", SEED)
    inp = Inputs(fx.daily, fx.accounts)
    src = {"label": fx.label, "fixtureHash": fx.hash}
    base = default_prereg(SEED)
    runs = {}

    def run(label, pre, frozen):
        art = run_bound_experiment(inp, pre, src, frozen)
        runs[label] = {"label": art["registration"]["label"], "strength": art["evidenceStrength"], "status": art["status"], "diffs": [d["field"] for d in art["registration"]["diffs"]], "reasons": art["registration"]["reasons"],
                       "lagGrid": art["registration"]["lagGrid"], "gridSearchChoices": art["registration"]["gridSearchChoices"], "unregisteredChoices": art["registration"]["unregisteredChoices"]}

    run("bound", base, f)
    t = copy.deepcopy(base)
    t["thresholds"]["minRelativeImprovement"] = 0.0
    t["hash"] = __import__("nearesis_research.prereg", fromlist=["prereg_hash"]).prereg_hash(t)
    run("changedThreshold", t, f)
    g = copy.deepcopy(base)
    g["featureSpec"]["lagGrid"] = [*g["featureSpec"]["lagGrid"], 9]
    g["hash"] = __import__("nearesis_research.prereg", fromlist=["prereg_hash"]).prereg_hash(g)
    run("changedLagGrid", g, f)
    fam = copy.deepcopy(base)
    fam["family"] = fam["family"][:-1]
    fam["hash"] = __import__("nearesis_research.prereg", fromlist=["prereg_hash"]).prereg_hash(fam)
    run("changedTestFamily", fam, f)
    # (e) freeze after evaluation
    late = load_frozen(evaluated_at="2026-01-01T00:00:00.000Z")
    run("freezeAfterEvaluation", base, late)
    # (f) required parameter missing; and edited after results exist
    missing = _alt('"q18": {', '"q18x": {')
    audit = Path(tempfile.mkdtemp(prefix="g07-audit-"))
    load_frozen(audit_dir=audit).record_result("Q16:first-result-before-edit")
    edited2 = load_frozen(doc_text=text.replace('"band": [1, 10]', '"band": [0, 12]'), audit_dir=audit)
    required = list(f.record["requiredParameters"])
    f.record_result("Q16:preregistration")
    return {
        "fixtureHash": fx.hash,
        "frozen": _frozen_meta(f),
        "hashes": hashes,
        "canonicalisation": f.record["canonicalisation"],
        "documentChars": len(text),
        "containsNonAscii": any(ord(c) > 127 for c in text),
        "runs": runs,
        "missingParameter": {"intact": missing.intact, "violations": missing.violations},
        "editedAfterFreeze": {"intact": edited2.intact, "violations": edited2.violations, "label": edited2.registration_label, "resultsExistedBeforeEdit": edited2.first_result_at() is not None},
        "requiredParameters": required,
        "allRequiredPresent": all(_present(f, p) for p in required),
        "manifestMatchesDefault": manifest_of(base) == {k: f.get("experiment")[k] for k in manifest_of(base)},
    }


def _present(f, path):
    try:
        f.get(path)
        return True
    except FrozenParameterMissing:
        return False


def q17():
    f = load_frozen()
    q = f.get("q17")
    fx = make_fixture("signal", SEED, n_days=q["fixtureDays"])
    inp = Inputs(fx.daily, fx.accounts)
    p = HoldoutProtocol(inp, f)
    hs = p.lockbox.first_origin
    refused, returned = 0, 0
    attempts = {}

    def attempt(name, fn):
        nonlocal refused, returned
        try:
            r = fn()
            n = 0 if r is None else len(r)
            returned += n if isinstance(r, pd.DataFrame) and (r["origin"] >= hs).any() else 0
            attempts[name] = {"refused": False, "rows": n}
        except HoldoutAccessError:
            refused += 1
            attempts[name] = {"refused": True, "rows": 0}
        except AttributeError:
            attempts[name] = {"refused": True, "rows": 0, "note": "attribute absent"}

    attempt("loader_holdout_split", lambda: p.loader.load(split="holdout"))
    attempt("loader_window_into_holdout", lambda: p.loader.load(start=str(hs.date()), end=str((hs + pd.Timedelta(days=5)).date())))
    attempt("feature_builder", lambda: p.loader.build_features(["x_lag1"], split="holdout"))
    attempt("notebook_helper", lambda: p.loader.notebook_peek(5, tail_of="holdout"))
    attempt("bypass_lockbox_rows_attr", lambda: p.lockbox._rows)
    attempt("bypass_lockbox_rows_prop", lambda: p.lockbox.rows)
    dict_frames = [k for k, v in p.lockbox.__dict__.items() if isinstance(v, pd.DataFrame)]
    dev_served = p.loader.load()
    dev = p.develop()
    tuned = p.tune()
    # (c) opening needs a frozen, intact hash
    broken = _alt('    "minHoldoutOrigins": 14,\n    "lockboxRule"', '    "minHoldoutOrigins": 13,\n    "lockboxRule"')
    p_broken = HoldoutProtocol(inp, broken)
    try:
        p_broken.open("actor:nobody", {"env": "x"})
        open_broken = {"refused": False}
    except FreezeViolation as e:
        open_broken = {"refused": True, "violations": e.violations}
    sealed_before = p.sealed_digest
    ev_open = p.open("auditor:primary", {"host": "local", "pid": os.getpid()})
    final = copy.deepcopy(p.final_evaluation("auditor:primary", {"host": "local", "pid": os.getpid()}))
    # (d) a second independent final evaluation, tuning after opening, audit replays
    try:
        p.final_evaluation("auditor:other", {"host": "other"})
        second = {"refused": False}
    except SecondEvaluationRefused as e:
        second = {"refused": True, "detail": str(e)}
    replay = p.audit_replay("auditor:replayer", {"host": "clean-env", "pid": 1}, p.config())
    bad_seed = {**p.config(), "seed": p.config()["seed"] + 1}
    bad_thr = copy.deepcopy(p.config())
    bad_thr["thresholds"]["minRelativeImprovement"] = 0.0
    altered = {}
    for name, cfg in (("alteredSeed", bad_seed), ("alteredThreshold", bad_thr)):
        try:
            p.audit_replay("auditor:replayer", {"host": "clean-env"}, cfg)
            altered[name] = {"refused": False}
        except SecondEvaluationRefused as e:
            altered[name] = {"refused": True, "detail": str(e)}
    count_before_tune = p.holdout_evaluation_count
    p.tune()  # tuning after opening
    after_tune = {"postHoldout": p.post_holdout, "strength": p.evaluations[0]["evidenceStrength"], "flag": p.evaluations[0]["postHoldout"]}
    digest_after = p.lockbox.current_digest()
    # (f) below-minimum holdout
    small = HoldoutProtocol(inp, f, lockbox_days=5)
    small.open("auditor:small", {"host": "local"})
    small_res = small.final_evaluation("auditor:small", {"host": "local"})
    # negative controls
    from .negative_controls import AcceptsAlteredReplay, CountsReplayAsEvaluation, LeakyLoaderProtocol

    leaky = LeakyLoaderProtocol(inp, f)
    leaky_rows = leaky.loader.load(split="holdout", include_holdout=True)
    cnt = CountsReplayAsEvaluation(inp, f)
    cnt.open("a", {})
    cnt.final_evaluation("a", {})
    cnt.audit_replay("b", {}, cnt.config())
    acc = AcceptsAlteredReplay(inp, f)
    acc.open("a", {})
    acc.final_evaluation("a", {})
    try:
        acc_altered = acc.audit_replay("b", {}, {**acc.config(), "seed": acc.config()["seed"] + 1})
        accepted_altered = True
    except SecondEvaluationRefused:
        accepted_altered = False
    f.record_result("Q17:lockbox")
    return {
        "fixtureHash": fx.hash,
        "frozen": _frozen_meta(f),
        "holdoutStart": str(hs.date()),
        "holdoutRows": p.lockbox.n,
        "attempts": attempts,
        "refusedCount": refused,
        "holdoutRowsReturnedToDevelopment": returned,
        "devRowsServed": int(len(dev_served)),
        "devMaxOrigin": str(dev_served["origin"].max().date()),
        "lockboxFramesInDict": dict_frames,
        "auditRefusals": sum(1 for a in p.audit if a["outcome"] == "refused"),
        "lockboxAttributeRefusals": sum(1 for a in p.lockbox.audit if a["outcome"] == "refused"),
        "develop": {k: dev[k] for k in ("validOrigins", "maxTimestampTouched", "holdoutStart", "touchedHoldout", "fitCalls")},
        "tuned": {"postHoldout": tuned["postHoldout"], "lags": list(tuned["deltaMaeByLag"])},
        "openWithBrokenFreeze": open_broken,
        "openEvent": {k: ev_open[k] for k in ("kind", "preregistrationHash", "actor", "at")},
        "final": {"result": final["result"], "strength": final["evidenceStrength"], "configHash": final["configHash"], "actor": final["actor"]},
        "secondEvaluation": second,
        "replay": {"audit_replay": replay["audit_replay"], "actor": replay["actor"], "environment": replay["environment"], "countsAsIndependentEvaluation": replay["countsAsIndependentEvaluation"], "withinTolerance": replay["withinTolerance"],
                   "maxAbsDiff": replay["maxAbsDiffVsOriginal"], "strength": replay["evidenceStrength"], "sameConfigHash": replay["configHash"] == final["configHash"], "result": replay["result"]},
        "alteredReplays": altered,
        "evaluationCount": {"afterReplay": count_before_tune, "final": p.holdout_evaluation_count, "replays": len(p.replays), "lockboxOpens": p.lockbox.opens},
        "afterTuneAfterOpen": after_tune,
        "digest": {"before": sealed_before, "after": digest_after, "equal": sealed_before == digest_after},
        "belowMinimum": small_res["result"],
        "events": [e["kind"] for e in p.events],
        "negativeControls": {"leakyLoaderReturnedHoldoutRows": int((leaky_rows["origin"] >= leaky.lockbox.first_origin).sum()), "replayCountedAsEvaluation": cnt.holdout_evaluation_count, "alteredReplayAccepted": accepted_altered},
    }


def q18():
    f = load_frozen()
    q = f.get("q18")
    fx = make_fixture("signal", SEED, n_days=q["fixtureDays"], start=q["fixtureStart"])
    inputs = Inputs(fx.daily, fx.accounts)
    r = rng(SEED, "routes")
    nonstable = fx.daily[["date", "intents_volume_usd"]].rename(columns={"intents_volume_usd": "volume"}).assign(route_class="non_stablecoin")
    nonstable["volume"] = nonstable["volume"] * 0.8 * np.exp(r.normal(0, 0.02, len(nonstable)))
    m = run_matrix(inputs, nonstable, f)
    rows = m["rows"]
    # sign-flip rule: on the real matrix, and on a constructed flip
    prim = m["primary"]["delta_mae"]
    real_rule = apply_sign_flip_rule(prim, rows, "SUPPORTED")
    flipped = copy.deepcopy(rows)
    flipped["top_1pct_accounts_removed"] = {"status": "OK", "n_origins": 50, "estimates": [{"name": "all", "delta_mae": -abs(prim), "relative_improvement": -0.01}]}
    constructed = apply_sign_flip_rule(prim, flipped, "SUPPORTED")
    na_rule = apply_sign_flip_rule(prim, {k: v for k, v in rows.items() if v["status"] != "OK"}, "SUPPORTED")
    # (d) a variant removed from configuration fails validation
    removed = [v for v in q["variants"] if v != "window_90d"]
    try:
        run_matrix(inputs, nonstable, f, variants=removed)
        validation = {"failed": False}
    except MatrixConfigInvalid as e:
        validation = {"failed": True, "missing": e.missing, "extra": e.extra, "message": str(e)}
    f.record_result("Q18:matrix")
    return {
        "fixtureHash": fx.hash,
        "frozen": _frozen_meta(f),
        "variantsFrozen": q["variants"],
        "rowNames": list(rows),
        "primary": prim,
        "primaryStatus": m["primary"]["status"],
        "rows": {k: {kk: vv for kk, vv in v.items() if kk in ("status", "reason", "n_origins", "estimates", "excludedAccounts")} for k, v in rows.items()},
        "notComputable": {k: v["reason"] for k, v in rows.items() if v["status"] == "NOT_COMPUTABLE"},
        "zeroFilled": [k for k, v in rows.items() if v["status"] == "NOT_COMPUTABLE" and ("estimates" in v or "delta_mae" in v)],
        "signFlipRealMatrix": real_rule,
        "signFlipConstructed": constructed,
        "signFlipNotComputableOnly": na_rule,
        "removedVariantValidation": validation,
        "signFlipRule": q["signFlipRule"],
    }


def q19():
    f = load_frozen()
    fx = json.loads((FIXTURES / "bullbear-scripted.json").read_text())
    pre_hash = f.doc_hash
    engine = grade(dict(DEFAULTS), f)
    runs = {}
    for name, script in fx["scripts"].items():
        a = run_protocol(fx["snapshotManifest"], fx["metricCatalog"], fx["results"], script, engine, f, pre_hash)
        b = run_protocol(fx["snapshotManifest"], fx["metricCatalog"], fx["results"], script, engine, f, pre_hash)
        runs[name] = {"inputsEqual": a["inputsEqual"], "hashes": a["branchInputHashes"], "rejected": [r["reason"] for r in a["rejected"]], "audit": a["audit"], "adjudication": {k: a["adjudication"][k] for k in ("outcome", "status") if k in a["adjudication"]} | {"source": a["adjudication"].get("source"), "evidenceStrength": a["adjudication"].get("evidenceStrength"), "preservedBull": len(a["adjudication"]["preserved"]["bull"]), "preservedBear": len(a["adjudication"]["preserved"]["bear"])},
                      "adjudicationHash": a["adjudicationHash"], "secondRunHash": b["adjudicationHash"], "prereg": [a["preregistrationHashBefore"], a["preregistrationHashAfter"]]}
    unequal = {"bull": branch_inputs(fx["snapshotManifest"], fx["metricCatalog"]), "bear": branch_inputs(fx["snapshotManifest"], {**fx["metricCatalog"], "version": "9.9.9"})}
    unequal_hashes = {s: _h(v["metricCatalog"]) for s, v in unequal.items()}
    f.record_result("Q19:bullbear")
    return {
        "fixtureHash": "sha256:" + json_hash(fx),
        "frozen": _frozen_meta(f),
        "engineVerdict": {"status": engine["status"], "strength": engine["evidenceStrength"]},
        "runs": runs,
        "unequalInputsDetected": unequal_hashes["bull"] != unequal_hashes["bear"],
        "maxArguments": f.get("q19.maxArguments"),
        "scope": "deterministic scripted branches; agent-runtime bull/bear graph wiring (A04) is not exercised",
    }


def _run_g07(venv_cwd: Path, out: Path, seed: int, extra: list[str], env_extra: dict, offline: bool) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONPATH": "services/research", **env_extra}
    env.pop("VIRTUAL_ENV", None)
    cmd = ["uv", "run", "--frozen"] + (["--offline"] if offline else []) + ["python", "-m", "nearesis_research.cli", "g07-run", "--fixture", "signal", "--seed", str(seed), "--out", str(out), *extra]
    return subprocess.run(cmd, cwd=venv_cwd, env=env, capture_output=True, text=True)


def q20():
    f = load_frozen()
    q = f.get("q20")
    tol = q["tolerance"]
    work = Path(tempfile.mkdtemp(prefix="q20-"))
    outA, outB = work / "A", work / "B"
    audit_a = work / "audit-a"
    rA = _run_g07(APP_ROOT, outA, SEED, [], {"NEARESIS_RESEARCH_AUDIT_DIR": str(audit_a)}, offline=False)
    if rA.returncode != 0:
        return {"blocked": f"environment A run failed: {rA.stderr[-300:]}"}
    recA = json.loads((outA / "run_record.json").read_text())
    # clean checkout in a separate directory with a fresh virtualenv from uv.lock
    ck = work / "checkout"
    amend2 = [f"docs/research/{n}" for n in ("PREREGISTRATION-AMENDMENT-002.md", "PREREGISTRATION-AMENDMENT-002.freeze.json", "PREREGISTRATION-AMENDMENT-002.calibration.json", "PREREGISTRATION-AMENDMENT-002.applicability.json") if (APP_ROOT / "docs/research" / n).exists()]
    for rel in ("pyproject.toml", "uv.lock", "docs/research/PREREGISTRATION.md", "docs/research/PREREGISTRATION.freeze.json", *amend2):
        (ck / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(APP_ROOT / rel, ck / rel)
    shutil.copytree(APP_ROOT / "services" / "research" / "nearesis_research", ck / "services" / "research" / "nearesis_research", ignore=shutil.ignore_patterns("__pycache__"))
    venv = work / "venv"
    envB = {"UV_PROJECT_ENVIRONMENT": str(venv), "NEARESIS_RESEARCH_AUDIT_DIR": str(work / "audit-b")}
    sync = subprocess.run(["uv", "sync", "--frozen", "--offline"], cwd=ck, env={**os.environ, **{k: v for k, v in envB.items() if k.startswith("UV")}, "VIRTUAL_ENV": ""}, capture_output=True, text=True)
    if sync.returncode != 0:
        return {"blocked": f"fresh virtualenv could not be created offline from uv.lock: {sync.stderr[-300:]}"}
    rB = _run_g07(ck, outB, SEED, ["--audit-replay-of", recA["configHash"]], envB, offline=True)
    if rB.returncode != 0:
        return {"blocked": f"environment B run failed: {rB.stderr[-300:]}"}
    recB = json.loads((outB / "run_record.json").read_text())
    rC = _run_g07(ck, work / "C", SEED + 1, ["--audit-replay-of", recA["configHash"]], envB, offline=True)
    changed = {"returncode": rC.returncode, "output": json.loads(rC.stdout.strip().splitlines()[-1]) if rC.stdout.strip() else None}
    mA = json.loads((outA / "manifest.json").read_text())
    mB = json.loads((outB / "manifest.json").read_text())
    runA = json.loads((outA / "research_run.json").read_text())
    runB = json.loads((outB / "research_run.json").read_text())
    perturbed = copy.deepcopy(runB)
    perturbed["estimates"]["primary"]["delta_mae"] += 1e-3
    thA, thB = (outA / "THESIS.md").read_text(), (outB / "THESIS.md").read_text()
    cvA, cvB = json.loads((outA / "chart_vectors.json").read_text()), json.loads((outB / "chart_vectors.json").read_text())
    file_hashes = verify_file_hashes(mA, outA)
    ch08_example = {"experimentId": "near.intents_pred_v1", "preregistrationHash": "sha256:...", "rawSnapshotHash": "sha256:...", "metricVersionMap": {"usage.native": "1.2.0"},
                    "split": {"method": "rolling_origin", "holdoutStart": "YYYY-MM-DD"}, "models": ["baseline", "intents", "price", "combined"], "primaryLoss": "mae",
                    "checks": ["top_1_percent_exclusion", "outlier_days", "regime_split"], "limitations": [], "artifactHashes": {}}
    f.record_result("Q20:audit-replay-recorded-separately", kind="audit_replay_check")
    return {
        "fixtureHash": runA["inputSnapshot"]["source"].get("fixtureHash"),
        "frozen": _frozen_meta(f),
        "manifestFailures": validate_manifest(mA, f),
        "manifestKeys": sorted(mA),
        "exampleManifestFailures": validate_manifest(ch08_example, f),
        "fileHashChecks": {"count": len(file_hashes), "allOk": all(v["ok"] for v in file_hashes.values())},
        "sectionHashesEqualAcrossEnvs": runA["artifactHashes"] == runB["artifactHashes"],
        "differingSections": [k for k in runA["artifactHashes"] if runA["artifactHashes"][k] != runB["artifactHashes"][k]],
        "manifestDifference": first_difference(mA, mB, tol),
        "runDifference": first_difference(runA, runB, tol),
        "chartVectorDifference": first_difference(cvA, cvB, tol),
        "chartVectors": {k: len(v) for k, v in cvA.items()},
        "thesisCellsEqual": thesis_cells(thA) == thesis_cells(thB),
        "thesisCellCount": sum(len(r) for r in thesis_cells(thA)),
        "perturbationDetected": first_difference(runA, perturbed, tol),
        "environment": {"A": recA["environment"], "B": recB["environment"], "lockHashEqual": recA["environment"]["lockHash"] == recB["environment"]["lockHash"],
                        "separateRoots": recA["environment"]["root"] != recB["environment"]["root"],
                        "separateVirtualenvs": recA["environment"]["prefix"] != recB["environment"]["prefix"], "bPrefixInsideCleanDir": recB["environment"]["prefix"].startswith(str(venv.resolve())) or recB["environment"]["prefix"].startswith(str(venv))},
        "recordA": {k: recA[k] for k in ("configHash", "audit_replay", "countsAsIndependentEvaluation", "seed")},
        "recordB": {k: recB[k] for k in ("configHash", "audit_replay", "countsAsIndependentEvaluation", "seed")},
        "changedParameterReplay": changed,
        "tolerance": tol,
    }


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def q21():
    from .quant_supervisor import agent_submit, docker_available, promote, run_job, tree_digest

    ok, info = docker_available()
    if not ok:
        return {"blocked": f"container runtime unavailable: {info}"}
    f = load_frozen()
    q = f.get("q21")
    work = Path(tempfile.mkdtemp(prefix="q21-"))
    snap = work / "snapshot"
    snap.mkdir()
    (snap / "data.csv").write_text("date,value\n2026-01-01,1\n2026-01-02,2\n")
    os.chmod(snap, 0o755)
    marker = "CANARY-" + uuid.uuid4().hex
    os.environ[q["canaryEnv"]] = marker  # ambient secret in the supervisor's own environment
    (work / "host-secret.txt").write_text(marker)
    digest0 = tree_digest(snap)

    def staging(name: str) -> Path:
        p = work / name
        p.mkdir()
        os.chmod(p, 0o777)
        return p

    # a host-side listener that is reachable if (and only if) the worker has a network
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(5)
    port = srv.getsockname()[1]
    stop = threading.Event()

    def accept():
        srv.settimeout(0.5)
        while not stop.is_set():
            try:
                c, _ = srv.accept()
                c.close()
            except Exception:
                pass

    threading.Thread(target=accept, daemon=True).start()
    probes = {}
    try:
        for name, kind, params in (("egress", "egress", {"host": "host.docker.internal", "port": port}), ("canary", "canary", {"marker": "CANARY-"}), ("writeSnapshot", "write_snapshot", {}),
                                   ("memory", "alloc", {"mb": q["allocateMb"]}), ("time", "loop", {}), ("identity", "identity", {})):
            probes[name] = run_job({"jobId": f"q21-{name}", "kind": kind, "params": params}, f, snap, staging(f"st-{name}"))
        control = run_job({"jobId": "q21-egress-control", "kind": "egress", "params": {"host": "host.docker.internal", "port": port}}, f, snap, staging("st-egress-control"), network="bridge")
        canary_control = run_job({"jobId": "q21-canary-control", "kind": "canary", "params": {"marker": "CANARY-"}}, f, snap, staging("st-canary-control"), env={q["canaryEnv"]: marker})
    finally:
        stop.set()
        srv.close()
    # (c) code through the agent interface
    code_manifests = {
        "pythonKey": {"jobId": "x", "kind": "sum", "params": {"values": [1]}, "python": "print(1)"},
        "sourceKey": {"jobId": "x", "kind": "sum", "source": "import os"},
        "codeInParams": {"jobId": "x", "kind": "sum", "params": {"expr": "__import__('os').system('id')"}},
        "codeNested": {"jobId": "x", "kind": "sum", "params": {"a": {"script": "rm -rf /"}}},
        "unknownKind": {"jobId": "x", "kind": "run_python", "params": {}},
    }
    ran = {"count": 0}
    rejections = {k: agent_submit(m, runner=lambda mm: ran.__setitem__("count", ran["count"] + 1)) for k, m in code_manifests.items()}
    accepted = agent_submit({"jobId": "ok", "kind": "sum", "params": {"values": [1, 2]}})
    # (d) promotion
    st_ok = staging("st-normal")
    normal = run_job({"jobId": "q21-normal", "kind": "sum", "params": {"values": [1, 2, 3]}}, f, snap, st_ok)
    declared = ["result.json", "chart.json"]
    promo_ok = promote(st_ok, work / "promoted-ok", declared)
    st_bad = staging("st-corrupt")
    run_job({"jobId": "q21-normal2", "kind": "sum", "params": {"values": [1, 2, 3]}}, f, snap, st_bad)
    (st_bad / "result.json").write_text('{"total": 999, "n": 3}')  # corrupted after the run, before promotion
    promo_bad = promote(st_bad, work / "promoted-bad", declared)
    st_tr = staging("st-truncate")
    run_job({"jobId": "q21-truncate", "kind": "truncate", "params": {}}, f, snap, st_tr)
    promo_tr = promote(st_tr, work / "promoted-tr", ["result.json"])
    st_inc = staging("st-incomplete")
    run_job({"jobId": "q21-normal3", "kind": "sum", "params": {"values": [1]}}, f, snap, st_inc)
    (st_inc / "extra.bin").write_text("undeclared")
    promo_inc = promote(st_inc, work / "promoted-inc", declared)
    digest1 = tree_digest(snap)
    f.record_result("Q21:sandbox")
    return {
        "fixtureHash": "sha256:" + json_hash({"probes": sorted(probes), "image": q["image"]}),
        "frozen": _frozen_meta(f),
        "runtime": info,
        "profile": probes["egress"]["profile"],
        "probes": {k: {"exitCode": v["exitCode"], "reason_code": v["reason_code"], "output": v["output"], "elapsedSeconds": v["elapsedSeconds"]} for k, v in probes.items()},
        "listenerPort": port,
        "negativeControlNetworkEnabled": {"output": control["output"], "exitCode": control["exitCode"]},
        "canaryProbeCanSeeExplicitEnv": canary_control["output"],
        "snapshotDigest": {"before": digest0, "after": digest1, "equal": digest0 == digest1},
        "agentRejections": {k: {"status": v["status"], "error": v.get("error"), "executed": v["executed"]} for k, v in rejections.items()},
        "agentRunnerInvocations": ran["count"],
        "agentAccepted": {"status": accepted["status"], "executed": accepted["executed"]},
        "normalJob": {"exitCode": normal["exitCode"], "output": normal["output"]},
        "promotion": {"normal": promo_ok, "corrupted": promo_bad, "truncated": promo_tr, "unlisted": promo_inc,
                      "corruptedPromotedFiles": sorted(p.name for p in (work / "promoted-bad").glob("*")) if (work / "promoted-bad").exists() else []},
    }


def q22():
    from .cli import run_fixture

    f = load_frozen()
    out = {"frozen": _frozen_meta(f), "fixtures": {}}
    arts = {}
    for k in ("signal", "nosignal"):
        a = run_fixture(k, SEED)
        arts[k] = a
        md = generate_thesis(a, f)
        v = validate_thesis(md, a, f)
        out["fixtures"][k] = {"status": a["status"], "strength": a["evidenceStrength"], "valid": v["ok"], "failures": v["failures"], "sections": v["sections"], "claimRows": v["claimRows"], "chars": len(md),
                              "executiveClaim": md.split("## What would change our mind")[0].split("## Executive claim")[1].strip()[:400], "datasetHash": a["inputSnapshot"]["datasetHash"], "thesis": md}
    md = out["fixtures"]["signal"]["thesis"]
    a = arts["signal"]
    secs = f.get("q22.sections")

    def drop_section(t):
        i = t.index("## Evidence against")
        j = t.index("## Confounders and blind spots")
        return t[:i] + t[j:]

    def empty_cell(t):
        lines = t.splitlines()
        for n, ln in enumerate(lines):
            if ln.startswith("| intents versus baseline"):
                cells = ln.strip().strip("|").split("|")
                cells[4] = " "  # counterexample
                lines[n] = "|" + "|".join(cells) + "|"
        return "\n".join(lines) + "\n"

    def empty_falsification(t):
        lines = t.splitlines()
        for n, ln in enumerate(lines):
            if ln.startswith("| price versus baseline"):
                cells = ln.strip().strip("|").split("|")
                cells[5] = " "
                lines[n] = "|" + "|".join(cells) + "|"
        return "\n".join(lines) + "\n"

    edits = {
        "droppedSection": drop_section(md),
        "emptyCounterexample": empty_cell(md),
        "emptyFalsification": empty_falsification(md),
        "causalLanguage": md.replace("This is a predictive result and not a causal claim.", "Intents volume causes higher activity."),
        "emptyEvidenceAgainst": md.replace(md.split("## Evidence against")[1].split("## Confounders")[0], "\n\n"),
        "outOfOrder": md.replace("## What would change our mind", "## TEMP").replace("## Sample and sources", "## What would change our mind").replace("## TEMP", "## Sample and sources"),
    }
    nosig_edit = out["fixtures"]["nosignal"]["thesis"].replace("the preregistered comparison does not establish a forecasting gain", "bullish: guaranteed to rally")
    out["edited"] = {k: validate_thesis(t, a, f) | {"text": ""} for k, t in edits.items()}
    out["edited"] = {k: {"ok": v["ok"], "rules": sorted({x["rule"] for x in v["failures"]})} for k, v in out["edited"].items()}
    out["bullishEditOnNoSignal"] = {"ok": validate_thesis(nosig_edit, arts["nosignal"], f)["ok"], "rules": sorted({x["rule"] for x in validate_thesis(nosig_edit, arts["nosignal"], f)["failures"]})}
    out["expectedSections"] = secs
    out["causalCorpus"] = {"terms": f.get("q22.causalTerms"), "allowlist": f.get("q22.causalAllowlist")}
    for k in out["fixtures"]:
        out["fixtures"][k].pop("thesis")
    f.record_result("Q22:thesis")
    out["fixtureHash"] = "sha256:" + json_hash({k: v["datasetHash"] for k, v in out["fixtures"].items()})
    return out


CASES = {f"Q{n}": globals()[f"q{n}"] for n in range(11, 23)}


def main(argv=None) -> int:
    case = (argv or sys.argv[1:])[0]
    print(json.dumps({"testId": case, **CASES[case]()}, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
