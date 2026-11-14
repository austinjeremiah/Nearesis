"""Independent verification against CRAN ForeComp 1.0.0 (R). Runs when Rscript with ForeComp 1.0.0 and jsonlite is available;
otherwise every test is skipped with an explicit NOT_RUN reason (never a silent pass). Tolerances: crosscheck-spec.json,
committed before the first comparison. Read-only with respect to production code, calibration and Q14 records."""

from __future__ import annotations

import math

import pytest

import forecomp_crosscheck as X

AVAILABLE, WHY = X.r_availability()
pytestmark = pytest.mark.skipif(not AVAILABLE, reason=WHY)

PERFECT_CUBES_WHERE_R_FLOAT_FLOOR_DIFFERS = {64, 125, 216, 343, 512, 729, 1000, 1728}


def _assert_agreement(res: dict, min_compared: int) -> None:
    assert res["forecomp"] == X.REQUIRED_FORECOMP
    for m in ("P", "S", "H"):
        assert res[m]["failures"] == [], res[m]["failures"][:3]
    assert res["boundaryCount"] <= X.TOL["maxBoundaryCases"]
    assert res["P"]["compared"] + res["P"]["degenerate_python"] >= min_compared
    for m in ("P", "S", "H"):
        assert res[m]["rejectAgree"] + res[m]["boundary"] >= res[m]["compared"]
    assert res["P"]["maxStatRel"] <= X.TOL["statisticRel"] and res["P"]["maxPAbs"] <= X.TOL["pValueAbs"]
    assert res["S"]["maxStatRel"] <= X.TOL["statisticRel"]


def test_frozen_reference_vectors_agree_with_forecomp():
    res = X.crosscheck(X.frozen_vector_series())
    _assert_agreement(res, 8)


def test_calibration_fixture_series_agree_with_forecomp():
    """First 25 frozen seeds of each of the 12 amendment-002 calibration cells (the full 5000 per cell were verified once, see the finding record)."""
    res = X.crosscheck(X.calibration_series(25))
    _assert_agreement(res, 300)
    assert res["P"]["rejectAgree"] == 300 and res["S"]["rejectAgree"] == 300 and res["H"]["rejectAgree"] == 300


def test_frozen_q14_evaluation_inputs_agree_with_forecomp():
    """Agreement on the frozen Q14 inputs only. This is not an evaluation and produces no Q14 verdict."""
    res = X.crosscheck(X.q14_series())
    _assert_agreement(res, 101)
    assert res["P"]["rejectAgree"] == 101


def test_randomized_seeded_inputs_agree_with_forecomp():
    res = X.crosscheck(X.randomized_series())
    _assert_agreement(res, 8400)
    assert res["P"]["rejectAgree"] == 8400 and res["S"]["rejectAgree"] == 8400 and res["H"]["rejectAgree"] == 8400


def test_degenerate_and_edge_inputs():
    res = X.crosscheck(X.edge_series())
    _assert_agreement(res, 13)
    # constant and numerically constant differentials are withheld by Python even though ForeComp returns a huge rounding-noise statistic
    assert res["P"]["degenerate_python"] >= 3 and res["P"]["degenerate_agree"] == res["P"]["degenerate_python"]


def test_forecomp_default_m_differs_from_intended_floor_cube_root_only_at_perfect_cubes():
    """Finding record: in R floating point floor(n^(1/3)) is one too small at several perfect cubes (1000^(1/3) = 9.999999999999998),
    so ForeComp's default M differs from the published prescription (and from the Python m) exactly there. Pinned so a change is noticed."""
    res = X.crosscheck(X.randomized_series(per_scenario=1))
    differs = {int(k) for k in res["P"].get("M_default_differs_at_n", {})}
    assert differs <= PERFECT_CUBES_WHERE_R_FLOAT_FLOOR_DIFFERS and 1000 in differs
    for n in PERFECT_CUBES_WHERE_R_FLOAT_FLOOR_DIFFERS:
        assert X._py_m(n) == round(n ** (1 / 3))  # Python uses the intended integer cube root
