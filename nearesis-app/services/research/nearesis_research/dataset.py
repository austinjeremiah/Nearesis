"""Point-in-time dataset construction (ch.02, ch.08).

Rules enforced here:
- every input is reindexed to a complete UTC-day calendar; a missing day is NaN, never 0 and never forward-filled;
- a feature `<src>_lag<L>` at origin t equals source[t-L] with L >= 0 (explicit, calendar-true lag alignment);
- the target for horizon h at origin t is log1p(y)[t+h];
- rows with any missing input are dropped under one complete-case protocol (identical for every model so all models are
  scored on the same origins) and each drop is recorded with its reason;
- the regime boundary (2026-10-27) is never crossed inside a row: rows whose horizon straddles it are labelled and
  excluded from regime-specific analysis;
- the final `lockbox_days` development-regime rows are sealed in a Lockbox (see Lockbox).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import REGIME_SPLIT_DATE
from .core import frame_hash, json_hash
from .fixtures import INTENTS_ACCOUNTS


@dataclass(frozen=True)
class Spec:
    horizon: int = 7
    lag_grid: tuple[int, ...] = (0, 1, 2, 3, 4, 5, 7)
    y_lags: tuple[int, ...] = (0, 1, 2, 6)
    price_lags: tuple[int, ...] = (1, 2, 3)
    exclude_intents: bool = True
    intents_accounts: tuple[str, ...] = INTENTS_ACCOUNTS
    top_pct: float | None = None  # additionally drop the top p% of accounts by development-window volume
    regime_split: str = REGIME_SPLIT_DATE
    lockbox_days: int = 30
    min_train: int = 60
    step: int = 1
    null_policy: str = "complete_case_no_fill"


@dataclass
class Inputs:
    """Raw daily inputs. `accounts` may be None when only an aggregate target exists (live)."""

    daily: pd.DataFrame  # date, intents_volume_usd, price_close (NaN or absent day = missing)
    accounts: pd.DataFrame | None  # date, account, actions
    target_aggregate: pd.Series | None = None  # used when accounts is None (date-indexed)
    label: str = "SYNTHETIC"
    # per-day completeness in [0,1] for the volume series; NaN volumes are never treated as 0
    volume_completeness: pd.Series | None = None
    extra_incomplete: tuple = ()  # loader-declared reasons the dataset cannot be called complete


class LockboxError(RuntimeError):
    pass


class Lockbox:
    """Frozen holdout. Sealed with a hash at construction; can be opened exactly once, only with the preregistration
    hash it was sealed under. Development code never receives these rows."""

    def __init__(self, rows: pd.DataFrame, prereg_hash: str):
        self._rows = rows.copy()
        self.hash = frame_hash(self._rows[["origin", "target_date", "target"]])
        self.n = len(rows)
        self._sealed_for = prereg_hash
        self.opens = 0

    def open(self, prereg_hash: str) -> pd.DataFrame:
        if prereg_hash != self._sealed_for:
            raise LockboxError("lockbox sealed under a different preregistration hash")
        if self.opens >= 1:
            raise LockboxError("lockbox already opened; a second evaluation would be post-hoc")
        self.opens += 1
        return self._rows.copy()


@dataclass
class Dataset:
    spec: Spec
    rows: pd.DataFrame  # development-regime rows, excluding lockbox
    lockbox: Lockbox
    post_rows: pd.DataFrame  # post-regime rows (separate window)
    straddle_rows: int
    manifest: dict  # feature -> {source, lag, transform}
    feature_sets: dict  # model -> columns
    dropped: list  # [{origin, reasons}]
    raw: dict  # raw source series for leakage re-derivation
    excluded_accounts: list
    hash: str
    coverage: dict = field(default_factory=dict)
    complete: bool = True
    incomplete_reasons: list = field(default_factory=list)


def _calendar(dates: pd.Series) -> pd.DatetimeIndex:
    return pd.date_range(dates.min(), dates.max(), freq="D")


def top_accounts(accounts: pd.DataFrame, pct: float, before: pd.Timestamp, exclude: tuple[str, ...]) -> list[str]:
    """Accounts in the top `pct`% by total actions over dates strictly before `before` (development window only)."""
    a = accounts[(accounts["date"] < before) & (~accounts["account"].isin(exclude))]
    tot = a.groupby("account")["actions"].sum().sort_values(ascending=False, kind="stable")
    k = max(1, math.ceil(len(tot) * pct / 100.0))
    return sorted(tot.index[:k].tolist())


def target_series(inputs: Inputs, spec: Spec, cal: pd.DatetimeIndex, extra_excluded: list[str]) -> pd.Series:
    if inputs.accounts is None:
        assert inputs.target_aggregate is not None
        return inputs.target_aggregate.reindex(cal).astype(float)
    a = inputs.accounts
    drop = list(extra_excluded) + (list(spec.intents_accounts) if spec.exclude_intents else [])
    present = pd.DatetimeIndex(a["date"].unique())
    s = a[~a["account"].isin(drop)].groupby("date")["actions"].sum()
    s = s.reindex(cal)
    # a day that has no account rows at all is a missing day (NaN); a present day with all kept accounts at 0 stays 0
    s[~cal.isin(present)] = np.nan
    s[cal.isin(present) & s.isna()] = 0.0
    return s.astype(float)


def _raw_series(inputs: Inputs, spec: Spec, cal, excluded: list[str]) -> dict[str, pd.Series]:
    d = inputs.daily.set_index("date").reindex(cal)
    y = target_series(inputs, spec, cal, excluded)
    price = d["price_close"].astype(float)
    ret = np.log(price / price.shift(1))  # NaN if today or yesterday missing: no fill across gaps
    return {"y": y, "x": d["intents_volume_usd"].astype(float), "ret": ret}


_TRANSFORM = {"y": np.log1p, "x": np.log1p, "ret": lambda s: s}


def _lagged(raw: dict[str, pd.Series], src: str, lag: int) -> pd.Series:
    return _TRANSFORM[src](raw[src]).shift(lag)  # shift on the full calendar index == calendar-day lag


def _baselines(raw: dict[str, pd.Series], h: int) -> dict[str, pd.Series]:
    ly = np.log1p(raw["y"])
    k = math.ceil(h / 7)
    return {
        "bl_naive": ly,
        "bl_snaive": ly.shift(7 * k - h),  # latest same-weekday value already observed at the origin
        "bl_ma7": ly.rolling(7, min_periods=7).mean(),
    }


def build_dataset(inputs: Inputs, spec: Spec, prereg_hash: str) -> Dataset:
    cal = _calendar(inputs.daily["date"])
    split = pd.Timestamp(spec.regime_split)
    excluded: list[str] = []
    # pass 1 (no top-p exclusion) fixes the split boundaries; the exclusion set is then determined from the development
    # window only and applied unchanged to every split
    holdout_start = _holdout_start(inputs, spec, cal, [], split, prereg_hash)
    if spec.top_pct is not None and inputs.accounts is not None:
        excluded = top_accounts(inputs.accounts, spec.top_pct, holdout_start, spec.intents_accounts)
    raw = _raw_series(inputs, spec, cal, excluded)
    return _assemble(inputs, spec, cal, raw, excluded, prereg_hash)


def _holdout_start(inputs, spec, cal, excluded, split, prereg_hash) -> pd.Timestamp:
    raw = _raw_series(inputs, spec, cal, excluded)
    rows = _rows(raw, spec, cal)[0]
    pre = rows[rows["regime"] == "pre"]
    if spec.lockbox_days <= 0 or len(pre) <= spec.lockbox_days:
        return cal.max() + pd.Timedelta(days=1)
    return pre.iloc[-spec.lockbox_days]["origin"]


def _rows(raw, spec, cal):
    h = spec.horizon
    cols: dict[str, pd.Series] = {}
    manifest: dict[str, dict] = {}
    for L in spec.y_lags:
        cols[f"y_lag{L}"] = _lagged(raw, "y", L)
        manifest[f"y_lag{L}"] = {"source": "y", "lag": L, "transform": "log1p"}
    for L in spec.lag_grid:
        cols[f"x_lag{L}"] = _lagged(raw, "x", L)
        manifest[f"x_lag{L}"] = {"source": "x", "lag": L, "transform": "log1p"}
    for L in spec.price_lags:
        cols[f"ret_lag{L}"] = _lagged(raw, "ret", L)
        manifest[f"ret_lag{L}"] = {"source": "ret", "lag": L, "transform": "log_return"}
    for k in range(6):
        cols[f"dow_{k}"] = pd.Series((cal.day_of_week == k).astype(float), index=cal)
        manifest[f"dow_{k}"] = {"source": "calendar", "lag": 0, "transform": "onehot_dow(target_origin_known)"}
    for name, s in _baselines(raw, h).items():
        cols[name] = s
        manifest[name] = {"source": "y", "lag": None, "transform": name}
    df = pd.DataFrame(cols, index=cal)
    target = np.log1p(raw["y"]).shift(-h)
    df["target"] = target
    df["origin"] = cal
    df["target_date"] = cal + pd.Timedelta(days=h)
    split = pd.Timestamp(spec.regime_split)
    df["regime"] = np.where(df["target_date"] < split, "pre", np.where(df["origin"] >= split, "post", "straddle"))
    need = [c for c in df.columns if c not in ("origin", "target_date", "regime")]
    return df, manifest, need


def _assemble(inputs, spec, cal, raw, excluded, prereg_hash) -> Dataset:
    df, manifest, need = _rows(raw, spec, cal)
    dropped = []
    bad = df[need].isna()
    for i in np.flatnonzero(bad.any(axis=1).to_numpy()):
        o = df.iloc[i]
        # rows whose target lies beyond the calendar are not "missing data": the horizon has not happened yet
        reasons = [c for c in need if bad.iloc[i][c]]
        dropped.append({"origin": o["origin"].strftime("%Y-%m-%d"), "reasons": reasons})
    ok = df[~bad.any(axis=1)].reset_index(drop=True)
    straddle = int((ok["regime"] == "straddle").sum())
    pre = ok[ok["regime"] == "pre"].reset_index(drop=True)
    post = ok[ok["regime"] == "post"].reset_index(drop=True)
    L = spec.lockbox_days
    if L > 0 and len(pre) > L:
        lock_rows = pre.iloc[-L:].reset_index(drop=True)
        dev = pre.iloc[:-L]
        # purge: development rows whose target is revealed on/after the first lockbox origin overlap the holdout
        dev = dev[dev["target_date"] <= lock_rows["origin"].iloc[0]].reset_index(drop=True)
    else:
        lock_rows = pre.iloc[0:0].copy()
        dev = pre
    feats_base = [f"y_lag{k}" for k in spec.y_lags] + [f"dow_{k}" for k in range(6)]
    xs = [f"x_lag{k}" for k in spec.lag_grid]
    ps = [f"ret_lag{k}" for k in spec.price_lags]
    fsets = {"baseline": feats_base, "intents": feats_base + xs, "price": feats_base + ps, "combined": feats_base + xs + ps}
    h = json_hash({"spec": spec.__dict__, "excluded": excluded, "dev": frame_hash(dev), "post": frame_hash(post)})
    ds = Dataset(
        spec=spec,
        rows=dev,
        lockbox=Lockbox(lock_rows, prereg_hash),
        post_rows=post,
        straddle_rows=straddle,
        manifest=manifest,
        feature_sets=fsets,
        dropped=dropped,
        raw=raw,
        excluded_accounts=excluded,
        hash="sha256:" + h,
    )
    ds._lockbox_hash = ds.lockbox.hash  # type: ignore[attr-defined]
    _apply_coverage(ds, inputs, cal)
    return ds


def _apply_coverage(ds: Dataset, inputs: Inputs, cal) -> None:
    n = len(cal)
    miss = {k: int(v.isna().sum()) for k, v in ds.raw.items()}
    ds.coverage = {"calendarDays": n, "missingDays": miss, "labelledNotImputed": True}
    if inputs.volume_completeness is not None:
        vc = inputs.volume_completeness.reindex(cal)
        ds.coverage["volumeCompletenessMean"] = float(vc.mean(skipna=True)) if vc.notna().any() else None
        if vc.isna().any() or (vc < 1.0).any():
            ds.complete = False
            ds.incomplete_reasons.append("intents volume has days with missing or partial amounts (not zero-filled)")
    if inputs.extra_incomplete:
        ds.complete = False
        ds.incomplete_reasons.extend(inputs.extra_incomplete)
    if any(v > 0 for v in miss.values()):
        # missing days are a coverage finding; only live (non-synthetic) datasets are held to "complete"
        if inputs.label != "SYNTHETIC":
            ds.complete = False
            ds.incomplete_reasons.append(f"missing days per series: {miss}")
