"""Amendment 001 machinery: calibration, mechanical selection, evaluation-seed derivation and the evaluation freeze.

Reads only the amendment's own frozen block (`PREREGISTRATION-AMENDMENT-001.md`, hash recorded in its freeze record).
Subcommands: `calibrate` (writes the calibration result), `freeze-eval` (derives and freezes the 100 evaluation seeds)."""

from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .dm_amended import LABEL, dm_candidate
from .frozen import APP_ROOT, CANONICALISATION, DOC_PATH, document_hash, extract_params, load_frozen

DOCS = APP_ROOT / "docs" / "research"
AMEND_DOC = DOCS / "PREREGISTRATION-AMENDMENT-001.md"
AMEND_FREEZE = DOCS / "PREREGISTRATION-AMENDMENT-001.freeze.json"
CALIBRATION = DOCS / "PREREGISTRATION-AMENDMENT-001.calibration.json"
EVAL_FREEZE = DOCS / "PREREGISTRATION-AMENDMENT-001.evaluation-freeze.json"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def load_amendment() -> tuple[dict, str]:
    """Returns (frozen block, document hash); raises if the document differs from its freeze record."""
    text = AMEND_DOC.read_text(encoding="utf-8")
    rec = json.loads(AMEND_FREEZE.read_text())
    h = document_hash(text)
    if h != rec["documentHash"]:
        raise RuntimeError("amendment document hash differs from its freeze record")
    return extract_params(text), h


def _json_hash(obj) -> str:
    return "sha256:" + hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def ar1(seed: int, n: int, phi: float, mean: float, sigma: float, burn: int) -> np.ndarray:
    """Same generator as the production Q14 null simulation (numpy default_rng, normal innovations, burn-in)."""
    r = np.random.default_rng(seed)
    e = r.normal(0, sigma, n + burn)
    x = np.zeros(n + burn)
    for i in range(1, n + burn):
        x[i] = phi * x[i - 1] + e[i]
    return mean + x[burn:]


def prior_seeds() -> set[int]:
    f = load_frozen().params
    out: set[int] = set()
    q = f["q14"]
    out.update(q["nullSimulation"]["seeds"])
    out.update(q["coverage"]["seeds"])
    for k in ("ar1Differential", "fiveOriginCase"):
        out.add(q[k]["seed"])
    out.add(q["interval"]["bootstrapSeed"])
    return out


def calibration_seeds(cal: dict) -> dict[tuple[float, int], list[int]]:
    cells = {}
    i = 0
    for phi in cal["phi"]:
        for n in cal["n"]:
            base = cal["seedBase"] + cal["seedCellStride"] * i
            cells[(phi, n)] = list(range(base, base + cal["seedsPerCell"]))
            i += 1
    return cells


def select(table: dict, params: dict) -> dict:
    """Applies the pre-declared rule mechanically. table[candidate][cellKey] = size."""
    rule, cal = params["selectionRule"], params["calibration"]
    primary = f"phi={cal['primaryCell']['phi']},n={cal['primaryCell']['n']}"
    qualifiers = []
    detail = {}
    for c in params["candidates"]:
        if not c["eligible"]:
            continue
        sizes = table[c["id"]]
        ok_p = rule["primaryCellSizeBand"][0] <= sizes[primary] <= rule["primaryCellSizeBand"][1]
        failing = [k for k, v in sizes.items() if k != primary and not (rule["otherCellSizeBand"][0] <= v <= rule["otherCellSizeBand"][1])]
        maxdev = max(abs(v - params["amendment"]["alpha"]) for v in sizes.values())
        ncorr = int(c["hln"]) + int(c["prewhiten"]) + int(c["lag"]["rule"] == "andrews_ar1")
        detail[c["id"]] = {"primaryCellOk": ok_p, "failingOtherCells": failing, "maxAbsDeviation": maxdev, "corrections": ncorr, "qualifies": ok_p and not failing}
        if ok_p and not failing:
            qualifiers.append((c["id"], maxdev, ncorr))
    if not qualifiers:
        return {"selected": None, "outcome": rule["noQualifierOutcome"], "detail": detail}
    best = min(q[1] for q in qualifiers)
    near = [q for q in qualifiers if q[1] - best < rule["tieMargin"]]
    near.sort(key=lambda q: (q[2], int(q[0][1:])))
    return {"selected": near[0][0], "outcome": "selected", "tieBreakUsed": len(near) > 1, "detail": detail}


