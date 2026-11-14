"""Verdict engine (ch.08 model grading, ch.16b Q15). Thresholds and the conformance table come from the frozen
preregistration; status and evidence strength are separate axes; no narrative or externally supplied verdict is read."""

from __future__ import annotations

import numpy as np

from .core import json_hash
from .frozen import Frozen

DEFAULTS = {
    "preregOk": True,
    "complete": True,
    "enoughDevOrigins": True,
    "devPass": True,
    "holdout": "pass",  # none | insufficient | fail | pass
    "robustnessShare": 1.0,
    "placebo": "pass",
    "independentReplication": False,
    "adversarialDisagreement": False,
    "spikeDependent": False,
}


class VerdictTampered(RuntimeError):
    pass


def _grade_flags(i: dict, agree_share: float) -> tuple[str, str, list[str]]:
    if not i["preregOk"]:
        return "NOT_REPRODUCIBLE", "exploratory", ["preregistration hash does not match its content"]
    if not i["complete"]:
        return "INSUFFICIENT_DATA", "exploratory", ["dataset incomplete"]
    if not i["enoughDevOrigins"]:
        return "INSUFFICIENT_DATA", "exploratory", ["fewer development origins than the frozen minimum"]
    if not i["devPass"]:
        return "UNSUPPORTED", "pre_registered", ["development comparison missed the frozen criteria; lockbox left sealed"]
    if i["holdout"] in ("none", "insufficient"):
        return "INSUFFICIENT_DATA", "pre_registered", ["holdout missing or below the frozen minimum"]
    fails = []
    if i["holdout"] != "pass":
        fails.append("holdout did not confirm the development effect")
    if i["robustnessShare"] is None or i["robustnessShare"] < agree_share:
        fails.append("robustness agreement below the frozen share")
    if i["placebo"] != "pass":
        fails.append("falsification test not passed")
    if i["adversarialDisagreement"]:
        fails.append("bull and bear branches disagree (no forced consensus)")
    if fails:
        return "MIXED", "pre_registered", fails
    if i["independentReplication"]:
        return "SUPPORTED", "independent_replication", ["frozen thresholds met and independently replicated; predictive only"]
    return "SUPPORTED", "out_of_sample", ["frozen thresholds met on development and lockbox holdout; predictive only"]


def grade(inputs: dict, frozen: Frozen) -> dict:
    """Computes (status, strength) from structured inputs only. A frozen document that differs from its freeze record
    removes pre_registered or stronger strength and labels the verdict post-hoc."""
    i = {**DEFAULTS, **inputs}
    thr = frozen.get("experiment.thresholds")
    status, strength, reasons = _grade_flags(i, thr["robustnessAgreeShare"])
    if i["spikeDependent"]:
        if status == "SUPPORTED":
            status = "MIXED"
        strength = "exploratory"
        reasons.append("result depends on one day: removing it moves the effect below the frozen threshold")
    label = frozen.registration_label
    if not frozen.intact:
        strength = "exploratory"
        reasons.append("frozen preregistration differs from its freeze record: post-hoc, pre_registered strength refused")
    return {"status": status, "evidenceStrength": strength, "reasons": reasons, "registrationLabel": label, "thresholdsFrom": frozen.doc_hash}


def conformance(frozen: Frozen) -> list[dict]:
    """Evaluates every row of the frozen verdict table; each row records the engine output beside the expectation."""
    rows = []
    for r in frozen.get("q15.verdictTable"):
        g = grade({**DEFAULTS, **r["when"]}, frozen)
        rows.append({"id": r["id"], "when": r["when"], "expected": [r["status"], r["strength"]], "got": [g["status"], g["evidenceStrength"]], "ok": [g["status"], g["evidenceStrength"]] == [r["status"], r["strength"]]})
    return rows


def spike_check(abs_err_base: np.ndarray, abs_err_cand: np.ndarray, frozen: Frozen) -> dict:
    thr = frozen.get("experiment.thresholds")["minRelativeImprovement"]
    eb, ec = np.asarray(abs_err_base, float), np.asarray(abs_err_cand, float)
    gain = eb - ec
    top = int(np.argmax(gain))
    keep = np.ones(len(eb), bool)
    keep[top] = False
    rel_all = float((eb.mean() - ec.mean()) / eb.mean())
    rel_wo = float((eb[keep].mean() - ec[keep].mean()) / eb[keep].mean())
    share = float(gain[top] / gain.sum()) if gain.sum() > 0 else None
    return {"relativeImprovement": rel_all, "relativeImprovementWithoutTopDay": rel_wo, "topDayIndex": top, "topDayShareOfGain": share, "threshold": thr, "spikeDependent": bool(rel_wo < thr)}


def seal(inputs: dict, frozen: Frozen) -> dict:
    g = grade(inputs, frozen)
    return {"inputs": {**DEFAULTS, **inputs}, "status": g["status"], "evidenceStrength": g["evidenceStrength"], "inputsHash": "sha256:" + json_hash({**DEFAULTS, **inputs})}


def verify_sealed(sealed: dict, frozen: Frozen) -> dict:
    """Publication path: recomputes the verdict from the sealed inputs; any stored value that differs is rejected."""
    g = grade(sealed["inputs"], frozen)
    if sealed["inputsHash"] != "sha256:" + json_hash(sealed["inputs"]):
        raise VerdictTampered("verdict inputs were edited after sealing")
    if (sealed["status"], sealed["evidenceStrength"]) != (g["status"], g["evidenceStrength"]):
        raise VerdictTampered(f"stored verdict {sealed['status']}/{sealed['evidenceStrength']} differs from engine {g['status']}/{g['evidenceStrength']}")
    return sealed


def ingest_model_text(sealed: dict, text: str) -> dict:
    """Free text from a language model is recorded as commentary and has no effect on the verdict."""
    return {**sealed, "commentary": [*sealed.get("commentary", []), {"text": text, "effectOnVerdict": "none"}]}
