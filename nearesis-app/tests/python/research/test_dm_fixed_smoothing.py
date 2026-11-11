import json
import math
from pathlib import Path

import numpy as np
import pytest

import reference_dm_fixed_smoothing as O
from nearesis_research import dm_fixed_smoothing as F

VEC = json.loads((Path(__file__).resolve().parents[3] / "packages/test-fixtures/research/dm-fixed-smoothing-vectors.json").read_text())
TOL = VEC["tolerance"]
QUAL = {"qualified": True, "resultHash": "sha256:test", "amendmentDocumentHash": "sha256:test", "overlapEligible": {}}


def _cases():
    return [c for c in VEC["cases"] if "wpe" in c]


@pytest.mark.parametrize("c", _cases(), ids=lambda c: c["name"])
def test_primary_matches_frozen_oracle_vectors(c):
    d = np.array(c["d"])
    got = F.wpe_test(d)
    exp = c["wpe"]
    assert got["m"] == exp["m"] and got["df"] == exp["df"]
    if exp["statistic"] is None:
        assert got["statistic"] is None
        return
    assert abs(got["statistic"] - exp["statistic"]) <= TOL["statistic"]
    assert abs(got["p_value"] - exp["p_value"]) <= TOL["pValue"]


@pytest.mark.parametrize("c", _cases(), ids=lambda c: c["name"])
def test_secondary_matches_oracle(c):
    got = F.bartlett_fixed_b_test(np.array(c["d"]))
    exp = c["bartlett"]
    assert got["M"] == exp["M"] and abs(got["critical_value"] - exp["critical_value"]) <= TOL["criticalValue"]
    if exp["statistic"] is not None:
        assert abs(got["statistic"] - exp["statistic"]) <= TOL["statistic"]
        assert got["reject"] == exp["reject"]


def test_oracle_is_not_production_code():
    src = Path(O.__file__).read_text()
    assert "nearesis_research" not in src.replace("nothing imported from nearesis_research", "") and "import numpy" not in src and "scipy" not in src.replace("no scipy", "")


def test_closed_form_sinusoid():
    c = next(x for x in VEC["cases"] if x["name"] == "closed_form_sinusoid")
    assert abs(F.wpe_test(np.array(c["d"]))["omega"] - c["closedForm"]["omega"]) < 1e-9


def test_t_tail_closed_form_matches_scipy_independently():
    from scipy import stats

    for df in (2, 6, 12):
        for t in (0.3, 1.7, 2.6, 5.0):
            assert abs(O.t_two_sided_p_even_df(t, df) - 2 * stats.t.sf(t, df)) < 1e-12


def test_sign_and_units_preserved():
    d = np.array(O.lcg_series(5, 150, 0.5, mean=0.4))
    pos = F.wpe_test(d)["statistic"]
    neg = F.wpe_test(-d)["statistic"]
    assert pos > 0 and abs(pos + neg) < 1e-12
    k = F.wpe_test(3.0 * d)["statistic"]
    assert abs(k - pos) < 1e-9  # statistic is scale free; mean difference itself keeps units (checked in compare_paired)
    r = F.compare_paired(3.0 * d, calibration=QUAL, with_bootstrap=False)
    assert abs(r["mean_diff"] - 3.0 * d.mean()) < 1e-12


def test_exact_zero_mean_gives_zero_statistic():
    c = next(x for x in VEC["cases"] if x["name"] == "no_mean_difference_exact")
    r = F.wpe_test(np.array(c["d"]))
    assert abs(r["statistic"]) < 1e-9 and abs(r["p_value"] - 1.0) < 1e-9


def test_structured_states():
    r = F.compare_paired([0.1, -0.2, 0.3, 0.0, 0.4], calibration=QUAL)
    assert r["status"] == "INSUFFICIENT_DATA" and r["p_value"] is None and not r["significance_claim_allowed"]
    assert F.compare_paired([0.25] * 60, calibration=QUAL)["status"] == "DEGENERATE_VARIANCE"
    assert F.compare_paired([0.1, float("nan")] + [0.2] * 30, calibration=QUAL)["status"] == "INVALID_INPUT"
    short = F.compare_paired(O.lcg_series(7, 30, 0.3, mean=2.0), calibration=QUAL)
    assert short["status"] == "METHOD_NOT_VALIDATED" and not short["significance_claim_allowed"] and short["p_value"] is not None


