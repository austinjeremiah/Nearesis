"""CLI: run | reproduce | live. Example (the reproduction command written into every artifact):
  cd nearesis-app && PYTHONPATH=services/research uv run python -m nearesis_research.cli run --fixture signal --seed 20261111 --out <dir>"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import METHOD_VERSION
from .artifacts import compare_runs, write_bundle
from .core import canonical_json
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


def live_run(snapshot_dir: str, out: Path) -> int:
    """Runs the preregistered analysis on a pinned live snapshot. Never overwrites an existing result directory."""
    from .live import load_snapshot_inputs

    if out.exists() and any(out.iterdir()):
        print(json.dumps({"rejected": True, "reason": "result directory exists; a changed input needs a new snapshot id, results are never overwritten", "out": str(out)}))
        return 4
    desc, ll = load_snapshot_inputs(Path(snapshot_dir))
    pre = default_prereg()
    ll.source["reproductionCommand"] = f"cd nearesis-app && PYTHONPATH=services/research uv run python -m nearesis_research.cli live --snapshot {snapshot_dir} --out <dir>"
    ll.source["liveMethodVersion"] = {"methodVersion": METHOD_VERSION, "methodRevision": METHOD_REVISION, "inputMethod": desc["inputMethod"], "snapshotId": desc["snapshotId"]}
    ll.source["registration"] = "post-hoc registration: frozen fixture-evaluation parameters applied unchanged to this live window; live-study fields (cut-off, hypothesis) are not frozen and no chain commitment exists"
    art = run_experiment(ll.inputs, pre, ll.source)
    p = write_bundle(art, out)
    summary = {
        "snapshotId": desc["snapshotId"], "status": art["status"], "evidenceStrength": art["evidenceStrength"], "complete": art["inputSnapshot"]["complete"],
        "window": desc["window"], "developmentRows": art["inputSnapshot"]["developmentRows"], "lockbox": art["inputSnapshot"]["lockbox"], "postRegimeRows": art["inputSnapshot"]["postRegimeRows"],
        "devScoredOrigins": art["windows"]["development"]["scoredOrigins"], "reasons": art["verdict"]["reasons"], "bundle": str(p), "methodRevision": METHOD_REVISION, "inputMethod": desc["inputMethod"],
        "primary": {k: art["estimates"]["primary"].get(k) for k in ("n_origins", "mae_baseline", "mae_candidate", "delta_mae", "relative_improvement", "delta_mae_ci", "p_raw")},
        "inferenceConclusion": art["estimates"]["primary"].get("inference", {}).get("conclusion"),
        "inferenceSummary": art["estimates"]["inferenceSummary"]["primaryStatisticalClaim"],
    }
    from .frozen import load_frozen
    from .robustness import run_matrix

    # frozen Q18 robustness matrix on the development window only (the lockbox is never read); descriptive, not part of the verdict
    (out / "robustness_matrix.json").write_text(canonical_json({"snapshotId": desc["snapshotId"], "note": "development window only; descriptive; frozen variant list", **run_matrix(ll.inputs, None, load_frozen())}) + "\n")
    (out / "run_summary.json").write_text(canonical_json(summary) + "\n")
    print(json.dumps(summary))
    return 0


# Analysis revision of the engine. methodVersion (near.intents_pred_v1@1.0.0) is frozen by the preregistration hash, so
# the revision is what distinguishes engine behaviour changes: a001 = pre-Amendment-002 (no inference records),
# a002 = Amendment 002 (fixed-smoothing inference records and inferenceSummary).
METHOD_REVISION = "a002"


def recorded_method_revision(run: dict) -> str:
    return "a002" if "inferenceSummary" in (run.get("estimates") or {}) else "a001"


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
    lf = sub.add_parser("live-freeze")
    lf.add_argument("--out-root", required=True)
    lf.add_argument("--start", default=None)
    lf.add_argument("--end", default=None)
    lv = sub.add_parser("live")
    lv.add_argument("--snapshot", required=True, help="pinned snapshot directory written by live-freeze")
    lv.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "run":
        art = run_fixture(a.fixture, a.seed)
        p = write_bundle(art, Path(a.out))
        print(json.dumps({"status": art["status"], "evidenceStrength": art["evidenceStrength"], "bundle": str(p), "narrative": render_narrative(art)}))
        return 0
    if a.cmd == "reproduce":
        old = json.loads((Path(a.dir) / "research_run.json").read_text())
        rec_rev = recorded_method_revision(old)
        if rec_rev != METHOD_REVISION:
            # A capsule pins the method it was built with: a different engine revision is a named mismatch, never a silent diff.
            print(json.dumps({"reproducible": False, "reason": "METHOD_VERSION_MISMATCH", "recordedMethodVersion": old.get("methodVersion"), "recordedMethodRevision": rec_rev, "currentMethodVersion": METHOD_VERSION, "currentMethodRevision": METHOD_REVISION}))
            return 4
        src = old["inputSnapshot"]["source"]
        new = run_fixture(src["fixture"], old["reproduction"]["seed"])
        res = compare_runs(old, new)
        print(json.dumps(res))
        return 0 if res["reproducible"] else 3
    if a.cmd == "g07-run":
        return g07_run(a)
    if a.cmd == "live-freeze":
        from .live import freeze_live_snapshot

        d = freeze_live_snapshot(Path(a.out_root), a.start, a.end)
        print(json.dumps({"snapshotId": d["snapshotId"], "dir": d["dir"], "reused": d["reused"], "window": d["window"], "dataHash": d["dataHash"]}))
        return 0
    if a.cmd == "live":
        return live_run(a.snapshot, Path(a.out))
    return 2


if __name__ == "__main__":
    sys.exit(main())
