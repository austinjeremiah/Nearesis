"""Unit tests for the amendment-001 candidate estimators: production versus the independent reference, and detection of
the naive i.i.d. variance. Uses throwaway seeds well away from calibration and evaluation seeds."""

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))
from reference_stats import dm_candidate_reference  # noqa: E402

from nearesis_research.dm_amended import dm_candidate  # noqa: E402
from nearesis_research.frozen import extract_params  # noqa: E402

DOC = Path(__file__).resolve().parents[3] / "docs" / "research" / "PREREGISTRATION-AMENDMENT-001.md"
P = extract_params(DOC.read_text())


def _series(seed, n, phi):
    r = np.random.default_rng(seed)
    e = r.normal(0, 1, n + 100)
    x = np.zeros(n + 100)
    for i in range(1, n + 100):
        x[i] = phi * x[i - 1] + e[i]
    return 0.1 + x[100:]


@pytest.mark.parametrize("cand", P["candidates"], ids=lambda c: c["id"])
@pytest.mark.parametrize("n,phi", [(60, 0.7), (150, 0.3), (300, 0.5)])
def test_candidate_matches_reference(cand, n, phi):
    d = _series(123 + n, n, phi)
    prod = dm_candidate(d, cand, P)
    ref = dm_candidate_reference(d.tolist(), cand, P["rhoClip"], P["andrewsConstant"])
    assert prod["lag"] == ref["lag"]
    assert abs(prod["statistic"] - ref["statistic"]) < 1e-9
    assert abs(prod["p_value"] - ref["p_value"]) < 1e-9


def test_naive_variance_differs_from_every_hac_candidate():
    d = _series(5, 300, 0.5)
    naive = {"id": "naive", "variance": "bartlett", "lag": {"rule": "fixed", "value": 0}, "hln": False, "prewhiten": False}
    t0 = dm_candidate(d, naive, P)["statistic"]
    for c in P["candidates"]:
        assert abs(dm_candidate(d, c, P)["statistic"] - t0) > 1e-3


def test_amendment_block_is_closed_and_has_label():
    assert [c["id"] for c in P["candidates"]] == [f"E{i}" for i in range(9)]
    assert P["amendment"]["label"] == "post_hoc_methodological_correction"
    assert P["amendment"]["bandUnchanged"] == [1, 10]
