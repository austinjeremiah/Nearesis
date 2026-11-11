"""Live loader from ClickHouse `nearesis_live`. Reads actual coverage and refuses to mark a dataset complete when
partial. Missing swaps/volumes are NaN, never 0. Read-only, parameterised by date range, partition-filtered.

The daily aggregate target available live is BigQuery `near_daily_tx.tx_count` (all transactions, unadjusted): the
organic target (Intents-generated accounts excluded) cannot be derived from it, which is recorded as a limitation and
caps the verdict at INSUFFICIENT_DATA when the dataset is not complete."""

from __future__ import annotations

import base64
import json
import os
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd

from .core import sha256_hex
from .dataset import Inputs

DB = "nearesis_live"


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


@dataclass
class LiveLoad:
    inputs: Inputs
    source: dict
    complete: bool
    reasons: list


def load_live(start: str, end: str, query: Callable[[str, dict | None], list[dict]] = ch_query) -> LiveLoad:
    p = {"s": start, "e": end}
    tx = query(f"SELECT block_date AS d, tx_count AS y FROM {DB}.near_daily_tx FINAL WHERE block_date BETWEEN {{s:Date}} AND {{e:Date}} ORDER BY d", p)
    px = query(
        f"SELECT day AS d, toFloat64(argMax(close, bucket_start)) AS price FROM {DB}.price_candles FINAL "
        f"WHERE day BETWEEN {{s:Date}} AND {{e:Date}} AND `interval`='1d' AND symbol='NEAR' AND quote_currency='usd' GROUP BY d ORDER BY d", p)
    sw = query(
        f"SELECT created_day AS d, count() AS n, countIf(amount_in_usd IS NULL) AS n_null, "
        f"toFloat64(sumIf(amount_in_usd, amount_in_usd IS NOT NULL AND status='SUCCESS')) AS vol "
        f"FROM {DB}.intents_swaps FINAL WHERE created_day BETWEEN {{s:Date}} AND {{e:Date}} GROUP BY d ORDER BY d", p)
    cov = query(
        f"SELECT dataset, state, count() AS days FROM {DB}.source_coverage FINAL WHERE day BETWEEN {{s:Date}} AND {{e:Date}} "
        f"GROUP BY dataset, state", p)
    cal = pd.date_range(start, end, freq="D")
    y = pd.Series({pd.Timestamp(r["d"]): float(r["y"]) for r in tx}, dtype=float).reindex(cal)
    price = pd.Series({pd.Timestamp(r["d"]): float(r["price"]) for r in px}, dtype=float).reindex(cal)
    vol = pd.Series({pd.Timestamp(r["d"]): (float(r["vol"]) if int(r["n"]) > 0 else np.nan) for r in sw}, dtype=float).reindex(cal)
    comp = pd.Series({pd.Timestamp(r["d"]): 1.0 - int(r["n_null"]) / max(int(r["n"]), 1) for r in sw}, dtype=float).reindex(cal)
    reasons = []
    for name, s in (("near_daily_tx", y), ("price_candles", price), ("intents_swaps", vol)):
        miss = int(s.isna().sum())
        if miss:
            reasons.append(f"{name}: {miss}/{len(cal)} days missing (kept NaN, never zero)")
    if comp.dropna().lt(1.0).any():
        reasons.append("intents_swaps: some days have NULL USD amounts (volume incomplete, not zero)")
    partial = [c for c in cov if c["state"] != "complete"]
    if partial:
        reasons.append("source_coverage reports non-complete states: " + json.dumps(partial, sort_keys=True))
    reasons.append("target is unadjusted near_daily_tx.tx_count; organic target (Intents accounts excluded) is not derivable from the daily aggregate")
    daily = pd.DataFrame({"date": cal, "intents_volume_usd": vol.to_numpy(), "price_close": price.to_numpy()})
    inputs = Inputs(daily=daily, accounts=None, target_aggregate=y, label="LIVE", volume_completeness=comp, extra_incomplete=tuple(reasons))
    src = {
        "label": "LIVE",
        "range": [start, end],
        "queryHashes": {n: sha256_hex(json.dumps(r, sort_keys=True, default=str)) for n, r in (("near_daily_tx", tx), ("price", px), ("swaps", sw), ("coverage", cov))},
        "coverageRows": cov,
    }
    return LiveLoad(inputs, src, complete=False if reasons else True, reasons=reasons)