def test_not_qualified_never_claims_significance():
    d = np.array(O.lcg_series(9, 300, 0.2, mean=1.5))
    r = F.compare_paired(d, calibration={"qualified": False, "resultHash": "x"})
    assert r["status"] == "METHOD_NOT_VALIDATED" and r["p_value"] < 1e-6 and r["significance_claim_allowed"] is False
    assert F.compare_paired(d, calibration=None)["status"] == "METHOD_NOT_VALIDATED"
    ok = F.compare_paired(d, calibration=QUAL)
    assert ok["status"] == "VALID" and ok["significance_claim_allowed"] is True


def test_nested_pairs_are_not_validated_even_when_calibrated():
    d = np.array(O.lcg_series(9, 300, 0.2, mean=1.5))
    assert F.nested_policy("baseline", "intents") and F.nested_policy("price", "combined")
    assert not F.nested_policy("intents", "price") and not F.nested_policy("moving_avg_7", "baseline")
    assert F.nested_policy("naive_last", "combined") and F.nested_policy("unknown_a", "unknown_b")
    r = F.compare_paired(d, nested=True, calibration=QUAL)
    assert r["status"] == "METHOD_NOT_VALIDATED" and r["significance_claim_allowed"] is False


def test_multistep_requires_overlap_check():
    d = np.array(O.lcg_series(9, 300, 0.2, mean=1.5))
    assert F.compare_paired(d, horizon=7, calibration=QUAL, with_bootstrap=False)["status"] == "METHOD_NOT_VALIDATED"
    q = {**QUAL, "overlapEligible": {"h=7,n=300": True}}
    assert F.compare_paired(d, horizon=7, calibration=q, with_bootstrap=False)["status"] == "VALID"
    assert F.compare_paired(d, horizon=14, calibration=q, with_bootstrap=False)["status"] == "METHOD_NOT_VALIDATED"


def test_disagreement_is_preserved():
    d = np.array(O.lcg_series(11, 150, 0.5, mean=0.18))
    r = F.compare_paired(d, calibration=QUAL)
    assert r["agreement"] in ("agree", "disagree") and len(r["sensitivity_methods"]) == 2
    assert all(s["role"] == "sensitivity_only" for s in r["sensitivity_methods"])


def test_kv_polynomial_matches_independent_limit_simulation():
    for b, M_n in ((0.1, 400), (0.5, 200)):
        sim = O.kv_limit_quantile_975(b, n=M_n, reps=4000)
        assert abs(sim - F.kv_critical_975(b)) < 0.12, (b, sim)


def test_stationary_bootstrap_indices_are_pairs_preserving_and_circular():
    rng = np.random.default_rng(1)
    idx = F.stationary_bootstrap_indices(rng, 50, 200, 5)
    assert idx.min() >= 0 and idx.max() < 50
    steps = np.diff(idx, axis=1) % 50
    frac_one = float((steps == 1).mean())
    assert 0.75 < frac_one < 0.9  # ~ 1 - 1/5 plus lucky restarts


def test_bootstrap_matches_plain_loop_reference():
    d = np.array(O.lcg_series(21, 60, 0.4, mean=0.2))
    got = F.bootstrap_test(d, seed=123)
    n, M0, L = len(d), F.boot_lag(60), F.boot_lag(60)
    rng = np.random.default_rng(np.random.SeedSequence([123, 2]))
    idx = F.stationary_bootstrap_indices(rng, n, F.BOOT_REPS, L)

    def lrv(x):
        m = sum(x) / len(x)
        c = [v - m for v in x]
        g = lambda k: sum(c[i] * c[i - k] for i in range(k, len(c))) / len(c)
        return g(0) + 2 * sum((1 - k / M0) * g(k) for k in range(1, M0))

    t = (sum(d) / n) / math.sqrt(lrv(list(d)) / n)
    cnt = 0
    for row in idx:
        x = [d[i] for i in row]
        tb = (sum(x) / n - sum(d) / n) / math.sqrt(lrv(x) / n)
        cnt += int(not abs(tb) < abs(t))
    assert abs(got["p"] - (1 + cnt) / (1 + F.BOOT_REPS)) < 1e-12 and abs(got["t"] - t) < 1e-9


def test_vectorised_null_generator_equals_production_generator():
    from nearesis_research import amendment, amendment2

    for seed, n, phi in ((20000000, 60, 0.7), (20010000, 300, 0.5)):
        assert np.allclose(amendment2.ar1_series(seed, n, phi, 0.0, 1.0, 100), amendment.ar1(seed, n, phi, 0.0, 1.0, 100), atol=1e-10)


def test_seed_namespaces_are_disjoint():
    from nearesis_research import amendment2

    params, _ = amendment2.load_amendment()
    amendment2.assert_disjoint(params)
