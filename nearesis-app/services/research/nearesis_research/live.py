"""Live loader from ClickHouse `nearesis_live`, and the pinned-snapshot path for live research inputs.

Two steps, so a live analysis never reads a moving table:

1. `freeze_live_snapshot` queries `nearesis_live` once (read-only, date-bounded, partition-filtered), writes every raw
   result set as canonical JSON with its SHA-256 into a new directory and derives the snapshot id from the content
   hashes, the window and the input-method version. An existing directory is never overwritten: identical content gives
   the same id and is reused, different content gives a different id.
2. `load_snapshot_inputs` rebuilds the analysis `Inputs` as a pure function of the pinned files (hashes verified). The
   experiment runs against that, never against ClickHouse.

Input method `live-organic-v2` (supersedes `live-aggregate-v1`, which used the unadjusted `near_daily_tx.tx_count`):
the target is `account_daily_activity.tx_organic` (Intents-verifier and bridge transactions removed by the ingestion
account rule, version recorded). Missing days stay NaN, never 0. Swap volume is the sum of known USD for SUCCESS swaps;
a SUCCESS swap with a NULL USD amount makes that day's volume incomplete (never zero). Swap days are bounded by an
explicit rule: the first day is kept only if its row count reaches half of the median of the following seven days (the
ingestion window opens mid-day) and the newest day present is excluded as still being written. `intents_swaps` has no
`source_coverage` rows, so swap completeness is inferred from counts and recorded as such."""

from __future__ import annotations

import base64
import json
import os
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

from .core import canonical_json, sha256_hex
from .dataset import Inputs

DB = "nearesis_live"
INPUT_METHOD = "live-organic-v2"
SNAPSHOT_SCHEMA = "nearesis.research.live-snapshot.v1"
QueryFn = Callable[[str, "dict | None"], "list[dict]"]


