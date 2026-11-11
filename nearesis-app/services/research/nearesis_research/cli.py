"""CLI: run | reproduce | live. Example (the reproduction command written into every artifact):
  cd nearesis-app && PYTHONPATH=services/research uv run python -m nearesis_research.cli run --fixture signal --seed 20261111 --out <dir>"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .artifacts import compare_runs, write_bundle
from .dataset import Inputs
from .experiment import run_experiment
from .fixtures import make_fixture
from .narrative import facts_of, render_narrative
from .prereg import default_prereg


def repro_cmd(kind: str, seed: int, out: str = "<dir>") -> str:
    return f"cd nearesis-app && PYTHONPATH=services/research uv run python -m nearesis_research.cli run --fixture {kind} --seed {seed} --out {out}"


def run_fixture(kind: str, seed: int) -> dict:
    pre = default_prereg(seed)
    fx = make_fixture(kind, seed)
    src = {"label": fx.label, "fixture": kind, "fixtureHash": fx.hash, "truth": fx.truth, "reproductionCommand": repro_cmd(kind, seed)}
    return run_experiment(Inputs(fx.daily, fx.accounts), pre, src)


def g07_run(a) -> int:
    """Q20 audit run: experiment, manifest, THESIS.md, chart vectors and environment record in one directory. With
    --audit-replay-of the run is recorded as an audit replay and rejected if its configuration differs from the original."""
    from .frozen import load_frozen
    from .manifest import build_manifest, chart_vectors, config_hash, environment_record
    from .thesis import generate_thesis

    frozen = load_frozen()
    fx = make_fixture(a.fixture, a.seed)
    cfg = config_hash(frozen, a.fixture, a.seed, fx.hash)
    if a.audit_replay_of is not None and a.audit_replay_of != cfg:
        print(json.dumps({"rejected": True, "reason": "audit replay refused: configuration differs from the original", "configHash": cfg, "original": a.audit_replay_of}))
        return 4
    art = run_fixture(a.fixture, a.seed)
    frozen.record_result(f"g07-run:{a.fixture}:{a.seed}", kind="audit_replay" if a.audit_replay_of else "evaluation", configHash=cfg)
    out = Path(a.out)
    write_bundle(art, out, newline=False)
    (out / "manifest.json").write_text(json.dumps(build_manifest(art, frozen), sort_keys=True))
    (out / "THESIS.md").write_text(generate_thesis(art, frozen))
    (out / "chart_vectors.json").write_text(json.dumps(chart_vectors(art)))
    rec = {"configHash": cfg, "seed": a.seed, "fixture": a.fixture, "audit_replay": a.audit_replay_of is not None, "countsAsIndependentEvaluation": a.audit_replay_of is None,
           "environment": environment_record(), "registrationLabel": frozen.registration_label}
    (out / "run_record.json").write_text(json.dumps(rec, sort_keys=True))
    print(json.dumps({"ok": True, **rec}))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="nearesis_research")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--fixture", choices=["signal", "nosignal"], required=True)
    r.add_argument("--seed", type=int, default=20261111)
    r.add_argument("--out", required=True)
    rp = sub.add_parser("reproduce")
    rp.add_argument("--dir", required=True)
    g = sub.add_parser("g07-run")
    g.add_argument("--fixture", choices=["signal", "nosignal"], required=True)
    g.add_argument("--seed", type=int, default=20261111)
    g.add_argument("--out", required=True)
    g.add_argument("--audit-replay-of", default=None)
    g.add_argument("--tolerance", type=float, default=None)
    lv = sub.add_parser("live")
    lv.add_argument("--start", required=True)
    lv.add_argument("--end", required=True)
    lv.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "run":
        art = run_fixture(a.fixture, a.seed)
        p = write_bundle(art, Path(a.out))
        print(json.dumps({"status": art["status"], "evidenceStrength": art["evidenceStrength"], "bundle": str(p), "narrative": render_narrative(art)}))
        return 0
    if a.cmd == "reproduce":
        old = json.loads((Path(a.dir) / "research_run.json").read_text())
        src = old["inputSnapshot"]["source"]
        new = run_fixture(src["fixture"], old["reproduction"]["seed"])
        res = compare_runs(old, new)
        print(json.dumps(res))
        return 0 if res["reproducible"] else 3
    if a.cmd == "g07-run":
        return g07_run(a)
    if a.cmd == "live":
        from .live import load_live

        ll = load_live(a.start, a.end)
        pre = default_prereg()
        ll.source["reproductionCommand"] = f"cd nearesis-app && PYTHONPATH=services/research uv run python -m nearesis_research.cli live --start {a.start} --end {a.end} --out <dir>"
        art = run_experiment(ll.inputs, pre, ll.source)
        p = write_bundle(art, Path(a.out))
        print(json.dumps({"status": art["status"], "complete": art["inputSnapshot"]["complete"], "reasons": art["verdict"]["reasons"], "bundle": str(p)}))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
