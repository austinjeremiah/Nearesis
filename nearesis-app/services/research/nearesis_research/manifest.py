"""Experiment registry record (ch.08), its completeness validator and the audit comparison for Q20."""

from __future__ import annotations

import hashlib
import json
import math
import platform
import sys
from pathlib import Path

from . import METHOD_VERSION
from .core import json_hash
from .frozen import Frozen, APP_ROOT
from .thesis import parse_claim_table, parse_sections

SECTION_KEYS = ["hypothesis", "preregistration", "inputSnapshot", "features", "models", "windows", "estimates", "uncertainty", "counterevidence", "limitations", "falsification", "reproduction"]


def build_manifest(artifact: dict, frozen: Frozen) -> dict:
    """Concretises the ch.08 registry schema from an actual run; nothing is copied from the documentation sample."""
    rb = (artifact["falsification"].get("robustness") or {}).get("checks", {})
    return {
        "experimentId": artifact["experimentId"],
        "preregistrationHash": frozen.doc_hash,
        "rawSnapshotHash": artifact["inputSnapshot"]["datasetHash"],
        "metricVersionMap": {"near.intents_pred": METHOD_VERSION.split("@")[1], "research-artifacts": artifact["schemaVersion"].split("@")[1]},
        "split": {"method": artifact["windows"]["design"], "holdoutStart": artifact["windows"]["development"]["lastOrigin"], "lockboxRows": artifact["windows"]["lockbox"]["n"]},
        "models": list(artifact["models"]["classes"]),
        "primaryLoss": artifact["preregistration"]["loss"],
        "checks": sorted(rb) or ["none_computed"],
        "limitations": list(artifact["limitations"]),
        "artifactHashes": dict(artifact["artifactHashes"]),
    }


def _walk(o, path=""):
    if isinstance(o, dict):
        for k, v in o.items():
            yield from _walk(v, f"{path}.{k}" if path else k)
    elif isinstance(o, list):
        for i, v in enumerate(o):
            yield from _walk(v, f"{path}[{i}]")
    else:
        yield path, o


def validate_manifest(m: dict, frozen: Frozen) -> list[dict]:
    q = frozen.get("q20")
    fails = []
    for f in q["manifestFields"]:
        if f not in m:
            fails.append({"field": f, "problem": "missing"})
    for path, v in _walk(m):
        if v is None:
            fails.append({"field": path, "problem": "null"})
        if isinstance(v, str) and any(p in v for p in q["placeholderPatterns"]):
            fails.append({"field": path, "problem": "placeholder"})
        if isinstance(v, str) and v.strip() == "":
            fails.append({"field": path, "problem": "empty string"})
    if not m.get("artifactHashes"):
        fails.append({"field": "artifactHashes", "problem": "empty"})
    for f in ("metricVersionMap", "models", "checks", "limitations"):
        if f in m and not m[f]:
            fails.append({"field": f, "problem": "empty"})
    return fails


def verify_file_hashes(manifest: dict, bundle_dir: Path) -> dict:
    """Each artifactHashes entry must equal the SHA-256 of its file's bytes (files are written without a terminator)."""
    res = {}
    for k, want in manifest["artifactHashes"].items():
        got = "sha256:" + hashlib.sha256((bundle_dir / f"{k}.json").read_bytes()).hexdigest()
        res[k] = {"expected": want, "actual": got, "ok": want == got}
    return res


def first_difference(a, b, atol: float, path: str = "") -> dict | None:
    """Deep comparison: exact for non-floats, within `atol` for floats. Returns the first differing field or None."""
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return {"field": f"{path}/{k}", "a": a.get(k, "<absent>"), "b": b.get(k, "<absent>")}
            d = first_difference(a[k], b[k], atol, f"{path}/{k}")
            if d:
                return d
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return {"field": f"{path}.length", "a": len(a), "b": len(b)}
        for i, (x, y) in enumerate(zip(a, b)):
            d = first_difference(x, y, atol, f"{path}[{i}]")
            if d:
                return d
        return None
    if isinstance(a, float) and isinstance(b, (float, int)) and not isinstance(b, bool) or isinstance(b, float) and isinstance(a, int) and not isinstance(a, bool):
        if a is None or b is None or (isinstance(a, float) and math.isnan(a)) != (isinstance(b, float) and math.isnan(b)):
            return {"field": path, "a": a, "b": b}
        return None if abs(float(a) - float(b)) <= atol else {"field": path, "a": a, "b": b}
    return None if a == b else {"field": path, "a": a, "b": b}


def chart_vectors(artifact: dict) -> dict:
    lag = (artifact["falsification"].get("lagComparison") or {})
    by = artifact["estimates"]["byHorizonCandidate"]
    return {
        "lagDeltaMae": [lag[k]["delta_mae"] if lag[k].get("status") == "OK" else None for k in sorted(lag, key=int)],
        "horizonCandidateDeltaMae": [by[k].get("delta_mae") for k in sorted(by)],
        "horizonCandidateRelative": [by[k].get("relative_improvement") for k in sorted(by)],
        "primaryCI": [(artifact["uncertainty"]["deltaMaeCI"] or {}).get("lo"), (artifact["uncertainty"]["deltaMaeCI"] or {}).get("hi")],
    }


def thesis_cells(md: str) -> list[list[str]]:
    d = dict(parse_sections(md))
    return [list(r.values()) for r in parse_claim_table(d.get("Verdict per claim", ""))]


def environment_record() -> dict:
    import numpy, pandas, scipy, sklearn, statsmodels

    lock = APP_ROOT / "uv.lock"
    return {
        "lockHash": "sha256:" + hashlib.sha256(lock.read_bytes()).hexdigest(),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "libraries": {"numpy": numpy.__version__, "pandas": pandas.__version__, "scipy": scipy.__version__, "statsmodels": statsmodels.__version__, "scikit-learn": sklearn.__version__},
        "root": str(APP_ROOT),
        "prefix": sys.prefix,
    }


def config_hash(frozen: Frozen, fixture: str, seed: int, fixture_hash: str) -> str:
    return "sha256:" + json_hash({"documentHash": frozen.doc_hash, "fixture": fixture, "seed": seed, "fixtureHash": fixture_hash, "tolerance": frozen.get("q20.tolerance")})