def calibrate() -> dict:
    params, amend_hash = load_amendment()
    cal = params["calibration"]
    cells = calibration_seeds(cal)
    allcal = {s for v in cells.values() for s in v}
    assert len(allcal) == len(cells) * cal["seedsPerCell"], "calibration seeds collide"
    assert not (allcal & prior_seeds()), "calibration seeds overlap an earlier seed"
    assert min(allcal) > 999_999, "calibration seeds must be above every earlier seed range"
    dgp = cal["dgp"]
    alpha = dgp["alpha"]
    cands = params["candidates"]
    counts = {c["id"]: {} for c in cands}
    for (phi, n), seeds in cells.items():
        key = f"phi={phi},n={n}"
        rej = {c["id"]: 0 for c in cands}
        for s in seeds:
            d = ar1(s, n, phi, dgp["mean"], dgp["sigma"], dgp["burnIn"])
            for c in cands:
                p = dm_candidate(d, c, params)["p_value"]
                rej[c["id"]] += int(p is not None and p < alpha)
        for cid, r in rej.items():
            counts[cid][key] = r
        print("cell", key, rej, flush=True)
    table = {cid: {k: v / cal["seedsPerCell"] for k, v in row.items()} for cid, row in counts.items()}
    sel = select(table, params)
    result = {
        "schema": "preregistration-amendment-calibration@1",
        "label": LABEL,
        "amendmentDocumentHash": amend_hash,
        "calibratedAt": _now(),
        "seedsPerCell": cal["seedsPerCell"],
        "calibrationSeedRange": [min(allcal), max(allcal)],
        "rejections": counts,
        "size": table,
        "selection": sel,
    }
    result["resultHash"] = _json_hash({k: v for k, v in result.items() if k not in ("calibratedAt", "resultHash")})
    CALIBRATION.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return result


def derive_eval_seeds(amend_hash: str, cal_hash: str, params: dict, excluded: set[int]) -> list[int]:
    es = params["evaluationSeeds"]
    seeds: list[int] = []
    taken = set(excluded)
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
    """Writes the evaluation freeze (selected estimator, 100 derived seeds, own hash and timestamp). Refuses to overwrite."""
    if EVAL_FREEZE.exists():
        raise RuntimeError("evaluation freeze already exists; never re-frozen")
    params, amend_hash = load_amendment()
    cal = json.loads(CALIBRATION.read_text())
    if cal["selection"]["selected"] is None:
        raise RuntimeError("no candidate qualified: Q14 remains FAIL; no evaluation seeds are drawn")
    if cal["amendmentDocumentHash"] != amend_hash:
        raise RuntimeError("calibration result does not belong to this amendment")
    recomputed = _json_hash({k: v for k, v in cal.items() if k not in ("calibratedAt", "resultHash")})
    if recomputed != cal["resultHash"]:
        raise RuntimeError("calibration result hash mismatch")
    cell_seeds = {s for v in calibration_seeds(params["calibration"]).values() for s in v}
    seeds = derive_eval_seeds(amend_hash, cal["resultHash"], params, prior_seeds() | cell_seeds)
    cand = next(c for c in params["candidates"] if c["id"] == cal["selection"]["selected"])
    body = {
        "schema": "preregistration-amendment-evaluation-freeze@1",
        "label": LABEL,
        "amendmentDocumentHash": amend_hash,
        "calibrationResultHash": cal["resultHash"],
        "selectedCandidate": cand,
        "rhoClip": params["rhoClip"],
        "andrewsConstant": params["andrewsConstant"],
        "horizonForHLN": params["amendment"]["horizonForHLN"],
        "nullSeeds": seeds,
        "band": params["amendment"]["bandUnchanged"],
        "alpha": params["amendment"]["alpha"],
        "canonicalisation": CANONICALISATION,
    }
    rec = {**body, "frozenAt": _now(), "freezeHash": _json_hash(body)}
    EVAL_FREEZE.write_text(json.dumps(rec, indent=2, sort_keys=True) + "\n")
    return rec


if __name__ == "__main__":
    cmd = sys.argv[1:]
    if cmd == ["calibrate"]:
        r = calibrate()
        print(json.dumps({"selection": r["selection"]["selected"], "outcome": r["selection"]["outcome"], "hash": r["resultHash"]}))
    elif cmd == ["freeze-eval"]:
        r = freeze_eval()
        print(json.dumps({"freezeHash": r["freezeHash"], "frozenAt": r["frozenAt"], "candidate": r["selectedCandidate"]["id"], "seeds": len(r["nullSeeds"])}))
    else:
        raise SystemExit("usage: amendment calibrate | freeze-eval")
