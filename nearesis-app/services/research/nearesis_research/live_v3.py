"""Input method `live-organic-v3`: `live-organic-v2` plus stablecoin / non-stablecoin route cells.

The rules are declared in `docs/research/LIVE-ORGANIC-V3-REGISTRATION.md` (hash in its `.freeze.json`) before any v3
snapshot or result existed. Everything not about routes is the v2 code, imported unchanged (`live.build_live_inputs`,
`live.resolve_swap_window`, `live.load_snapshot`); `live-organic-v2` behaviour is not modified.

Route classes (per swap, first match wins): `unmapped` (either canonical leg NULL), `excluded_declared` (a leg is a
declared exclusion or a candidate whose registry identity check failed), `stablecoin` (both legs in the verified set),
`non_stablecoin` (neither leg in the set), `mixed`. Unknown, conflicting and NULL rows are excluded and counted, never
guessed. The stablecoin set is a function of the frozen `registry_identity` table only."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from .core import canonical_json, sha256_hex
from .frozen import APP_ROOT, canonical_bytes
from .live import (
    DB,
    SNAPSHOT_SCHEMA,
    LiveLoad,
    LiveSnapshotError,
    QueryFn,
    _queries,
    _swap_days,
    build_live_inputs,
    ch_query,
    load_snapshot,
    resolve_swap_window,
)

INPUT_METHOD = "live-organic-v3"
REGISTRATION_DOC = APP_ROOT / "docs" / "research" / "LIVE-ORGANIC-V3-REGISTRATION.md"
REGISTRATION_FREEZE = APP_ROOT / "docs" / "research" / "LIVE-ORGANIC-V3-REGISTRATION.freeze.json"

# Declared in the registration: candidate canonical symbol -> required coingeckoId.
STABLE_CANDIDATES = {
    "USDT": "tether", "USDC": "usd-coin", "DAI": "dai", "USDT0": "usdt0", "USD1": "usd1-wlfi",
    "USDG": "global-dollar", "USDe": "ethena-usde", "USDf": "falcon-finance", "FRAX": "frax", "USDCX": "usdcx",
}
DECLARED_EXCLUDED = ("USAD", "sUSDC", "nrUsdt", "xDAI", "EURe", "GBPe", "XAUT")
STALE_NULL_SHARE_MAX = 0.01  # window ends before the first day whose stale-NULL share reaches this
ROUTE_CLASSES = ("unmapped", "excluded_declared", "stablecoin", "non_stablecoin", "mixed")
V2_KEYS = ("near_daily_tx", "account_daily_activity", "price", "swaps", "swaps_by_privacy_era", "source_coverage")
V3_KEYS = ("registry_identity", "route_day_quality", "swaps_routes", "unmapped_reasons")
_SYMBOL = re.compile(r"^[A-Za-z0-9_]+$")


# ---- registration record -------------------------------------------------------------------------------------------

def registration_record(doc: Path = REGISTRATION_DOC, freeze: Path = REGISTRATION_FREEZE) -> dict:
    """The pre-run registration; refused if the document no longer matches its freeze hash."""
    rec = json.loads(Path(freeze).read_text())
    h = "sha256:" + hashlib.sha256(canonical_bytes(Path(doc).read_text(encoding="utf-8"))).hexdigest()
    if h != rec["documentHash"]:
        raise LiveSnapshotError("live-organic-v3 registration document differs from its freeze record")
    return {"registrationId": rec["registrationId"], "documentHash": rec["documentHash"], "frozenAt": rec["frozenAt"]}


# ---- stablecoin set from registry identity -------------------------------------------------------------------------

def resolve_stable_set(registry_rows: list[dict]) -> dict:
    """registry_identity rows: {sym, ids:[coingecko ids], verifications:[...], n}. A candidate is in the set only if its
    rows are all verified with exactly the one declared coingeckoId. Others are unresolved with a reason."""
    by = {r["sym"]: r for r in registry_rows}
    stable, unresolved = [], {}
    for sym, want in STABLE_CANDIDATES.items():
        r = by.get(sym)
        if r is None:
            unresolved[sym] = "not_in_registry"
        elif sorted(set(r["verifications"])) != ["verified"]:
            unresolved[sym] = "not_verified"
        elif len(set(r["ids"])) != 1 or None in r["ids"]:
            unresolved[sym] = "conflicting_or_missing_identity"
        elif r["ids"][0] != want:
            unresolved[sym] = f"identity_differs_from_declared ({r['ids'][0]})"
        else:
            stable.append(sym)
    return {"stable": sorted(stable), "unresolved": dict(sorted(unresolved.items()))}


def _lit(symbols) -> str:
    syms = sorted(symbols)
    for s in syms:
        if not _SYMBOL.match(s):
            raise LiveSnapshotError(f"unsafe symbol in set: {s!r}")
    return "(" + ",".join(f"'{s}'" for s in syms) + ")" if syms else "('')"


# ---- queries -------------------------------------------------------------------------------------------------------

_REG_LATEST = f"(SELECT provider_asset_id AS pid, argMax(canonical_asset_id, version) AS c FROM {DB}.asset_registry GROUP BY pid)"


def registry_sql() -> str:
    return (
        "SELECT sym, groupArray(coingecko_id) AS ids, groupArray(verification) AS verifications, count() AS n FROM ("
        f"SELECT provider_asset_id, argMax(canonical_asset_id, version) AS sym, argMax(coingecko_id, version) AS coingecko_id, argMax(verification, version) AS verification "
        f"FROM {DB}.asset_registry GROUP BY provider_asset_id) WHERE sym IS NOT NULL GROUP BY sym ORDER BY sym"
    )


def quality_sql() -> str:
    return (
        "SELECT s.created_day AS d, count() AS n, countIf(s.canonical_origin_asset IS NULL OR s.canonical_destination_asset IS NULL) AS n_null, "
        "countIf((s.canonical_origin_asset IS NULL AND ro.c IS NOT NULL AND ro.c != '') OR (s.canonical_destination_asset IS NULL AND rd.c IS NOT NULL AND rd.c != '')) AS n_stale "
        f"FROM {DB}.intents_swaps AS s FINAL LEFT JOIN {_REG_LATEST} AS ro ON ro.pid = s.origin_asset LEFT JOIN {_REG_LATEST} AS rd ON rd.pid = s.destination_asset "
        "WHERE s.created_day BETWEEN {s:Date} AND {e:Date} GROUP BY d ORDER BY d"
    )


def routes_sql(stable: list[str], unresolved: list[str]) -> str:
    excl = _lit(set(DECLARED_EXCLUDED) | set(unresolved))
    st = _lit(stable)
    return (
        "SELECT created_day AS d, route_class, count() AS n, countIf(status = 'SUCCESS') AS n_success, "
        "countIf(status = 'SUCCESS' AND amount_in_usd IS NULL) AS n_success_null_usd, "
        "toFloat64(sumIf(amount_in_usd, amount_in_usd IS NOT NULL AND status = 'SUCCESS')) AS vol FROM ("
        "SELECT created_day, status, amount_in_usd, canonical_origin_asset AS o, canonical_destination_asset AS t, "
        f"multiIf(o IS NULL OR t IS NULL, 'unmapped', o IN {excl} OR t IN {excl}, 'excluded_declared', o IN {st} AND t IN {st}, 'stablecoin', "
        f"o NOT IN {st} AND t NOT IN {st}, 'non_stablecoin', 'mixed') AS route_class "
        f"FROM {DB}.intents_swaps FINAL WHERE created_day BETWEEN {{s:Date}} AND {{e:Date}}) GROUP BY d, route_class ORDER BY d, route_class"
    )


def unmapped_reasons_sql() -> str:
    return (
        "SELECT a.origin_unknown_reason AS origin_reason, a.destination_unknown_reason AS destination_reason, count() AS n "
        f"FROM {DB}.intents_swap_asset_status AS a INNER JOIN (SELECT swap_key FROM {DB}.intents_swaps FINAL WHERE created_day BETWEEN {{s:Date}} AND {{e:Date}}) AS s ON s.swap_key = a.swap_key "
        "WHERE a.origin_mapped = 0 OR a.destination_mapped = 0 GROUP BY origin_reason, destination_reason ORDER BY origin_reason, destination_reason"
    )


def stale_window_end(quality: list[dict], end: str) -> dict:
    """Window end truncated to the day before the first day whose stale-NULL share reaches STALE_NULL_SHARE_MAX."""
    for r in sorted(quality, key=lambda r: r["d"]):
        n = int(r["n"])
        if n and int(r["n_stale"]) / n >= STALE_NULL_SHARE_MAX:
            first_bad = pd.Timestamp(r["d"])
            return {"end": min(pd.Timestamp(end), first_bad - pd.Timedelta(days=1)).strftime("%Y-%m-%d"), "truncatedBy": r["d"], "staleShare": int(r["n_stale"]) / n}
    return {"end": end, "truncatedBy": None, "staleShare": None}


# ---- freeze ---------------------------------------------------------------------------------------------------------

def freeze_v3_snapshot(out_root: Path, start: str | None = None, end: str | None = None, query: QueryFn = ch_query, now: datetime | None = None, registration: dict | None = None) -> dict:
    """Queries once and writes a new pinned v3 snapshot directory. Never overwrites; identical content is reused."""
    reg = registration or registration_record()
    win = resolve_swap_window(_swap_days(query))
    if win["first"] is None:
        raise LiveSnapshotError(win["reason"])
    start, end = start or win["first"], end or win["last"]
    if pd.Timestamp(start) < pd.Timestamp(win["first"]) or pd.Timestamp(end) > pd.Timestamp(win["last"]):
        raise LiveSnapshotError(f"requested window {start}..{end} exceeds the resolved complete swap window {win['first']}..{win['last']}")
    p = {"s": start, "e": end}
    registry_rows = query(registry_sql(), p)
    sset = resolve_stable_set(registry_rows)
    quality = query(quality_sql(), p)
    trunc = stale_window_end(quality, end)
    if trunc["end"] != end:
        if pd.Timestamp(trunc["end"]) < pd.Timestamp(start) + pd.Timedelta(days=8):
            raise LiveSnapshotError(f"stale NULL-canonical rows leave fewer than 9 days (window would end {trunc['end']})")
        end = trunc["end"]
        p = {"s": start, "e": end}
        quality = [r for r in quality if r["d"] <= end]
    qs = {**_queries(start, end), "registry_identity": registry_sql(), "route_day_quality": quality_sql(),
          "swaps_routes": routes_sql(sset["stable"], list(sset["unresolved"])), "unmapped_reasons": unmapped_reasons_sql()}
    raw = {k: (registry_rows if k == "registry_identity" else quality if k == "route_day_quality" else query(sql, p)) for k, sql in qs.items()}
    files = {}
    for k, rows in raw.items():
        body = canonical_json(rows)
        files[k] = {"path": f"raw/{k}.json", "sha256": sha256_hex(body), "bytes": len(body.encode()), "rows": len(rows)}
    data_hash = sha256_hex(canonical_json({k: v["sha256"] for k, v in sorted(files.items())}))
    sid = f"live-{start.replace('-', '')}-{end.replace('-', '')}-{INPUT_METHOD}-{data_hash[:12]}"
    d = Path(out_root) / sid
    if d.exists():
        desc = json.loads((d / "snapshot.json").read_text())
        load_snapshot(d)  # verifies existing bytes; a mismatch raises, nothing is overwritten
        return {**desc, "dir": str(d), "reused": True}
    (d / "raw").mkdir(parents=True)
    for k, rows in raw.items():
        (d / files[k]["path"]).write_text(canonical_json(rows))
    desc = {
        "schema": SNAPSHOT_SCHEMA, "snapshotId": sid, "inputMethod": INPUT_METHOD,
        "frozenAt": (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "window": {"start": start, "end": end}, "swapWindowRule": win, "staleNullWindowRule": {**trunc, "maxShare": STALE_NULL_SHARE_MAX},
        "stablecoinSet": sset, "declaredExcluded": list(DECLARED_EXCLUDED), "registration": reg,
        "dataHash": "sha256:" + data_hash, "database": DB, "queries": qs, "files": files,
    }
    (d / "snapshot.json").write_text(json.dumps(desc, indent=2, sort_keys=True) + "\n")
    return {**desc, "dir": str(d), "reused": False}


# ---- load -----------------------------------------------------------------------------------------------------------

@dataclass
class LiveLoadV3(LiveLoad):
    route_volume: pd.DataFrame
    audit: dict


def build_v3_inputs(raw: dict[str, list[dict]], desc: dict) -> LiveLoadV3:
    start, end = desc["window"]["start"], desc["window"]["end"]
    base = build_live_inputs({k: raw[k] for k in V2_KEYS}, start, end)
    sset = resolve_stable_set(raw["registry_identity"])
    if sset != desc["stablecoinSet"]:
        raise LiveSnapshotError("stablecoin set recomputed from the frozen registry identity differs from the one the queries used")
    rows = raw["swaps_routes"]
    cls = {c: {"rows": 0, "successSwaps": 0, "successNullUsd": 0, "knownUsdVolume": 0.0} for c in ROUTE_CLASSES}
    vol_rows = []
    for r in rows:
        c = r["route_class"]
        if c not in cls:
            raise LiveSnapshotError(f"unknown route class in snapshot: {c}")
        n_s, n_null = int(r["n_success"]), int(r["n_success_null_usd"])
        cls[c]["rows"] += int(r["n"])
        cls[c]["successSwaps"] += n_s
        cls[c]["successNullUsd"] += n_null
        cls[c]["knownUsdVolume"] += float(r["vol"])
        if c in ("stablecoin", "non_stablecoin"):
            ok = n_s > 0 and n_null == 0
            vol_rows.append({"date": pd.Timestamp(r["d"]), "route_class": c, "volume": float(r["vol"]) if ok else np.nan})
    rv = pd.DataFrame(vol_rows, columns=["date", "route_class", "volume"]).dropna(subset=["volume"]).reset_index(drop=True)
    total_rows = sum(v["rows"] for v in cls.values())
    total_usd = sum(v["knownUsdVolume"] for v in cls.values())
    reasons: dict[str, int] = {}
    for r in raw["unmapped_reasons"]:
        key = f"origin={r['origin_reason']};destination={r['destination_reason']}"
        reasons[key] = reasons.get(key, 0) + int(r["n"])
    q = raw["route_day_quality"]
    stale = sum(int(r["n_stale"]) for r in q)
    stable_days = int(rv[rv["route_class"] == "stablecoin"]["date"].nunique())
    nonstable_days = int(rv[rv["route_class"] == "non_stablecoin"]["date"].nunique())
    audit = {
        "windowSwaps": total_rows,
        "mappedSwaps": total_rows - cls["unmapped"]["rows"],
        "unmappedOrNullCanonicalSwaps": cls["unmapped"]["rows"],
        "unmappedShare": cls["unmapped"]["rows"] / total_rows if total_rows else None,
        "unmappedReasons": dict(sorted(reasons.items())),
        "staleNullCanonicalRows": stale,
        "byClass": cls,
        "stablecoinShareOfSwaps": cls["stablecoin"]["rows"] / total_rows if total_rows else None,
        "stablecoinShareOfKnownUsdVolume": cls["stablecoin"]["knownUsdVolume"] / total_usd if total_usd else None,
        "stablecoinSet": sset["stable"], "unresolvedCandidates": sset["unresolved"], "declaredExcluded": desc["declaredExcluded"],
        "routeDaysWithVolume": {"stablecoin": stable_days, "non_stablecoin": nonstable_days},
    }
    src = dict(base.source)
    src.update({
        "inputMethod": INPUT_METHOD,
        "stablecoinRoutes": f"COMPUTED (live-organic-v3, canonical asset registry): stablecoin and non-stablecoin route cells are descriptive robustness rows in robustness_matrix.json and do not enter the verdict; {cls['unmapped']['rows']} of {total_rows} swaps are unmapped and excluded, not guessed",
        "routeAudit": audit,
        "snapshotRegistration": desc["registration"],
        "staleNullWindowRule": desc["staleNullWindowRule"],
    })
    return LiveLoadV3(base.inputs, src, base.complete, base.reasons, rv, audit)


def load_v3_inputs(d: Path) -> tuple[dict, LiveLoadV3]:
    desc, raw = load_snapshot(d)
    if desc.get("inputMethod") != INPUT_METHOD:
        raise LiveSnapshotError(f"snapshot input method is {desc.get('inputMethod')}, not {INPUT_METHOD}")
    missing = [k for k in V2_KEYS + V3_KEYS if k not in raw]
    if missing:
        raise LiveSnapshotError(f"snapshot lacks raw tables {missing}")
    ll = build_v3_inputs(raw, desc)
    ll.source.update({"snapshotId": desc["snapshotId"], "snapshotDataHash": desc["dataHash"], "frozenAt": desc["frozenAt"], "swapWindowRule": desc["swapWindowRule"]})
    return desc, ll
