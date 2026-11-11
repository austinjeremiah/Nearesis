"""THESIS.md generator and structural validator (ch.19 mandatory structure, ch.02 claim table, ch.16b Q22).
Every number comes from the research artifact; nothing is written by a language model."""

from __future__ import annotations

import re

from .frozen import Frozen
from .verdict import grade

RESULT_ID = re.compile(r"res\.[A-Za-z0-9_.:\-]+")


def result_ids(artifact: dict) -> dict[str, float | None]:
    """Index of computed results addressable from THESIS.md."""
    eid = artifact["experimentId"].split("@")[0]
    ids: dict[str, float | None] = {}
    for k, r in artifact["estimates"]["byHorizonCandidate"].items():
        h, c = k.split(":")
        ids[f"res.{eid}.{c}.h{h}.delta_mae"] = r.get("delta_mae")
        ids[f"res.{eid}.{c}.h{h}.relative_improvement"] = r.get("relative_improvement")
        ids[f"res.{eid}.{c}.h{h}.p_adjusted"] = r.get("p_adjusted")
    h = artifact["estimates"]["holdout"] or {}
    ids[f"res.{eid}.holdout.relative_improvement"] = h.get("relative_improvement")
    ids[f"res.{eid}.holdout.n"] = h.get("n_origins")
    pl = artifact["falsification"].get("placebo") or {}
    ids[f"res.{eid}.placebo.p_value"] = pl.get("p_value")
    rb = artifact["falsification"].get("robustness") or {}
    ids[f"res.{eid}.robustness.agree_share"] = rb.get("agree_share")
    return ids


def _fmt(v, nd=4) -> str:
    return "n/a" if v is None else f"{v:.{nd}f}"


def claims_of(artifact: dict, frozen: Frozen) -> list[dict]:
    eid = artifact["experimentId"].split("@")[0]
    thr = frozen.get("experiment.thresholds")
    pc, ph = artifact["hypothesis"]["primaryComparison"].split(" ")[0], artifact["hypothesis"]["primaryHorizon"]
    rows = []
    counter = artifact["counterevidence"]
    for f in frozen.get("experiment.testFamily"):
        c, h = f["candidate"], f["horizon"]
        r = artifact["estimates"]["byHorizonCandidate"][f"{h}:{c}"]
        rid = f"res.{eid}.{c}.h{h}"
        is_primary = c == pc and h == ph
        if is_primary:
            verdict = artifact["status"]
        else:
            n = r.get("n_origins", 0)
            lo = (r.get("delta_mae_ci") or {}).get("lo")
            dev = bool(n >= thr["minDevOrigins"] and r.get("fdr_reject") and (r.get("relative_improvement") or 0) >= thr["minRelativeImprovement"] and lo is not None and lo > 0)
            verdict = grade({"enoughDevOrigins": n >= thr["minDevOrigins"], "devPass": dev, "holdout": "none"}, frozen)["status"]
        mine = [e for e in counter if e.get("candidate") == c and e.get("horizon") == h]
        if mine:
            e = mine[0]
            counterexample = f"{e['kind'].replace('_', ' ')} for {c} at {h} days ({rid}.p_adjusted = {_fmt(e.get('p_adjusted'))})"
        else:
            lo = (r.get("delta_mae_ci") or {}).get("lo")
            counterexample = f"the lower interval bound {_fmt(lo)} is the smallest effect compatible with the data ({rid}.delta_mae)"
        ci = r.get("delta_mae_ci") or {}
        rows.append({
            "claim": f"{c} versus baseline at {h} days{' (primary)' if is_primary else ''}",
            "verdict": verdict,
            "estimate": f"delta MAE {_fmt(r.get('delta_mae'))}, relative {_fmt(r.get('relative_improvement'))} [{rid}.delta_mae]",
            "uncertainty": f"{int((ci.get('level') or 0) * 100)}% block-bootstrap interval {_fmt(ci.get('lo'))} to {_fmt(ci.get('hi'))}",
            "counterexample": counterexample,
            "falsificationCondition": f"rejected if lockbox relative improvement stays below {thr['minRelativeImprovement']} or the placebo p-value exceeds {thr['placebo']['alpha']} [{rid}.relative_improvement]",
            "provenance": f"preregistration {frozen.doc_hash[:19]}; dataset {artifact['inputSnapshot']['datasetHash'][:19]}; {rid}",
        })
    return rows


