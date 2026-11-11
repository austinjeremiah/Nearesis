"""Fact-envelope narrative. Sentences are composed only from computed numbers; `verify_narrative` rejects any numeric
token that is not present (to its displayed precision) in the result facts (ch.27 numerical fidelity)."""

from __future__ import annotations

import re

_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_NUM = re.compile(r"-?\d+(?:\.\d+)?%?")


def facts_of(artifact: dict) -> dict:
    p = artifact["estimates"]["primary"]
    h = artifact["estimates"]["holdout"] or {}
    ci = p.get("delta_mae_ci") or {}
    rb = (artifact["falsification"].get("robustness") or {})
    pl = artifact["falsification"].get("placebo") or {}
    f = {
        "horizon": artifact["hypothesis"]["primaryHorizon"],
        "n_origins": p.get("n_origins"),
        "mae_baseline": p.get("mae_baseline"),
        "mae_candidate": p.get("mae_candidate"),
        "delta_mae": p.get("delta_mae"),
        "relative_improvement_pct": None if p.get("relative_improvement") is None else p["relative_improvement"] * 100,
        "p_adjusted": p.get("p_adjusted"),
        "ci_lo": ci.get("lo"),
        "ci_hi": ci.get("hi"),
        "ci_level_pct": None if not ci.get("level") else ci["level"] * 100,
        "holdout_n": h.get("n_origins"),
        "holdout_relative_improvement_pct": None if h.get("relative_improvement") is None else h["relative_improvement"] * 100,
        "robustness_agree_share_pct": None if rb.get("agree_share") is None else rb["agree_share"] * 100,
        "placebo_p": pl.get("p_value"),
        "family_size": artifact["estimates"]["fdr"]["m"],
        "fdr_q": artifact["estimates"]["fdr"]["q"],
    }
    return {k: v for k, v in f.items() if v is not None}


def render_narrative(artifact: dict) -> str:
    f = facts_of(artifact)
    s = [f"Primary comparison, {f['horizon']}-day horizon: {artifact['hypothesis']['primaryComparison']}."]
    if "mae_baseline" in f:
        s.append(
            f"Development MAE was {f['mae_baseline']:.4f} for the baseline and {f['mae_candidate']:.4f} for the candidate over "
            f"{f['n_origins']} origins, a relative change of {f['relative_improvement_pct']:.1f}%."
        )
    if "p_adjusted" in f:
        s.append(f"The FDR-adjusted p-value is {f['p_adjusted']:.4f} within a family of {f['family_size']} tests at q {f['fdr_q']}.")
    if "holdout_n" in f and "holdout_relative_improvement_pct" in f:
        s.append(f"The lockbox holdout covered {f['holdout_n']} origins with a relative change of {f['holdout_relative_improvement_pct']:.1f}%.")
    s.append(f"Verdict: {artifact['status']} ({artifact['evidenceStrength']}). This is a predictive result and not a causal claim.")
    return " ".join(s)


def verify_narrative(text: str, facts: dict) -> dict:
    """Returns {ok, unmatched}. A token matches a fact if rounding the fact to the token's decimals reproduces it."""
    body = _DATE.sub(" ", text)
    unmatched = []
    for tok in _NUM.findall(body):
        pct = tok.endswith("%")
        raw = tok.rstrip("%")
        dec = len(raw.split(".")[1]) if "." in raw else 0
        val = float(raw)
        ok = False
        for v in facts.values():
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                continue
            cand = [v] if not pct else [v]
            if any(abs(round(c, dec) - val) < 10 ** (-dec) / 2 + 1e-12 for c in cand):
                ok = True
                break
        if not ok:
            unmatched.append(tok)
    return {"ok": not unmatched, "unmatched": unmatched}
