"""Quant supervisor (ch.08 quant process isolation, ch.16b Q21). Jobs are declarative manifests; the supervisor runs the
fixed worker in a network-disabled, read-only, non-root container with CPU, memory and time budgets, and promotes staged
outputs only if every declared output exists, nothing undeclared is present and every hash matches. Manifests carrying code
are rejected before anything runs. `agent_submit` is the agent-facing interface."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import time
import uuid
from pathlib import Path

from .frozen import Frozen

WORKER = Path(__file__).resolve().parents[1] / "quant_worker" / "worker.mjs"
KINDS = {"egress", "canary", "write_snapshot", "alloc", "loop", "identity", "sum", "truncate"}
FORBIDDEN_KEYS = {"code", "source", "python", "script", "command", "cmd", "exec", "eval", "shell", "args", "entrypoint", "image", "dockerfile"}
CODE_RE = re.compile(r"(\bimport\b|\bdef\b|\blambda\b|__\w+__|\bexec\s*\(|\beval\s*\(|subprocess|os\.system|\bopen\s*\(|\bprint\s*\(|;\s*\w+\s*=|\n)")
SAFE_STR = re.compile(r"^[A-Za-z0-9_.\-:/]{0,64}$")


class JobRejected(ValueError):
    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code, self.detail = code, detail


def validate_job_manifest(m: dict) -> dict:
    """Closed declarative schema: {jobId, kind, params}; params are numbers, short safe strings, or lists of numbers."""
    if not isinstance(m, dict):
        raise JobRejected("schema_violation", "manifest must be an object")
    for k in m:
        if k.lower() in FORBIDDEN_KEYS:
            raise JobRejected("code_content", f"key '{k}' is not allowed in a declarative job")
    unknown = set(m) - {"jobId", "kind", "params"}
    if unknown:
        raise JobRejected("schema_violation", f"unknown keys {sorted(unknown)}")
    if m.get("kind") not in KINDS:
        raise JobRejected("schema_violation", f"kind must be one of {sorted(KINDS)}")

    def check(v, path):
        if isinstance(v, bool) or v is None:
            return
        if isinstance(v, (int, float)):
            return
        if isinstance(v, str):
            if CODE_RE.search(v):
                raise JobRejected("code_content", f"value at {path} looks like source code")
            if not SAFE_STR.match(v):
                raise JobRejected("schema_violation", f"value at {path} has characters outside the allowed set")
            return
        if isinstance(v, list):
            for i, x in enumerate(v):
                check(x, f"{path}[{i}]")
            return
        if isinstance(v, dict):
            for k, x in v.items():
                if k.lower() in FORBIDDEN_KEYS:
                    raise JobRejected("code_content", f"key '{path}.{k}' is not allowed")
                check(x, f"{path}.{k}")
            return
        raise JobRejected("schema_violation", f"unsupported value type at {path}")

    check(m.get("params", {}), "params")
    return m


def agent_submit(manifest: dict, runner=None) -> dict:
    """Agent-facing job tool. Code content gets HTTP 422 and nothing is executed."""
    try:
        validate_job_manifest(manifest)
    except JobRejected as e:
        return {"status": 422, "error": e.code, "detail": e.detail, "executed": False}
    return {"status": 202, "accepted": True, "executed": False if runner is None else True, "result": None if runner is None else runner(manifest)}


def tree_digest(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            h.update(str(p.relative_to(root)).encode() + b"\0" + p.read_bytes() + b"\0")
    return "sha256:" + h.hexdigest()


def _file_hash(p: Path) -> str:
    return "sha256:" + hashlib.sha256(p.read_bytes()).hexdigest()


def docker_available() -> tuple[bool, str]:
    try:
        r = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], capture_output=True, text=True, timeout=20)
        return r.returncode == 0, r.stdout.strip() or r.stderr.strip()[:200]
    except Exception as e:  # pragma: no cover
        return False, str(e)


def run_job(manifest: dict, frozen: Frozen, snapshot: Path, staging: Path, network: str | None = None, env: dict | None = None) -> dict:
    """Runs one validated job in the sandbox. `network` overrides the frozen 'none' ONLY for a negative-control run."""
    validate_job_manifest(manifest)
    q = frozen.get("q21")
    staging.mkdir(parents=True, exist_ok=True)
    name = f"nearesis-q21-{uuid.uuid4().hex[:10]}"
    profile = {
        "image": q["image"], "network": network or q["network"], "readOnlyRootfs": q["readOnlyRootfs"], "user": q["user"], "memoryMb": q["memoryMb"],
        "cpus": q["cpus"], "pidsLimit": q["pidsLimit"], "capDropAll": True, "noNewPrivileges": True, "timeBudgetSeconds": q["timeBudgetSeconds"],
    }
    cmd = ["docker", "run", "--name", name, "--network", profile["network"], "--user", q["user"], "--memory", f"{q['memoryMb']}m", "--memory-swap", f"{q['memoryMb']}m",
           "--cpus", str(q["cpus"]), "--pids-limit", str(q["pidsLimit"]), "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
           "--tmpfs", "/tmp:size=16m", "-v", f"{snapshot}:/snapshot:ro", "-v", f"{staging}:/staging:rw", "-v", f"{WORKER}:/worker/worker.mjs:ro", "-w", "/tmp"]
    if q["readOnlyRootfs"]:
        cmd.insert(2, "--read-only")
    for k, v in (env or {}).items():
        cmd += ["-e", f"{k}={v}"]
    cmd += [q["image"], "node", "/worker/worker.mjs", manifest["kind"], json.dumps(manifest.get("params", {}))]
    t0 = time.monotonic()
    killed_for = None
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            stdout, stderr = p.communicate(timeout=q["timeBudgetSeconds"] + 20 if manifest["kind"] != "loop" else q["timeBudgetSeconds"])
        except subprocess.TimeoutExpired:
            killed_for = "time_budget_exceeded"
            subprocess.run(["docker", "kill", name], capture_output=True, timeout=30)
            stdout, stderr = p.communicate(timeout=30)
        oom = False
        insp = subprocess.run(["docker", "inspect", "--format", "{{.State.OOMKilled}}|{{.State.ExitCode}}", name], capture_output=True, text=True, timeout=30)
        parts = insp.stdout.strip().split("|")
        oom = parts[0] == "true"
        exit_code = int(parts[1]) if len(parts) > 1 and parts[1].lstrip("-").isdigit() else p.returncode
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=30)
    reason = killed_for or ("memory_budget_exceeded" if oom or exit_code == 137 else None)
    lines = [json.loads(x) for x in stdout.splitlines() if x.strip().startswith("{")]
    return {"kind": manifest["kind"], "exitCode": exit_code, "reason_code": reason, "elapsedSeconds": round(time.monotonic() - t0, 2), "output": lines[-1] if lines else None,
            "stderrTail": stderr[-200:], "profile": profile}


def promote(staging: Path, promoted: Path, declared_outputs: list[str]) -> dict:
    """Hash-completeness check before promotion. All or nothing."""
    problems = []
    hf = staging / "hashes.json"
    declared = json.loads(hf.read_text()) if hf.exists() else {}
    if not hf.exists():
        problems.append({"problem": "hashes_missing"})
    files = {p.name for p in staging.iterdir() if p.is_file() and p.name != "hashes.json"}
    for o in declared_outputs:
        if o not in files:
            problems.append({"problem": "declared_output_missing", "file": o})
        elif o not in declared:
            problems.append({"problem": "hash_missing", "file": o})
        elif declared[o] != _file_hash(staging / o):
            problems.append({"problem": "hash_mismatch", "file": o})
    for f in sorted(files - set(declared_outputs)):
        problems.append({"problem": "unlisted_output", "file": f})
    if problems:
        return {"promoted": False, "problems": problems}
    promoted.mkdir(parents=True, exist_ok=True)
    for o in declared_outputs:
        shutil.copy2(staging / o, promoted / o)
    return {"promoted": True, "files": declared_outputs, "problems": []}