def generate_thesis(artifact: dict, frozen: Frozen) -> str:
    sections = frozen.get("q22.sections")
    fields = frozen.get("q22.claimFields")
    eid = artifact["experimentId"].split("@")[0]
    status, strength = artifact["status"], artifact["evidenceStrength"]
    p = artifact["estimates"]["primary"]
    cl = claims_of(artifact, frozen)
    thr_ = frozen.get("experiment.thresholds")
    pid = f"res.{eid}.intents.h{artifact['hypothesis']['primaryHorizon']}"
    if status == "SUPPORTED":
        execu = (f"Verdict {status} ({strength}): lagged Intents volume improved out-of-sample forecasts of organic activity by {_fmt((p.get('relative_improvement') or 0) * 100, 1)}% "
                 f"over the baseline [{pid}.relative_improvement]. This is a predictive result and not a causal claim.")
    else:
        execu = (f"Verdict {status} ({strength}): the preregistered comparison does not establish a forecasting gain from lagged Intents volume "
                 f"[{pid}.delta_mae = {_fmt(p.get('delta_mae'))}]. No improvement is claimed. This is a predictive analysis and not a causal claim.")
    change = [
        f"- Lockbox relative improvement below {thr_['minRelativeImprovement']} [res.{eid}.holdout.relative_improvement]",
        f"- Placebo p-value above {thr_['placebo']['alpha']} [res.{eid}.placebo.p_value]",
        f"- A sign flip in any robustness variant [res.{eid}.robustness.agree_share]",
    ]
    against = [f"- {e['kind'].replace('_', ' ')}" + (f" for {e['candidate']} at {e['horizon']} days [res.{eid}.{e['candidate']}.h{e['horizon']}.p_adjusted]" if "candidate" in e else (f" ({e['check']})" if "check" in e else "")) for e in artifact["counterevidence"]]
    if not against:
        against = [f"- no contradicting result was computed; the weakest interval bound is {_fmt((p.get('delta_mae_ci') or {}).get('lo'))} [{pid}.delta_mae]"]
    forr = [f"- primary delta MAE {_fmt(p.get('delta_mae'))} over {p.get('n_origins')} origins [{pid}.delta_mae]"]
    body = {
        "Executive claim": execu,
        "What would change our mind": "\n".join(change),
        "Sample and sources": f"Label {artifact['inputSnapshot']['label']}; dataset {artifact['inputSnapshot']['datasetHash']}; {artifact['inputSnapshot']['developmentRows']} development rows. {artifact['claimScope']}.",
        "Methods": "Rolling-origin expanding evaluation, ridge models on log1p features, moving-block bootstrap, Benjamini-Hochberg FDR over a frozen family, lockbox holdout. Predictive testing only; causality is excluded from the claim.",
        "Primary benchmark": f"Baseline versus intents at {artifact['hypothesis']['primaryHorizon']} day(s): MAE {_fmt(p.get('mae_baseline'))} versus {_fmt(p.get('mae_candidate'))} [{pid}.delta_mae].",
        "Evidence for": "\n".join(forr),
        "Evidence against": "\n".join(against),
        "Confounders and blind spots": "\n".join(f"- {x}" for x in artifact["limitations"]),
        "Long-term economic mechanisms": "Not computed. Mechanisms are hypotheses outside this evidence and make no claim here.",
        "Verdict per claim": "",
        "Reproduction": f"`{artifact['reproduction'].get('command')}` seed {artifact['reproduction']['seed']}; preregistration {frozen.doc_hash}.",
        "Unable to compute": "\n".join(f"- {e['check']}: {e['status']}" for e in artifact["counterevidence"] if e.get("kind") == "untestable") or "- none",
        "Source index": f"- research artifact {artifact['experimentId']}; artifact hashes {len(artifact['artifactHashes'])} sections",
        "Changes since previous version": "First generated version.",
    }
    header = "| Claim | " + " | ".join(fields) + " |\n|" + "---|" * (len(fields) + 1)
    table = [header] + ["| " + c["claim"] + " | " + " | ".join(str(c[f]).replace("|", "/") for f in fields) + " |" for c in cl]
    body["Verdict per claim"] = "\n".join(table)
    return "# THESIS\n\n" + "\n\n".join(f"## {s}\n\n{body[s]}" for s in sections) + "\n"


