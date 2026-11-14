"""Frozen preregistration for the G07 tests (ch.16b statistical freeze rule).

`docs/research/PREREGISTRATION.md` owns every analysis parameter in one machine-readable JSON block. `freeze` records the
canonical document hash and a timestamp in `PREREGISTRATION.freeze.json`. Tests and evaluators read every value through
`Frozen.get`, which refuses an absent value and never accepts one supplied by the caller. Evaluation results are appended
to an audit log; a document that differs from the freeze record once results exist makes the affected result `post-hoc`.

Canonicalisation (fixed, stated in every artifact): CRLF and lone CR become LF, text is normalised to Unicode NFC, then
encoded as UTF-8. Trailing whitespace is preserved (never trimmed)."""

from __future__ import annotations

import hashlib
import json
import os
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[3]
DOC_PATH = APP_ROOT / "docs" / "research" / "PREREGISTRATION.md"
FREEZE_PATH = APP_ROOT / "docs" / "research" / "PREREGISTRATION.freeze.json"
CANONICALISATION = "crlf_cr_to_lf;unicode_nfc;utf8;trailing_whitespace_preserved"
BEGIN, END = "<!-- frozen-parameters:begin -->", "<!-- frozen-parameters:end -->"

# Every parameter class named in the statistical freeze rule, as paths into the frozen block.
REQUIRED_PARAMS = (
    "q14.interval.method",
    "q14.interval.level",
    "q11.minValidOrigins",
    "q14.minOriginsForPValue",
    "q17.minHoldoutOrigins",
    "q14.nullSimulation.band",
    "q14.coverage.band",
    "q15.modelSelectionRule",
    "q15.verdictTable",
    "q14.nullSimulation.seeds",
    "q14.coverage.seeds",
    "experiment.testFamily",
    "q18.variants",
    "q18.signFlipRule",
    "q11.horizon",
    "q11.lagGrid",
    "q11.minTrainingLength",
)


class FreezeViolation(RuntimeError):
    def __init__(self, violations: list[str]):
        super().__init__("preregistration freeze violated: " + "; ".join(violations))
        self.violations = violations


class FrozenParameterMissing(KeyError):
    pass


def canonical_bytes(text: str) -> bytes:
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    return unicodedata.normalize("NFC", t).encode("utf-8")


def document_hash(text: str) -> str:
    return "sha256:" + hashlib.sha256(canonical_bytes(text)).hexdigest()


def extract_params(text: str) -> dict:
    t = text.replace("\r\n", "\n")
    i, j = t.find(BEGIN), t.find(END)
    if i < 0 or j < i:
        raise FreezeViolation(["frozen-parameters block not found"])
    m = re.search(r"```json\n(.*?)\n```", t[i:j], re.S)
    if not m:
        raise FreezeViolation(["frozen-parameters JSON fence not found"])
    return json.loads(m.group(1))


def _lookup(params: dict, path: str):
    cur = params
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            raise FrozenParameterMissing(path)
        cur = cur[part]
    return cur


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def default_audit_dir() -> Path:
    return Path(os.environ.get("NEARESIS_RESEARCH_AUDIT_DIR", str(APP_ROOT / ".data" / "research" / "audit")))


@dataclass
class Frozen:
    params: dict
    doc_hash: str
    record: dict
    audit_dir: Path
    violations: list = field(default_factory=list)

    def get(self, path: str):
        """Read one frozen value. Raises FrozenParameterMissing if the document does not contain it."""
        return _lookup(self.params, path)

    @property
    def log_path(self) -> Path:
        return self.audit_dir / (self.record["documentHash"].replace("sha256:", "")[:16] + ".jsonl")

    def audit_entries(self) -> list[dict]:
        p = self.log_path
        if not p.exists():
            return []
        return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]

    def first_result_at(self) -> str | None:
        e = self.audit_entries()
        return min((x["at"] for x in e), default=None)

    def record_result(self, result_id: str, kind: str = "evaluation", **extra) -> dict:
        self.audit_dir.mkdir(parents=True, exist_ok=True)
        entry = {"resultId": result_id, "kind": kind, "at": _now(), "documentHash": self.doc_hash, **extra}
        with self.log_path.open("a") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
        return entry

    @property
    def intact(self) -> bool:
        return not self.violations

    @property
    def registration_label(self) -> str:
        return "pre_registered" if self.intact else "post-hoc registration"

    def require_intact(self) -> "Frozen":
        if self.violations:
            raise FreezeViolation(self.violations)
        return self


def load_frozen(
    doc_path: Path = DOC_PATH,
    freeze_path: Path = FREEZE_PATH,
    audit_dir: Path | None = None,
    doc_text: str | None = None,
    freeze_record: dict | None = None,
    evaluated_at: str | None = None,
) -> Frozen:
    """Loads the frozen document and checks it against the freeze record. `doc_text` and `freeze_record` let tests present
    an altered copy against the original record; the violations are returned on the object (use require_intact to raise)."""
    text = Path(doc_path).read_text(encoding="utf-8") if doc_text is None else doc_text
    record = json.loads(Path(freeze_path).read_text()) if freeze_record is None else freeze_record
    params = extract_params(text)
    fz = Frozen(params, document_hash(text), record, audit_dir or default_audit_dir())
    v: list[str] = []
    for path in REQUIRED_PARAMS:
        try:
            _lookup(params, path)
        except FrozenParameterMissing:
            v.append(f"required parameter missing: {path}")
    if fz.doc_hash != record["documentHash"]:
        v.append("document hash differs from the freeze record (a frozen value was changed after freezing)")
    first = evaluated_at or fz.first_result_at()
    if first is not None and record["frozenAt"] > first:
        v.append(f"freeze time {record['frozenAt']} is after the first evaluation result {first}")
    fz.violations = v
    return fz


def write_freeze(doc_path: Path = DOC_PATH, freeze_path: Path = FREEZE_PATH) -> dict:
    """Freezes the document: records its canonical hash and the time. Refuses to overwrite an existing freeze."""
    if Path(freeze_path).exists():
        raise FreezeViolation(["a freeze record already exists; a frozen document is never re-frozen in place"])
    text = Path(doc_path).read_text(encoding="utf-8")
    params = extract_params(text)
    for path in REQUIRED_PARAMS:
        _lookup(params, path)
    rec = {
        "schema": "preregistration-freeze@1",
        "documentHash": document_hash(text),
        "canonicalisation": CANONICALISATION,
        "frozenAt": _now(),
        "requiredParameters": list(REQUIRED_PARAMS),
        "note": "Fixture-evaluation freeze. Not a chain commitment; no on-chain hash has been written.",
    }
    Path(freeze_path).write_text(json.dumps(rec, indent=2, sort_keys=True) + "\n")
    return rec


if __name__ == "__main__":
    import sys

    if sys.argv[1:] == ["freeze"]:
        print(json.dumps(write_freeze()))
    else:
        f = load_frozen()
        print(json.dumps({"hash": f.doc_hash, "intact": f.intact, "violations": f.violations}))
