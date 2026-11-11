"""Bridge between the agent-runtime bull/bear/adjudicator graph and `adversarial.py` (ch.27, ch.16b Q19).

stdin: JSON {op: "engine"} -> the engine verdict from the frozen thresholds;
       JSON {op: "protocol", given, results, branchArgs, stances} -> validation, adjudication (run twice, purity check).
stdout: one JSON line. Every parameter comes from the frozen preregistration; none is accepted from the caller."""

from __future__ import annotations

import json
import sys

from .adversarial import _h, adjudicate, run_given
from .frozen import load_frozen
from .verdict import DEFAULTS, grade


def main() -> int:
    req = json.loads(sys.stdin.read())
    f = load_frozen()
    engine = grade(dict(DEFAULTS), f)
    if req["op"] == "engine":
        print(json.dumps({"status": engine["status"], "evidenceStrength": engine["evidenceStrength"], "frozenDocumentHash": f.doc_hash, "intact": f.intact}))
        return 0
    pre = f.doc_hash
    a = run_given(req["given"], req["results"], req["branchArgs"], req["stances"], engine, f, pre, lambda: load_frozen().doc_hash)
    b = run_given(req["given"], req["results"], req["branchArgs"], req["stances"], engine, f, pre, lambda: load_frozen().doc_hash)
    f.record_result("Q19:bullbear-graph", kind="adversarial_protocol")
    print(json.dumps({**a, "secondRunHash": b["adjudicationHash"], "engineVerdict": {"status": engine["status"], "evidenceStrength": engine["evidenceStrength"]},
                      "maxArguments": f.get("q19.maxArguments"), "frozenIntact": f.intact}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
