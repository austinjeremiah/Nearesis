#!/usr/bin/env python3
"""Run the compiled WASM against every fixture under a WASI runtime.

Checks, per fixture:
  * valid fixtures: WASM stdout is byte-identical to the independent Python
    reference output (manifest.json `expected_output`)
  * invalid fixtures: status INVALID_INPUT with the expected error code
  * every output <= 900 bytes, exit code 0, empty stderr
  * determinism: each fixture is run RUNS times; all outputs identical
  * instruction budget: run under wasmtime fuel = OutLayer default limit

Usage: run_wasm_tests.py <wasmtime-binary> <file.wasm> [--runs N] [--fuel N]
Writes a JSON result to stdout; exit code 1 on any failure.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "fixtures")


def run(wasmtime, wasm, data, fuel):
    cmd = [wasmtime, "run"]
    if fuel:
        cmd += ["-W", f"fuel={fuel}"]
    cmd.append(wasm)
    p = subprocess.run(cmd, input=data, capture_output=True, timeout=120)
    return p.returncode, p.stdout, p.stderr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wasmtime")
    ap.add_argument("wasm")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--fuel", type=int, default=1_000_000_000)
    a = ap.parse_args()

    wasm_bytes = open(a.wasm, "rb").read()
    version = subprocess.run([a.wasmtime, "--version"], capture_output=True, text=True).stdout.strip()
    manifest = json.load(open(os.path.join(FIX, "manifest.json")))
    results, failures = [], 0
    for e in manifest["fixtures"]:
        data = open(os.path.join(FIX, e["fixture"]), "rb").read()
        outs = [run(a.wasmtime, a.wasm, data, a.fuel) for _ in range(a.runs)]
        rc, out, err = outs[0]
        problems = []
        if any(o != outs[0] for o in outs[1:]):
            problems.append("nondeterministic")
        if rc != 0:
            problems.append(f"exit={rc} stderr={err[:300]!r}")
        if err:
            problems.append(f"stderr={err[:300]!r}")
        if len(out) > 900:
            problems.append(f"output {len(out)} bytes > 900")
        try:
            got = json.loads(out)
        except Exception:
            got = None
            problems.append(f"stdout not JSON: {out[:200]!r}")
        if got is not None:
            if got.get("status") != e["status"]:
                problems.append(f"status {got.get('status')} != {e['status']}")
            if "code" in e and got.get("error", {}).get("code") != e["code"]:
                problems.append(f"code {got.get('error')} != {e['code']}")
            if "expected_output" in e and out.decode() != e["expected_output"]:
                problems.append("output differs from Python reference")
        failures += bool(problems)
        results.append({
            "fixture": e["fixture"], "pass": not problems, "problems": problems,
            "status": got.get("status") if got else None, "output_bytes": len(out),
            "output_sha256": hashlib.sha256(out).hexdigest(),
        })
    report = {
        "runtime": version, "wasm_sha256": hashlib.sha256(wasm_bytes).hexdigest(),
        "wasm_bytes": len(wasm_bytes), "fuel_limit": a.fuel, "runs_per_fixture": a.runs,
        "passed": len(results) - failures, "failed": failures, "results": results,
    }
    json.dump(report, sys.stdout, indent=1)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
