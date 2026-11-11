"""Bull/bear adversarial protocol with deterministic adjudication (ch.27, ch.16b Q19).

The branch outputs here are scripted (deterministic mock inference). The protocol around them is the real code under test:
identical inputs to both branches, an argument validator (result ID, number fidelity, per-side limit), an audited denial of
any preregistration edit, and a pure-function adjudicator that preserves disagreement instead of forcing consensus."""

from __future__ import annotations

import copy

from .core import json_hash
from .frozen import Frozen


def _h(o) -> str:
    return "sha256:" + json_hash(o)


def branch_inputs(snapshot_manifest: dict, catalog: dict) -> dict:
    """Builds the identical input package for one branch (deep copy per branch)."""
    return {"snapshotManifest": copy.deepcopy(snapshot_manifest), "metricCatalog": copy.deepcopy(catalog)}


def validate_arguments(side: str, args: list[dict], results: dict, frozen: Frozen, audit: list) -> tuple[list, list]:
    q = frozen.get("q19")
    tol = q["numberRelativeTolerance"]
    accepted, rejected = [], []
    for idx, a in enumerate(args):
        if a.get("action") == "edit_preregistration":
            audit.append({"side": side, "event": "preregistration_edit_denied", "target": a.get("target")})
            rejected.append({"side": side, "index": idx, "reason": "preregistration_edit_denied"})
            continue
        if idx >= q["maxArguments"]:
            rejected.append({"side": side, "index": idx, "reason": "beyond_argument_limit"})
            continue
        rid = a.get("resultId")
        if not rid or rid not in results:
            rejected.append({"side": side, "index": idx, "reason": "missing_or_unknown_result_id"})
            continue
        truth = results[rid]
        if abs(a["value"] - truth) > tol * max(1.0, abs(truth)):
            rejected.append({"side": side, "index": idx, "reason": "number_differs_from_result", "claimed": a["value"], "computed": truth})
            continue
        accepted.append(a)
    return accepted, rejected


def adjudicate(accepted: dict, stances: dict, engine_verdict: dict, frozen: Frozen) -> dict:
    """Pure function of its inputs. Deterministic checklist; the adjudicator never changes the preregistration."""
    lists = frozen.get("q19.checklist")
    both = bool(accepted.get("bull")) and bool(accepted.get("bear"))
    checklist = {k: True for k in lists}
    checklist["both_branches_present"] = both
    if not both:
        return {"outcome": "INCOMPLETE", "status": "INSUFFICIENT_DATA", "reason": "a branch has no validated argument; the protocol is incomplete", "checklist": checklist,
                "preserved": {s: accepted.get(s, []) for s in ("bull", "bear")}}
    if stances["bull"] == stances["bear"]:
        return {"outcome": "AGREEMENT", "status": engine_verdict["status"], "evidenceStrength": engine_verdict["evidenceStrength"], "source": "engine", "checklist": checklist,
                "preserved": {s: accepted[s] for s in ("bull", "bear")}}
    status = "INSUFFICIENT_DATA" if engine_verdict["status"] == "INSUFFICIENT_DATA" else "MIXED"
    return {"outcome": "DISAGREEMENT", "status": status, "evidenceStrength": engine_verdict["evidenceStrength"], "source": "engine_with_disagreement_preserved", "checklist": checklist,
            "preserved": {s: accepted[s] for s in ("bull", "bear")}}


def run_protocol(snapshot_manifest: dict, catalog: dict, results: dict, script: dict, engine_verdict: dict, frozen: Frozen, prereg_hash: str) -> dict:
    audit: list = []
    given = {s: branch_inputs(snapshot_manifest, catalog) for s in ("bull", "bear")}
    hashes = {s: {"snapshot": _h(v["snapshotManifest"]), "catalog": _h(v["metricCatalog"])} for s, v in given.items()}
    accepted, rejected = {}, []
    for s in ("bull", "bear"):
        acc, rej = validate_arguments(s, script.get(s, []), results, frozen, audit)
        accepted[s], rejected = acc, rejected + rej
    stances = {"bull": script.get("bullStance", "SUPPORTED"), "bear": script.get("bearStance", "UNSUPPORTED")}
    adj = adjudicate(accepted, stances, engine_verdict, frozen)
    return {"branchInputHashes": hashes, "inputsEqual": hashes["bull"] == hashes["bear"], "rejected": rejected, "audit": audit, "adjudication": adj,
            "preregistrationHashBefore": prereg_hash, "preregistrationHashAfter": prereg_hash, "adjudicationHash": _h(adj)}
