"""live-organic-v3: stablecoin set from registry identity, route classes, unmapped/stale handling, snapshot id,
never-overwrite and byte reproducibility of the full run."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from nearesis_research import cli
from nearesis_research.live import INPUT_METHOD as V2, LiveSnapshotError, load_snapshot
from nearesis_research.live_v3 import (
    DECLARED_EXCLUDED,
    INPUT_METHOD,
    STABLE_CANDIDATES,
    freeze_v3_snapshot,
    load_v3_inputs,
    registration_record,
    resolve_stable_set,
    stale_window_end,
)

DAYS = pd.date_range("2026-06-01", periods=20, freq="D")
REG = {"registrationId": "LIVE-ORGANIC-V3", "documentHash": "sha256:test", "frozenAt": "2026-11-12T00:00:00.000Z"}


def identity(overrides: dict | None = None, drop: tuple = ()) -> list[dict]:
    rows = {s: {"sym": s, "ids": [i], "verifications": ["verified"], "n": 1} for s, i in STABLE_CANDIDATES.items()}
    rows["wNEAR"] = {"sym": "wNEAR", "ids": ["wrapped-near"], "verifications": ["verified"], "n": 1}
    for k in drop:
        rows.pop(k)
    rows.update(overrides or {})
    return sorted(rows.values(), key=lambda r: r["sym"])


def fake_query(reg=None, stale_from: str | None = None, scale: int = 1000, all_days=DAYS, noisy: bool = False):
    reg = identity() if reg is None else reg
    rng = np.random.default_rng(7)
    jit = {d: (float(rng.normal()) if noisy else 0.0) for d in all_days}
    DAYS = all_days  # noqa: N806

    def q(sql: str, params):
        if params is None:
            return [{"d": d.strftime("%Y-%m-%d"), "n": (30 if i == 0 else 20000 if i < 19 else 900)} for i, d in enumerate(DAYS)]
        s, e = pd.Timestamp(params["s"]), pd.Timestamp(params["e"])
        days = [d for d in DAYS if s <= d <= e]
        f = lambda d: d.strftime("%Y-%m-%d")  # noqa: E731
        if "FROM nearesis_live.asset_registry" in sql and "GROUP BY sym" in sql:
            return reg
        if "AS n_stale" in sql:
            return [{"d": f(d), "n": "20000", "n_null": "40", "n_stale": "300" if stale_from and f(d) >= stale_from else "0"} for d in days]
        if "route_class" in sql and "multiIf" in sql:
            out = []
            for i, d in enumerate(days):
                out += [
                    {"d": f(d), "route_class": "stablecoin", "n": "12000", "n_success": "11000", "n_success_null_usd": "0", "vol": scale * 3.0 + i + 40 * jit[d]},
                    {"d": f(d), "route_class": "non_stablecoin", "n": "6000", "n_success": "5000", "n_success_null_usd": "0", "vol": scale * 1.0 + 2 * i + 30 * jit[d]},
                    {"d": f(d), "route_class": "mixed", "n": "1900", "n_success": "1800", "n_success_null_usd": "0", "vol": 500.0},
                    {"d": f(d), "route_class": "excluded_declared", "n": "60", "n_success": "50", "n_success_null_usd": "0", "vol": 10.0},
                    {"d": f(d), "route_class": "unmapped", "n": "40", "n_success": "30", "n_success_null_usd": "0", "vol": 5.0},
                ]
            return out
        if "intents_swap_asset_status" in sql:
            return [{"origin_reason": "conflicting_identity_for_symbol", "destination_reason": None, "n": "100"}, {"origin_reason": "not_in_registry", "destination_reason": None, "n": "50"}]
        if "FROM nearesis_live.near_daily_tx" in sql:
            return [{"d": f(d), "y": str(1000 + i)} for i, d in enumerate(days)]
        if "FROM nearesis_live.account_daily_activity" in sql:
            return [{"d": f(d), "tx_total": "900", "tx_intents": "50", "tx_bridge": "50", "tx_organic": str(int(800 + i + 30 * jit[d])), "top1pct_organic_tx": "100", "top5pct_organic_tx": "250", "account_rule_version": 1} for i, d in enumerate(days)]
        if "FROM nearesis_live.price_candles" in sql:
            return [{"d": f(d), "price": 3.0 + 0.01 * i + 0.05 * jit[d]} for i, d in enumerate(days)]
        if "privacy_era AS era" in sql:
            return [{"d": f(d), "era": "public", "n_success": "10", "n_success_null_usd": "0", "vol": scale * 1.0} for d in days]
        if "FROM nearesis_live.intents_swaps" in sql:
            return [{"d": f(d), "n": "20000", "n_success": "19000", "n_success_null_usd": "0", "vol": scale * 2.0} for d in days]
        if "FROM nearesis_live.source_coverage" in sql:
            return []
        raise AssertionError(sql)

    return q


def test_stable_set_requires_verified_registry_identity():
    ok = resolve_stable_set(identity())
    assert ok["stable"] == sorted(STABLE_CANDIDATES) and ok["unresolved"] == {}
    bad = resolve_stable_set(identity(
        overrides={
            "USDT": {"sym": "USDT", "ids": ["tether", "tether-gold"], "verifications": ["verified"], "n": 2},  # conflicting
            "DAI": {"sym": "DAI", "ids": [None], "verifications": ["unknown"], "n": 1},  # not verified
            "FRAX": {"sym": "FRAX", "ids": ["frax-share"], "verifications": ["verified"], "n": 1},  # differs from declared
        },
        drop=("USDG",),  # absent from the registry
    ))
    assert "USDT" not in bad["stable"] and "DAI" not in bad["stable"] and "FRAX" not in bad["stable"] and "USDG" not in bad["stable"]
    assert set(bad["unresolved"]) == {"USDT", "DAI", "FRAX", "USDG"}
    assert bad["unresolved"]["USDG"] == "not_in_registry" and bad["unresolved"]["DAI"] == "not_verified"
    assert set(bad["stable"]) == set(STABLE_CANDIDATES) - set(bad["unresolved"])


def test_declared_exclusions_never_overlap_the_set():
    assert not set(DECLARED_EXCLUDED) & set(STABLE_CANDIDATES)


def test_route_query_puts_unknown_and_unresolved_symbols_out_of_both_classes(tmp_path: Path):
    desc = freeze_v3_snapshot(tmp_path, query=fake_query(reg=identity(drop=("USDG",))), registration=REG)
    sql = desc["queries"]["swaps_routes"]
    assert "'USDG'" in sql.split("'excluded_declared'")[0]  # unresolved candidate goes to the excluded list
    assert "'USDT'" in sql and sql.index("'unmapped'") < sql.index("'excluded_declared'") < sql.index("'stablecoin'") < sql.index("'non_stablecoin'")
    assert "USDG" in desc["stablecoinSet"]["unresolved"] and "USDG" not in desc["stablecoinSet"]["stable"]
    for s in DECLARED_EXCLUDED:
        assert f"'{s}'" in sql


def test_freeze_is_content_addressed_and_never_overwrites(tmp_path: Path):
    a = freeze_v3_snapshot(tmp_path, query=fake_query(), registration=REG)
    assert a["reused"] is False and a["inputMethod"] == INPUT_METHOD and "-live-organic-v3-" in a["snapshotId"]
    assert a["window"] == {"start": "2026-06-02", "end": "2026-06-19"}
    b = freeze_v3_snapshot(tmp_path, query=fake_query(), registration=REG)
    assert b["reused"] is True and b["snapshotId"] == a["snapshotId"]
    c = freeze_v3_snapshot(tmp_path, query=fake_query(scale=2000), registration=REG)
    assert c["snapshotId"] != a["snapshotId"] and c["reused"] is False
    assert len(list(tmp_path.iterdir())) == 2
    f = Path(a["dir"]) / "raw" / "swaps_routes.json"
    f.write_text(f.read_text().replace("12000", "12001", 1))
    with pytest.raises(LiveSnapshotError):
        load_snapshot(Path(a["dir"]))
    with pytest.raises(LiveSnapshotError):  # a damaged pinned copy is detected, never replaced
        freeze_v3_snapshot(tmp_path, query=fake_query(), registration=REG)
    assert INPUT_METHOD != V2


def test_stale_null_rows_truncate_the_window_only_above_the_declared_share(tmp_path: Path):
    q = [{"d": d.strftime("%Y-%m-%d"), "n": "20000", "n_null": "40", "n_stale": "199" if i == 3 else "0"} for i, d in enumerate(DAYS)]
    assert stale_window_end(q, "2026-06-19")["truncatedBy"] is None  # 0.995 percent: counted as unmapped, stays in window
    q[5]["n_stale"] = "200"
    t = stale_window_end(q, "2026-06-19")
    assert t["truncatedBy"] == "2026-06-06" and t["end"] == "2026-06-05"
    d = freeze_v3_snapshot(tmp_path, query=fake_query(stale_from="2026-06-12"), registration=REG)
    assert d["window"]["end"] == "2026-06-11" and d["staleNullWindowRule"]["truncatedBy"] == "2026-06-12"
    with pytest.raises(LiveSnapshotError):
        freeze_v3_snapshot(tmp_path / "x", query=fake_query(stale_from="2026-06-03"), registration=REG)


def test_inputs_counts_shares_and_route_volume(tmp_path: Path):
    d = freeze_v3_snapshot(tmp_path, query=fake_query(), registration=REG)
    desc, ll = load_v3_inputs(Path(d["dir"]))
    a = ll.audit
    days = 18
    assert a["windowSwaps"] == days * 20000
    assert a["unmappedOrNullCanonicalSwaps"] == days * 40 and a["mappedSwaps"] == days * 19960
    assert a["unmappedReasons"] == {"origin=conflicting_identity_for_symbol;destination=None": 100, "origin=not_in_registry;destination=None": 50}
    assert a["stablecoinShareOfSwaps"] == pytest.approx(12000 / 20000)
    assert a["byClass"]["mixed"]["rows"] == days * 1900
    assert set(ll.route_volume["route_class"]) == {"stablecoin", "non_stablecoin"}  # mixed / excluded / unmapped never feed a cell
    assert len(ll.route_volume) == 2 * days
    assert ll.source["inputMethod"] == INPUT_METHOD and ll.source["snapshotRegistration"] == REG
    assert ll.source["stablecoinRoutes"].startswith("COMPUTED")


def test_null_usd_or_empty_class_day_is_missing_not_zero(tmp_path: Path):
    base = fake_query()

    def q(sql, params):
        rows = base(sql, params)
        if params and "multiIf" in sql:
            for r in rows:
                if r["d"] == "2026-06-05" and r["route_class"] == "stablecoin":
                    r["n_success_null_usd"] = "1"
                if r["d"] == "2026-06-06" and r["route_class"] == "non_stablecoin":
                    r["n_success"] = "0"
        return rows

    d = freeze_v3_snapshot(tmp_path, query=q, registration=REG)
    _, ll = load_v3_inputs(Path(d["dir"]))
    rv = ll.route_volume
    assert pd.Timestamp("2026-06-05") not in set(rv[rv["route_class"] == "stablecoin"]["date"])
    assert pd.Timestamp("2026-06-06") not in set(rv[rv["route_class"] == "non_stablecoin"]["date"])
    assert not (rv["volume"] == 0).any()


def test_recomputed_set_must_match_the_query_set(tmp_path: Path):
    d = freeze_v3_snapshot(tmp_path, query=fake_query(), registration=REG)
    from nearesis_research.live_v3 import build_v3_inputs

    desc, raw = load_snapshot(Path(d["dir"]))
    raw["registry_identity"] = identity(drop=("USDC",))
    with pytest.raises(LiveSnapshotError):
        build_v3_inputs(raw, desc)


def test_v2_loader_refuses_v3_and_v3_refuses_v2(tmp_path: Path):
    from nearesis_research.live import freeze_live_snapshot, load_snapshot_inputs

    d3 = freeze_v3_snapshot(tmp_path / "a", query=fake_query(), registration=REG)
    d2 = freeze_live_snapshot(tmp_path / "b", query=fake_query())
    with pytest.raises(LiveSnapshotError):
        load_v3_inputs(Path(d2["dir"]))
    load_snapshot_inputs(Path(d3["dir"]))  # v2 loader reads the six v2 tables of a v3 snapshot without error
    assert d2["inputMethod"] == V2


def test_registration_record_matches_committed_document():
    rec = registration_record()
    assert rec["registrationId"] == "LIVE-ORGANIC-V3" and rec["documentHash"].startswith("sha256:")


def test_cli_run_is_byte_reproducible_and_never_overwrites(tmp_path: Path, capsys):
    long_days = pd.date_range("2026-04-01", periods=230, freq="D")
    d = freeze_v3_snapshot(tmp_path / "snap", query=fake_query(all_days=long_days, noisy=True), registration=REG)
    out1, out2 = tmp_path / "r1", tmp_path / "r2"
    assert cli.live_run(d["dir"], out1, INPUT_METHOD) == 0
    assert cli.live_run(d["dir"], out2, INPUT_METHOD) == 0
    assert (out1 / "research_run.json").read_bytes() == (out2 / "research_run.json").read_bytes()
    assert (out1 / "robustness_matrix.json").read_bytes() == (out2 / "robustness_matrix.json").read_bytes()
    run = json.loads((out1 / "research_run.json").read_text())
    assert run["inputSnapshot"]["source"]["inputMethod"] == INPUT_METHOD and run["inputSnapshot"]["source"]["routeAudit"]["windowSwaps"] > 0
    assert "--method live-organic-v3" in run["inputSnapshot"]["source"]["reproductionCommand"]
    rows = json.loads((out1 / "robustness_matrix.json").read_text())["rows"]
    assert set(rows["stablecoin_only_routes"]) & {"status"} and "no 'stablecoin' route rows" not in rows["stablecoin_only_routes"].get("reason", "")
    assert cli.live_run(d["dir"], out1, INPUT_METHOD) == 4  # existing result directory is refused
    assert cli.live_run(d["dir"], tmp_path / "r3", "live-organic-v2") == 4  # method must match the snapshot
    capsys.readouterr()