def ch_query(sql: str, params: dict | None = None) -> list[dict]:
    url = os.environ.get("NEARESIS_CH_URL", "http://127.0.0.1:58123")
    user = os.environ.get("NEARESIS_CH_USER", "nearesis")
    pw = os.environ.get("NEARESIS_CH_PASSWORD", "nearesis")
    if not url.startswith(("http://127.0.0.1", "http://localhost")):
        raise RuntimeError("live loader only talks to the local ClickHouse")
    q = {"default_format": "JSON", "max_result_rows": "100000", "readonly": "1"}
    for k, v in (params or {}).items():
        q[f"param_{k}"] = str(v)
    req = urllib.request.Request(url + "/?" + urllib.parse.urlencode(q), data=sql.encode(), method="POST")
    req.add_header("Authorization", "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode())
    with urllib.request.urlopen(req, timeout=60) as r:  # nosec - fixed local host
        return json.loads(r.read())["data"]


# ---- swap window rule ----------------------------------------------------------------------------------------------

def resolve_swap_window(day_counts: list[dict]) -> dict:
    """day_counts: [{d, n}] ascending. Returns the first/last day kept and the days dropped with a reason."""
    days = sorted((pd.Timestamp(r["d"]), int(r["n"])) for r in day_counts)
    if len(days) < 9:
        return {"first": None, "last": None, "dropped": [], "reason": "fewer than 9 swap days"}
    dropped = []
    newest = days[-1][0]
    kept = days[:-1]
    dropped.append({"day": newest.strftime("%Y-%m-%d"), "n": days[-1][1], "reason": "newest day present, still being written"})
    first_d, first_n = kept[0]
    med = float(np.median([n for _, n in kept[1:8]]))
    if first_n < 0.5 * med:
        dropped.append({"day": first_d.strftime("%Y-%m-%d"), "n": first_n, "reason": f"partial first day ({first_n} rows < half of the next-seven-day median {med:g})"})
        kept = kept[1:]
    return {"first": kept[0][0].strftime("%Y-%m-%d"), "last": kept[-1][0].strftime("%Y-%m-%d"), "dropped": dropped, "reason": None}


# ---- raw queries -------------------------------------------------------------------------------------------------

def _queries(start: str, end: str) -> dict[str, str]:
    return {
        "near_daily_tx": f"SELECT block_date AS d, tx_count AS y FROM {DB}.near_daily_tx FINAL WHERE block_date BETWEEN {{s:Date}} AND {{e:Date}} ORDER BY d",
        "account_daily_activity": (
            f"SELECT block_date AS d, tx_total, tx_intents, tx_bridge, tx_organic, top1pct_organic_tx, top5pct_organic_tx, account_rule_version "
            f"FROM {DB}.account_daily_activity FINAL WHERE block_date BETWEEN {{s:Date}} AND {{e:Date}} ORDER BY d"
        ),
        "price": (
            f"SELECT day AS d, toFloat64(argMax(close, bucket_start)) AS price FROM {DB}.price_candles FINAL "
            f"WHERE day BETWEEN {{s:Date}} AND {{e:Date}} AND `interval`='1d' AND symbol='NEAR' AND quote_currency='usd' GROUP BY d ORDER BY d"
        ),
        "swaps": (
            f"SELECT created_day AS d, count() AS n, countIf(status='SUCCESS') AS n_success, "
            f"countIf(status='SUCCESS' AND amount_in_usd IS NULL) AS n_success_null_usd, "
            f"toFloat64(sumIf(amount_in_usd, amount_in_usd IS NOT NULL AND status='SUCCESS')) AS vol "
            f"FROM {DB}.intents_swaps FINAL WHERE created_day BETWEEN {{s:Date}} AND {{e:Date}} GROUP BY d ORDER BY d"
        ),
        "swaps_by_privacy_era": (
            f"SELECT created_day AS d, privacy_era AS era, countIf(status='SUCCESS') AS n_success, "
            f"countIf(status='SUCCESS' AND amount_in_usd IS NULL) AS n_success_null_usd, "
            f"toFloat64(sumIf(amount_in_usd, amount_in_usd IS NOT NULL AND status='SUCCESS')) AS vol "
            f"FROM {DB}.intents_swaps FINAL WHERE created_day BETWEEN {{s:Date}} AND {{e:Date}} GROUP BY d, era ORDER BY d, era"
        ),
        "source_coverage": (
            f"SELECT dataset, state, count() AS days, min(day) AS first_day, max(day) AS last_day FROM {DB}.source_coverage FINAL "
            f"WHERE day BETWEEN {{s:Date}} AND {{e:Date}} GROUP BY dataset, state ORDER BY dataset, state"
        ),
    }


def _swap_days(query: QueryFn) -> list[dict]:
    return query(f"SELECT created_day AS d, count() AS n FROM {DB}.intents_swaps FINAL GROUP BY d ORDER BY d", None)


# ---- pure construction from raw rows -------------------------------------------------------------------------------

@dataclass
class LiveLoad:
    inputs: Inputs
    source: dict
    complete: bool
    reasons: list


def _ser(rows: list[dict], col: str, cal: pd.DatetimeIndex, cast=float) -> pd.Series:
    return pd.Series({pd.Timestamp(r["d"]): cast(r[col]) for r in rows}, dtype=float).reindex(cal)


def build_live_inputs(raw: dict[str, list[dict]], start: str, end: str) -> LiveLoad:
    cal = pd.date_range(start, end, freq="D")
    tx, act, px, sw, era, cov = (raw[k] for k in ("near_daily_tx", "account_daily_activity", "price", "swaps", "swaps_by_privacy_era", "source_coverage"))
    aggregate = _ser(tx, "y", cal)
    organic = _ser(act, "tx_organic", cal)
    price = _ser(px, "price", cal)
    vol = pd.Series({pd.Timestamp(r["d"]): (float(r["vol"]) if int(r["n_success"]) > 0 else np.nan) for r in sw}, dtype=float).reindex(cal)
    comp = pd.Series({pd.Timestamp(r["d"]): 1.0 - int(r["n_success_null_usd"]) / max(int(r["n_success"]), 1) for r in sw}, dtype=float).reindex(cal)
    reasons: list[str] = []
    for name, s in (("account_daily_activity.tx_organic", organic), ("price_candles", price), ("intents_swaps", vol)):
        miss = int(s.isna().sum())
        if miss:
            reasons.append(f"{name}: {miss}/{len(cal)} days missing (kept NaN, never zero)")
    if comp.dropna().lt(1.0).any():
        n_days = int(comp.dropna().lt(1.0).sum())
        reasons.append(f"intents_swaps: {n_days} day(s) have SUCCESS swaps with NULL USD amounts (volume incomplete, not zero)")
    versions = sorted({int(r["account_rule_version"]) for r in act})
    if len(versions) > 1:
        reasons.append(f"account_rule_version changes inside the window: {versions}")
    partial = [c for c in cov if c["state"] != "complete"]
    if partial:
        reasons.append("source_coverage reports non-complete states: " + json.dumps(partial, sort_keys=True))
    cohort = {1: _ser(act, "top1pct_organic_tx", cal), 5: _ser(act, "top5pct_organic_tx", cal)}
    priv: dict[str, pd.Series] = {}
    for name in sorted({r["era"] for r in era}):
        rr = [r for r in era if r["era"] == name]
        priv[name] = pd.Series({pd.Timestamp(r["d"]): (float(r["vol"]) if int(r["n_success"]) > 0 and int(r["n_success_null_usd"]) == 0 else np.nan) for r in rr}, dtype=float).reindex(cal)
    daily = pd.DataFrame({"date": cal, "intents_volume_usd": vol.to_numpy(), "price_close": price.to_numpy()})
    inputs = Inputs(
        daily=daily, accounts=None, target_aggregate=organic, label="LIVE", volume_completeness=comp,
        extra_incomplete=tuple(reasons), cohort_tx=cohort, privacy_volume=priv,
    )
    n_agg = int((aggregate - organic).dropna().lt(0).sum())
    src = {
        "label": "LIVE",
        "inputMethod": INPUT_METHOD,
        "range": [start, end],
        "target": "account_daily_activity.tx_organic (organic successful transactions; Intents-verifier and bridge removed by account rule)",
        "accountRuleVersions": versions,
        "organicExceedsAggregateDays": n_agg,
        "unadjustedAggregateDays": int(aggregate.notna().sum()),
        "coverageRows": cov,
        "stablecoinRoutes": "NOT_COMPUTABLE: intents_swaps.canonical_origin_asset is NULL for every row, so there is no asset registry to classify routes",
    }
    return LiveLoad(inputs, src, complete=not reasons, reasons=reasons)


# ---- snapshot freeze and load --------------------------------------------------------------------------------------

class LiveSnapshotError(RuntimeError):
    pass


def freeze_live_snapshot(out_root: Path, start: str | None = None, end: str | None = None, query: QueryFn = ch_query, now: datetime | None = None) -> dict:
    """Queries once and writes a new pinned snapshot directory. Returns the descriptor (with `dir` and `reused`)."""
    win = resolve_swap_window(_swap_days(query))
    if win["first"] is None:
        raise LiveSnapshotError(win["reason"])
    start, end = start or win["first"], end or win["last"]
    if pd.Timestamp(start) < pd.Timestamp(win["first"]) or pd.Timestamp(end) > pd.Timestamp(win["last"]):
        raise LiveSnapshotError(f"requested window {start}..{end} exceeds the resolved complete swap window {win['first']}..{win['last']}")
    qs = _queries(start, end)
    raw = {k: query(sql, {"s": start, "e": end}) for k, sql in qs.items()}
    files = {}
    for k, rows in raw.items():
        body = canonical_json(rows)
        files[k] = {"path": f"raw/{k}.json", "sha256": sha256_hex(body), "bytes": len(body.encode()), "rows": len(rows)}
    data_hash = sha256_hex(canonical_json({k: v["sha256"] for k, v in sorted(files.items())}))
    sid = f"live-{start.replace('-', '')}-{end.replace('-', '')}-{INPUT_METHOD}-{data_hash[:12]}"
    d = Path(out_root) / sid
    reused = d.exists()
    if reused:
        desc = json.loads((d / "snapshot.json").read_text())
        load_snapshot(d)  # verifies existing bytes; a mismatch raises, nothing is overwritten
        return {**desc, "dir": str(d), "reused": True}
    (d / "raw").mkdir(parents=True)
    for k, rows in raw.items():
        (d / files[k]["path"]).write_text(canonical_json(rows))
    desc = {
        "schema": SNAPSHOT_SCHEMA,
        "snapshotId": sid,
        "inputMethod": INPUT_METHOD,
        "frozenAt": (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window": {"start": start, "end": end},
        "swapWindowRule": win,
        "dataHash": "sha256:" + data_hash,
        "database": DB,
        "queries": qs,
        "files": files,
    }
    (d / "snapshot.json").write_text(json.dumps(desc, indent=2, sort_keys=True) + "\n")
    return {**desc, "dir": str(d), "reused": False}


def load_snapshot(d: Path) -> tuple[dict, dict[str, list[dict]]]:
    d = Path(d)
    desc = json.loads((d / "snapshot.json").read_text())
    if desc.get("schema") != SNAPSHOT_SCHEMA:
        raise LiveSnapshotError("unknown snapshot schema")
    raw = {}
    for k, f in desc["files"].items():
        body = (d / f["path"]).read_text()
        if sha256_hex(body) != f["sha256"] or len(body.encode()) != f["bytes"]:
            raise LiveSnapshotError(f"raw bytes differ from the frozen hash: {f['path']}")
        raw[k] = json.loads(body)
    return desc, raw


def load_snapshot_inputs(d: Path) -> tuple[dict, LiveLoad]:
    desc, raw = load_snapshot(d)
    ll = build_live_inputs(raw, desc["window"]["start"], desc["window"]["end"])
    ll.source.update({"snapshotId": desc["snapshotId"], "snapshotDataHash": desc["dataHash"], "frozenAt": desc["frozenAt"], "swapWindowRule": desc["swapWindowRule"]})
    return desc, ll


def load_live(start: str, end: str, query: QueryFn = ch_query) -> LiveLoad:
    """Unpinned direct read (exploration only; research runs must go through a pinned snapshot)."""
    p = {"s": start, "e": end}
    raw = {k: query(sql, p) for k, sql in _queries(start, end).items()}
    return build_live_inputs(raw, start, end)
