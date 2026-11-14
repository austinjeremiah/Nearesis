"""Pinned live snapshot path: deterministic ids, never overwriting, organic target, NaN never zero."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from nearesis_research.live import (
    INPUT_METHOD,
    LiveSnapshotError,
    build_live_inputs,
    freeze_live_snapshot,
    load_snapshot,
    load_snapshot_inputs,
    resolve_swap_window,
)

DAYS = pd.date_range("2026-06-01", periods=20, freq="D")


def fake_query(null_usd_day: str | None = None, scale: int = 1000):
    def q(sql: str, params):
        if params is None:
            # the window probe: first day partial, newest day partial
            return [{"d": d.strftime("%Y-%m-%d"), "n": (30 if i == 0 else 20000 if i < 19 else 900)} for i, d in enumerate(DAYS)]
        s, e = pd.Timestamp(params["s"]), pd.Timestamp(params["e"])
        days = [d for d in DAYS if s <= d <= e]
        if "FROM nearesis_live.near_daily_tx" in sql:
            return [{"d": d.strftime("%Y-%m-%d"), "y": str(1000 + i)} for i, d in enumerate(days)]
        if "FROM nearesis_live.account_daily_activity" in sql:
            return [{"d": d.strftime("%Y-%m-%d"), "tx_total": "900", "tx_intents": "50", "tx_bridge": "50", "tx_organic": str(800 + i), "top1pct_organic_tx": "100", "top5pct_organic_tx": "250", "account_rule_version": 1} for i, d in enumerate(days)]
        if "FROM nearesis_live.price_candles" in sql:
            return [{"d": d.strftime("%Y-%m-%d"), "price": 3.0 + 0.01 * i} for i, d in enumerate(days)]
        if "privacy_era AS era" in sql:
            return [{"d": d.strftime("%Y-%m-%d"), "era": "public", "n_success": "10", "n_success_null_usd": "0", "vol": scale * 1.0} for d in days]
        if "FROM nearesis_live.intents_swaps" in sql:
            return [{"d": d.strftime("%Y-%m-%d"), "n": "20000", "n_success": "19000", "n_success_null_usd": "1" if d.strftime("%Y-%m-%d") == null_usd_day else "0", "vol": scale * 2.0} for d in days]
        if "FROM nearesis_live.source_coverage" in sql:
            return []
        raise AssertionError(sql)

    return q


def test_swap_window_drops_partial_first_and_newest_day():
    w = resolve_swap_window([{"d": d.strftime("%Y-%m-%d"), "n": (30 if i == 0 else 20000 if i < 19 else 900)} for i, d in enumerate(DAYS)])
    assert (w["first"], w["last"]) == ("2026-06-02", "2026-06-19")
    assert [x["day"] for x in w["dropped"]] == ["2026-06-20", "2026-06-01"]


def test_swap_window_keeps_a_full_first_day():
    w = resolve_swap_window([{"d": d.strftime("%Y-%m-%d"), "n": 20000} for d in DAYS])
    assert w["first"] == "2026-06-01"


def test_freeze_is_content_addressed_and_never_overwrites(tmp_path: Path):
    a = freeze_live_snapshot(tmp_path, query=fake_query())
    assert a["reused"] is False and a["inputMethod"] == INPUT_METHOD
    assert a["window"] == {"start": "2026-06-02", "end": "2026-06-19"}
    b = freeze_live_snapshot(tmp_path, query=fake_query())
    assert b["reused"] is True and b["snapshotId"] == a["snapshotId"]
    c = freeze_live_snapshot(tmp_path, query=fake_query(scale=2000))  # changed input: new id, old directory untouched
    assert c["snapshotId"] != a["snapshotId"] and c["reused"] is False
    assert len(list(tmp_path.iterdir())) == 2
    load_snapshot(Path(a["dir"]))


def test_tampered_snapshot_is_refused(tmp_path: Path):
    a = freeze_live_snapshot(tmp_path, query=fake_query())
    f = Path(a["dir"]) / "raw" / "swaps.json"
    f.write_text(f.read_text().replace("2000", "2001", 1))
    with pytest.raises(LiveSnapshotError):
        load_snapshot(Path(a["dir"]))
    with pytest.raises(LiveSnapshotError):  # re-freezing identical data detects the damaged pinned copy instead of replacing it
        freeze_live_snapshot(tmp_path, query=fake_query())


def test_requested_window_cannot_exceed_resolved_complete_window(tmp_path: Path):
    with pytest.raises(LiveSnapshotError):
        freeze_live_snapshot(tmp_path, start="2026-06-01", query=fake_query())
    with pytest.raises(LiveSnapshotError):
        freeze_live_snapshot(tmp_path, end="2026-06-20", query=fake_query())


def test_inputs_use_organic_target_and_keep_gaps_nan(tmp_path: Path):
    a = freeze_live_snapshot(tmp_path, query=fake_query())
    desc, ll = load_snapshot_inputs(Path(a["dir"]))
    t = ll.inputs.target_aggregate
    assert t.iloc[0] == 800 and t.iloc[1] == 801  # tx_organic, not the 1000+ aggregate
    assert set(ll.inputs.cohort_tx) == {1, 5} and set(ll.inputs.privacy_volume) == {"public"}
    assert ll.source["snapshotId"] == desc["snapshotId"] and ll.complete is True
    # a missing organic day is NaN and reported, never 0
    raw = load_snapshot(Path(a["dir"]))[1]
    raw["account_daily_activity"].pop(3)
    ll2 = build_live_inputs(raw, desc["window"]["start"], desc["window"]["end"])
    assert np.isnan(ll2.inputs.target_aggregate.iloc[3]) and not ll2.complete
    assert any("tx_organic" in r and "never zero" in r for r in ll2.reasons)


def test_null_usd_on_a_success_swap_makes_the_day_incomplete_not_zero(tmp_path: Path):
    a = freeze_live_snapshot(tmp_path, query=fake_query(null_usd_day="2026-06-05"))
    _, ll = load_snapshot_inputs(Path(a["dir"]))
    assert ll.complete is False
    assert ll.inputs.volume_completeness.loc["2026-06-05"] < 1.0
    assert any("NULL USD" in r for r in ll.reasons)


def test_rule_version_change_inside_window_is_reported(tmp_path: Path):
    a = freeze_live_snapshot(tmp_path, query=fake_query())
    desc, raw = load_snapshot(Path(a["dir"]))
    raw["account_daily_activity"][5]["account_rule_version"] = 2
    ll = build_live_inputs(raw, desc["window"]["start"], desc["window"]["end"])
    assert any("account_rule_version" in r for r in ll.reasons)


def test_live_run_never_overwrites_results(tmp_path: Path, capsys):
    from nearesis_research.cli import live_run

    a = freeze_live_snapshot(tmp_path / "snap", query=fake_query())
    out = tmp_path / "res"
    out.mkdir()
    (out / "keep.txt").write_text("x")
    assert live_run(a["dir"], out) == 4
    assert json.loads(capsys.readouterr().out)["rejected"] is True
    assert (out / "keep.txt").read_text() == "x"
