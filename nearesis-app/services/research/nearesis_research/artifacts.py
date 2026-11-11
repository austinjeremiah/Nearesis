"""Write/read artifact bundles and verify reproduction."""

from __future__ import annotations

import json
import math
from pathlib import Path

from .core import canonical_json, json_hash

SECTION_KEYS = ["hypothesis", "preregistration", "inputSnapshot", "features", "models", "windows", "estimates", "uncertainty", "counterevidence", "limitations", "falsification", "reproduction"]


def write_bundle(artifact: dict, out: Path) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    for k in SECTION_KEYS:
        (out / f"{k}.json").write_text(canonical_json(artifact[k]) + "\n")
    (out / "research_run.json").write_text(canonical_json(artifact) + "\n")
    return out / "research_run.json"


def numeric_leaves(o, path=""):
    if isinstance(o, dict):
        for k, v in o.items():
            yield from numeric_leaves(v, f"{path}/{k}")
    elif isinstance(o, list):
        for i, v in enumerate(o):
            yield from numeric_leaves(v, f"{path}[{i}]")
    elif isinstance(o, float) and not isinstance(o, bool):
        yield path, o


def compare_runs(a: dict, b: dict, atol: float = 1e-9) -> dict:
    """Exact canonical-JSON hash match of every section, or numeric match within `atol` for floating-point leaves."""
    ha, hb = a["artifactHashes"], b["artifactHashes"]
    exact = ha == hb
    worst = 0.0
    la, lb = dict(numeric_leaves(a)), dict(numeric_leaves(b))
    if set(la) != set(lb):
        return {"reproducible": False, "exactHashMatch": False, "maxAbsDiff": None, "reason": "structure differs"}
    for k, v in la.items():
        if math.isnan(v) != math.isnan(lb[k]):
            return {"reproducible": False, "exactHashMatch": False, "maxAbsDiff": None, "reason": f"nan mismatch {k}"}
        if not math.isnan(v):
            worst = max(worst, abs(v - lb[k]))
    same_status = a["status"] == b["status"]
    return {"reproducible": bool(worst <= atol and same_status), "exactHashMatch": exact, "maxAbsDiff": worst, "statusMatch": same_status}
