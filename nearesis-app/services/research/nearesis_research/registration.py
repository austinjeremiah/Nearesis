"""Binds an experiment to the frozen preregistration (Q16 c to f). An experiment whose manifest differs from the frozen
document on any frozen field, whose frozen document is invalid, or which was evaluated before the freeze, is labelled
`post-hoc registration` and cannot carry pre_registered or stronger evidence strength."""

from __future__ import annotations

from .dataset import Inputs
from .experiment import run_experiment
from .frozen import Frozen, load_frozen


def manifest_of(pre: dict) -> dict:
    return {
        "horizons": pre["horizons"],
        "primaryHorizon": pre["primaryHorizon"],
        "primaryCandidate": pre["primaryCandidate"],
        "lagGrid": pre["featureSpec"]["lagGrid"],
        "minTrain": pre["split"]["minTrain"],
        "lockboxDays": pre["split"]["lockboxDays"],
        "testFamily": pre["family"],
        "fdr": pre["fdr"],
        "thresholds": pre["thresholds"],
    }


def diff_manifest(manifest: dict, frozen: Frozen) -> list[dict]:
    e = frozen.get("experiment")
    out = []
    for k, want in manifest.items():
        if k in e and e[k] != want:
            out.append({"field": k, "frozen": e[k], "manifest": want})
    return out


def run_bound_experiment(inputs: Inputs, pre: dict, source: dict, frozen: Frozen) -> dict:
    art = run_experiment(inputs, pre, source)
    diffs = diff_manifest(manifest_of(pre), frozen)
    grid = sorted(int(k) for k in (art["falsification"].get("lagComparison") or {}))
    unreg = [L for L in grid if L not in frozen.get("experiment.lagGrid")]
    reasons = [f"manifest field '{d['field']}' differs from the frozen document" for d in diffs] + list(frozen.violations)
    label = "pre_registered" if not reasons and frozen.intact else "post-hoc registration"
    art["registration"] = {
        "label": label,
        "reasons": reasons,
        "diffs": diffs,
        "frozenDocumentHash": frozen.doc_hash,
        "frozenAt": frozen.record["frozenAt"],
        "lagGrid": list(pre["featureSpec"]["lagGrid"]),
        "gridSearchChoices": grid,
        "unregisteredChoices": unreg,
        "canonicalisation": frozen.record["canonicalisation"],
    }
    if label != "pre_registered":
        art["evidenceStrength"] = "exploratory"
        art["verdict"] = {**art["verdict"], "evidenceStrength": "exploratory"}
    return art
