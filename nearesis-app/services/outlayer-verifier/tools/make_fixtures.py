#!/usr/bin/env python3
"""Generate the verifier fixture suite (all SYNTHETIC, labeled as such).

Writes fixtures/*.json and fixtures/manifest.json. Expected outputs for valid
fixtures come from tools/reference_verifier.py (independent of the Rust code).
Deterministic: no randomness except a fixed-seed LCG.
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import reference_verifier as ref  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "fixtures")


def days(start_ordinal, n):
    import datetime as dt
    d0 = dt.date.fromordinal(start_ordinal)
    return [(d0 + dt.timedelta(days=i)).isoformat() for i in range(n)]


def lcg(seed):
    s = seed
    while True:
        s = (s * 6364136223846793005 + 1442695040888963407) % (1 << 64)
        yield s >> 33


def doc(claim, xs, ys, metrics, start="2026-09-01", snap="synthetic-v1"):
    import datetime as dt
    ds = days(dt.date.fromisoformat(start).toordinal(), len(xs))
    return {
        "schema_version": "nearesis.verifier.input.v1",
        "claim_id": claim,
        "source": {"dataset": "SYNTHETIC fixture - not NEAR production data", "snapshot_id": snap, "synthetic": True},
        "series": {
            "x": {"name": "intents_volume_proxy", "unit": "usd_cents", "points": [[d, str(v)] for d, v in zip(ds, xs)]},
            "y": {"name": "active_signers_proxy", "unit": "accounts", "points": [[d, str(v)] for d, v in zip(ds, ys)]},
        },
        "metrics": metrics,
    }


def with_expected(d):
    out = json.loads(ref.verify(d))
    d = copy.deepcopy(d)
    d["expected"] = {"input_sha256": out["input_sha256"], "results_sha256": out["results_sha256"]}
    return d


def main():
    os.makedirs(OUT, exist_ok=True)
    fixtures = []  # (name, doc_or_raw_str, expectation)

    # F01: small hand-checkable series (pearson exactly 0.8), compute mode
    f01 = doc("syn:f01-basic", [1, 2, 3, 4, 5], [2, 1, 4, 3, 5], ["lag_pearson:1", "pearson", "summary"], snap="f01")
    fixtures.append(("f01_basic_computed", f01, {"status": "COMPUTED"}))

    # F02: same claim with expected digests from the reference -> VERIFIED
    f02 = with_expected(f01)
    fixtures.append(("f02_basic_verified", f02, {"status": "VERIFIED"}))

    # F03: a single observation altered after the claim was made
    f03 = copy.deepcopy(f02)
    f03["series"]["y"]["points"][2][1] = "40"
    fixtures.append(("f03_tampered_value", f03, {"status": "MISMATCH"}))

    # F04: provenance metadata altered, numbers untouched
    f04 = copy.deepcopy(f02)
    f04["source"]["snapshot_id"] = "f01-forged"
    fixtures.append(("f04_tampered_metadata", f04, {"status": "MISMATCH"}))

    # F05: claimed results digest forged
    f05 = copy.deepcopy(f02)
    f05["expected"]["results_sha256"] = "f" * 64
    fixtures.append(("f05_forged_results_digest", f05, {"status": "MISMATCH"}))

    # F06: 90-day signal where x leads y by 7 days, plus deterministic noise
    g = lcg(20261110)
    xs = [5_000_000 + 2_000_000 * ((i * 37) % 11) + next(g) % 400_000 for i in range(97)]
    ys = [1_000 + xs[i - 7] // 5_000 + next(g) % 150 for i in range(7, 97)]
    xs = xs[7:]
    f06 = with_expected(doc("syn:f06-lead7", xs, ys, ["lag_pearson:1", "lag_pearson:14", "lag_pearson:7", "pearson", "summary"], snap="f06"))
    fixtures.append(("f06_lagged_signal_verified", f06, {"status": "VERIFIED"}))

    # F07: maximum size and magnitude (4096 points at +/-1e15) -> overflow/perf stress
    m = 10**15
    xs = [m if i % 2 == 0 else -m for i in range(4096)]
    ys = [m if i % 3 == 0 else -m for i in range(4096)]
    f07 = with_expected(doc("syn:f07-bounds", xs, ys, ["lag_pearson:90", "pearson", "summary"], start="2010-01-01", snap="f07"))
    fixtures.append(("f07_extreme_bounds_verified", f07, {"status": "VERIFIED"}))

    # F08: constant series -> pearson undefined (null), still verifiable
    f08 = with_expected(doc("syn:f08-constant", [7, 7, 7, 7], [1, 2, 3, 4], ["pearson", "summary"], snap="f08"))
    fixtures.append(("f08_constant_series_null", f08, {"status": "VERIFIED"}))

    # Invalid inputs
    def bad(name, mutate, code):
        d = copy.deepcopy(f01)
        mutate(d)
        fixtures.append((name, d, {"status": "INVALID_INPUT", "code": code}))

    bad("i01_bad_schema_version", lambda d: d.__setitem__("schema_version", "nearesis.verifier.input.v0"), "unsupported_schema_version")
    bad("i02_float_value", lambda d: d["series"]["x"]["points"][0].__setitem__(1, "1.5"), "bad_value")
    bad("i03_numeric_not_string", lambda d: d["series"]["x"]["points"][0].__setitem__(1, 1), "schema_violation")
    bad("i04_date_gap", lambda d: d["series"]["x"]["points"][1].__setitem__(0, "2026-09-03"), "dates_not_contiguous")
    bad("i05_unknown_field", lambda d: d.__setitem__("note", "x"), "schema_violation")
    bad("i06_unsorted_metrics", lambda d: d.__setitem__("metrics", ["summary", "pearson"]), "metrics_not_sorted_unique")
    bad("i07_misaligned_series", lambda d: d["series"]["y"]["points"].pop(), "series_dates_misaligned")
    bad("i08_value_out_of_bounds", lambda d: d["series"]["y"]["points"][0].__setitem__(1, "1000000000000001"), "bad_value")
    fixtures.append(("i09_malformed_json", '{"schema_version": "nearesis.verifier.input.v1", ', {"status": "INVALID_INPUT", "code": "malformed_json"}))
    fixtures.append(("i10_duplicate_key", '{"schema_version":"nearesis.verifier.input.v1","schema_version":"x"}', {"status": "INVALID_INPUT", "code": "schema_violation"}))

    manifest = []
    for name, d, expect in fixtures:
        path = os.path.join(OUT, name + ".json")
        raw = d if isinstance(d, str) else json.dumps(d, indent=1)
        with open(path, "w") as f:
            f.write(raw)
        entry = {"fixture": name + ".json", **expect}
        if expect["status"] != "INVALID_INPUT":
            entry["expected_output"] = ref.verify(json.loads(raw))
            assert json.loads(entry["expected_output"])["status"] == expect["status"], name
        manifest.append(entry)
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump({"label": "SYNTHETIC fixtures; not production observations", "fixtures": manifest}, f, indent=1)
    print(f"wrote {len(manifest)} fixtures")


if __name__ == "__main__":
    main()
