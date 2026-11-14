"""Unit tests for the G07 additions (Q11-Q22 building blocks)."""

from __future__ import annotations

import json
import unicodedata
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from nearesis_research.frozen import FreezeViolation, FrozenParameterMissing, canonical_bytes, document_hash, load_frozen
from nearesis_research.inference import dm_paired, paired_comparison, smape
from nearesis_research.models import AccessRecorder
from nearesis_research.overlap import detect_overlap
from nearesis_research.quant_supervisor import JobRejected, agent_submit, promote, validate_job_manifest
from nearesis_research.rolling import EvaluationRefused
from nearesis_research.thesis import causal_scan
from nearesis_research.verdict import DEFAULTS, conformance, grade, spike_check

from reference_stats import dm_reference


@pytest.fixture(scope="module")
def frozen(tmp_path_factory):
    return load_frozen(audit_dir=tmp_path_factory.mktemp("audit"))


def test_canonicalisation_rules():
    assert canonical_bytes("a\r\nb\rc") == b"a\nb\nc"
    assert document_hash("café") == document_hash(unicodedata.normalize("NFD", "café"))
    assert document_hash("x ") != document_hash("x")  # trailing whitespace is preserved


def test_frozen_document_matches_its_freeze_record(frozen):
    assert frozen.intact, frozen.violations
    assert frozen.get("q14.nullSimulation.seeds")[0] == 710001 and len(frozen.get("q14.coverage.seeds")) == 200
    with pytest.raises(FrozenParameterMissing):
        frozen.get("q14.doesNotExist")


def test_altered_document_is_not_intact(frozen, tmp_path):
    text = Path(__import__("nearesis_research.frozen", fromlist=["DOC_PATH"]).DOC_PATH).read_text()
    alt = load_frozen(doc_text=text.replace('"minRelativeImprovement": 0.02', '"minRelativeImprovement": 0.0'), audit_dir=tmp_path)
    assert not alt.intact
    with pytest.raises(FreezeViolation):
        alt.require_intact()
    assert grade({**DEFAULTS, "devPass": False}, alt)["evidenceStrength"] == "exploratory"


def test_verdict_table_conforms(frozen):
    assert all(r["ok"] for r in conformance(frozen))


def test_spike_dependence():
    eb = np.ones(50)
    ec = eb.copy() + 0.01
    eb[10], ec[10] = 40.0, 0.0
    assert spike_check(eb, ec, load_frozen())["spikeDependent"]


def test_dm_matches_reference_and_iid_differs():
    r = np.random.default_rng(3)
    d = np.zeros(150)
    e = r.normal(size=150)
    for i in range(1, 150):
        d[i] = 0.6 * d[i - 1] + e[i]
    prod, ref = dm_paired(d, 5), dm_reference(d.tolist(), 5)
    assert abs(prod["statistic"] - ref["statistic"]) < 1e-9 and abs(prod["p_value"] - ref["p_value"]) < 1e-9
    assert abs(dm_paired(d, 5, variance="iid")["statistic"] - ref["statistic"]) > 1e-3


def test_smape_zero_rule_and_small_sample(frozen):
    assert smape(np.array([0.0, 0.0]), np.array([0.0, 0.0])) == 0.0
    out = paired_comparison(np.array([1.0, 2, 3, 4, 5]), np.array([1.0, 1, 1, 1, 1]), frozen)
    assert out["status"] == "INSUFFICIENT_DATA" and out["p_value"] is None


def test_access_recorder_flags_reads_beyond_origin():
    rec = AccessRecorder()
    rec.record("2026-01-10", "fit", "2026-01-10")
    rec.record("2026-01-10", "fit", "2026-01-11")
    assert len(rec.violations()) == 1


def test_overlap_detector_uses_identity_not_correlation(frozen):
    assert detect_overlap({"a", "b"}, {"b", "c"}, frozen)["blocked"]
    assert not detect_overlap({"x"}, {"y"}, frozen)["blocked"]


def test_supervisor_rejects_code_and_unknown_keys():
    for bad in ({"jobId": "x", "kind": "sum", "python": "1"}, {"jobId": "x", "kind": "sum", "params": {"e": "__import__('os')"}}, {"jobId": "x", "kind": "nope"}):
        with pytest.raises(JobRejected):
            validate_job_manifest(bad)
    assert agent_submit({"jobId": "x", "kind": "sum", "params": {"values": [1, 2]}})["status"] == 202
    assert agent_submit({"jobId": "x", "kind": "sum", "source": "import os"})["status"] == 422


def test_promotion_requires_complete_matching_hashes(tmp_path):
    (tmp_path / "result.json").write_text("{}")
    (tmp_path / "hashes.json").write_text(json.dumps({"result.json": "sha256:bad"}))
    assert not promote(tmp_path, tmp_path / "out", ["result.json"])["promoted"]


def test_causal_scan_respects_allowlist(frozen):
    assert causal_scan("Volume causes activity.", frozen)
    assert not causal_scan("This does not cause activity; causality is excluded.", frozen)


def test_random_cv_is_refused_with_structured_error():
    e = EvaluationRefused("random_cross_validation_prohibited", "x")
    assert e.to_dict() == {"error": "random_cross_validation_prohibited", "detail": "x"}
