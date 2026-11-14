"""Publication-eligibility gate of the research service (the function V06 re-exercises on the full publication path)."""

from __future__ import annotations

BLOCKING_REASON_CODES = {"mechanical_overlap", "leakage_detected"}


def publishable(artifact: dict) -> dict:
    reasons = []
    code = artifact.get("reason_code")
    if code in BLOCKING_REASON_CODES:
        reasons.append(f"blocked: {code}")
    if artifact.get("status") == "NOT_REPRODUCIBLE":
        reasons.append("status NOT_REPRODUCIBLE cannot be published as a finding")
    if artifact.get("leakage", {}).get("clean") is False:
        reasons.append("leakage findings present")
    return {"ok": not reasons, "reasons": reasons}