def parse_sections(md: str) -> list[tuple[str, str]]:
    parts = re.split(r"^## (.+)$", md, flags=re.M)
    return [(parts[i].strip(), parts[i + 1].strip()) for i in range(1, len(parts) - 1, 2)]


def parse_claim_table(section: str) -> list[dict]:
    lines = [ln for ln in section.splitlines() if ln.strip().startswith("|")]
    if len(lines) < 3:
        return []
    head = [c.strip() for c in lines[0].strip().strip("|").split("|")]
    out = []
    for ln in lines[2:]:
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        out.append(dict(zip(head, cells)))
    return out


def causal_scan(md: str, frozen: Frozen) -> list[dict]:
    q = frozen.get("q22")
    hits = []
    for sent in re.split(r"(?<=[.!?])\s+|\n", md):
        s = sent.lower()
        for term in q["causalTerms"]:
            if re.search(rf"\b{re.escape(term)}\b", s) and not any(a in s for a in q["causalAllowlist"]):
                hits.append({"term": term, "sentence": sent.strip()[:160]})
    return hits


def validate_thesis(md: str, artifact: dict, frozen: Frozen) -> dict:
    q = frozen.get("q22")
    fails: list[dict] = []
    secs = parse_sections(md)
    names = [n for n, _ in secs]
    for s in q["sections"]:
        if s not in names:
            fails.append({"rule": "missing_section", "detail": s})
    if not fails and [n for n in names if n in q["sections"]] != q["sections"]:
        fails.append({"rule": "section_order", "detail": str(names)})
    d = dict(secs)
    valid_ids = set(result_ids(artifact))
    for name in ("Evidence against", "What would change our mind"):
        body = d.get(name, "")
        if name in d and not body.strip():
            fails.append({"rule": "empty_section", "detail": name})
        elif name in d:
            refs = [r.rstrip(".") for r in RESULT_ID.findall(body)]
            if not refs or not all(r in valid_ids for r in refs):
                fails.append({"rule": "no_computed_result_reference", "detail": name})
    if "Verdict per claim" in d:
        table = parse_claim_table(d["Verdict per claim"])
        if not table:
            fails.append({"rule": "claim_table_missing", "detail": "Verdict per claim"})
        for i, row in enumerate(table):
            for f in q["claimFields"]:
                if not row.get(f, "").strip():
                    fails.append({"rule": "claim_field_empty", "detail": f"row {i + 1}: {f}"})
    for hit in causal_scan(md, frozen):
        fails.append({"rule": "causal_language", "detail": hit["term"] + ": " + hit["sentence"]})
    if "Executive claim" in d:
        ex = d["Executive claim"]
        if artifact["status"] not in ex:
            fails.append({"rule": "executive_claim_omits_verdict", "detail": artifact["status"]})
        if artifact["status"] != "SUPPORTED" and any(t in ex.lower() for t in q["bullishTerms"] + ["improved out-of-sample"]):
            fails.append({"rule": "unsupported_bullish_claim", "detail": ex[:120]})
    return {"ok": not fails, "failures": fails, "sections": names, "claimRows": len(parse_claim_table(d.get("Verdict per claim", "")))}
