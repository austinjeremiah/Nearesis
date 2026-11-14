#!/usr/bin/env python3
"""Independent reference implementation of nearesis-verifier (valid-input path).

Written separately from the Rust code from the spec in README.md, using
Python's unbounded integers and math.isqrt, so agreement between the two is
evidence that neither has an overflow or rounding bug. It is NOT used at
runtime; it produces expected outputs/digests for the fixture suite.

Usage: reference_verifier.py < input.json   -> prints expected output JSON
"""
import hashlib
import json
import math
import sys

VERIFIER_ID = "nearesis-verifier@0.1.0"
OUTPUT_SCHEMA = "nearesis.verifier.output.v1"
MAX_OUTPUT_BYTES = 900


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha(obj):
    return hashlib.sha256(canonical(obj).encode("ascii")).hexdigest()


def rdiv(a, b):
    assert b > 0
    q = (2 * abs(a) + b) // (2 * b)
    return -q if a < 0 else q


def summary(v):
    n, total, first, last = len(v), sum(v), v[0], v[-1]
    if first == 0:
        growth = None
    else:
        q = rdiv((last - first) * 10_000, abs(first))
        growth = str(-q if first < 0 else q)
    return {
        "growth_bps": growth,
        "max": str(max(v)),
        "mean_micro": str(rdiv(total * 1_000_000, n)),
        "min": str(min(v)),
        "sum": str(total),
    }


def pearson_ppm(x, y):
    n = len(x)
    sx, sy = sum(x), sum(y)
    sxx = sum(a * a for a in x)
    syy = sum(b * b for b in y)
    sxy = sum(a * b for a, b in zip(x, y))
    num = n * sxy - sx * sy
    a = n * sxx - sx * sx
    b = n * syy - sy * sy
    if a <= 0 or b <= 0:
        return None
    den = math.isqrt(a * b)
    q = min((2 * abs(num) * 1_000_000 + den) // (2 * den), 1_000_000)
    return str(-q if num < 0 else q)


def compute_results(x, y, metrics):
    r = {"n": str(len(x))}
    lags = {}
    for m in metrics:
        if m == "summary":
            r["x"], r["y"] = summary(x), summary(y)
        elif m == "pearson":
            r["pearson_ppm"] = pearson_ppm(x, y)
        elif m.startswith("lag_pearson:"):
            k = int(m.split(":")[1])
            lags[str(k)] = pearson_ppm(x[: len(x) - k], y[k:])
        else:
            raise ValueError(m)
    if lags:
        r["lag_pearson_ppm"] = lags
    return r


def finish(out):
    out = dict(out, schema_version=OUTPUT_SCHEMA, verifier=VERIFIER_ID)
    s = canonical(out)
    if len(s) <= MAX_OUTPUT_BYTES:
        return s
    out.pop("results")
    out["results_omitted"] = True
    return canonical(out)


def verify(inp):
    x = [int(v) for _, v in inp["series"]["x"]["points"]]
    y = [int(v) for _, v in inp["series"]["y"]["points"]]
    results = compute_results(x, y, inp["metrics"])
    results_sha = sha(results)
    input_sha = sha({k: v for k, v in inp.items() if k != "expected"})
    checks = {}
    exp = inp.get("expected")
    if exp is None:
        status = "COMPUTED"
    else:
        ok = True
        if "input_sha256" in exp:
            checks["input_sha256"] = exp["input_sha256"] == input_sha
            ok &= checks["input_sha256"]
        checks["results_sha256"] = exp["results_sha256"] == results_sha
        ok &= checks["results_sha256"]
        status = "VERIFIED" if ok else "MISMATCH"
    return finish({
        "status": status,
        "claim_id": inp["claim_id"],
        "synthetic": inp["source"]["synthetic"],
        "input_sha256": input_sha,
        "results_sha256": results_sha,
        "checks": checks,
        "results": results,
    })


if __name__ == "__main__":
    sys.stdout.write(verify(json.load(sys.stdin)))
