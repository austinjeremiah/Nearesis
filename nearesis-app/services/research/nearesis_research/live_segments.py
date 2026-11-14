"""Per-account daily input for the segment cell, from a future per-signer extract (PREPARED, NOT RUN).

The extract is produced by docs/research/sql/per_signer_daily_organic.sql (one CSV per month chunk). No such extract
exists yet and this module never queries BigQuery; it only reads files.

File schema (CSV, header required, UTF-8):
  block_date  YYYY-MM-DD (UTC day)                       required
  signer      NEAR account id, non-empty                 required
  n_org       integer organic tx count, >= min_count     required
  segment     optional segment key (e.g. a registry segment); if present it must be non-empty and one per signer

Completeness contract (all violations are collected, then raised together; nothing is repaired or filled):
- every calendar day in [start, end] has at least one row, else it is a missing day (never treated as zero);
- (block_date, signer) is unique; n_org is an integer >= min_count (the extract keeps only the head per day);
- when per-day organic totals are supplied, sum(listed) <= total for each day, and the exact remainder
  (total - sum(listed)) becomes a per-day row for the pseudo-account REMAINDER, so the day total is conserved;
- every month in the window has all its days (per-month report).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pandas as pd

REMAINDER = "__REMAINDER__"
REQUIRED_COLUMNS = ("block_date", "signer", "n_org")
OPTIONAL_COLUMNS = ("segment",)
MIN_COUNT = 100  # the HAVING threshold of the SQL


class SegmentInputError(ValueError):
    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("; ".join(problems[:20]) + (f" (+{len(problems) - 20} more)" if len(problems) > 20 else ""))


@dataclass(frozen=True)
class SegmentInput:
    accounts: pd.DataFrame  # date (datetime64), account, actions: the engine's Inputs.accounts shape, REMAINDER included
    months: pd.DataFrame  # month, days_expected, days_present, missing_days
    segments: dict[str, str]  # signer -> segment key, empty when the extract has no segment column
    n_listed_rows: int


def read_extracts(paths: list[Path | str]) -> pd.DataFrame:
    frames = [pd.read_csv(p, dtype={"signer": "string", "segment": "string"}) for p in sorted(map(str, paths))]
    if not frames:
        raise SegmentInputError(["no extract files given"])
    return pd.concat(frames, ignore_index=True)


def _validate_frame(df: pd.DataFrame, start: pd.Timestamp, end: pd.Timestamp, min_count: int) -> tuple[pd.DataFrame, list[str]]:
    problems: list[str] = []
    missing_cols = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing_cols:
        return df, [f"missing columns: {missing_cols}"]
    extra = [c for c in df.columns if c not in REQUIRED_COLUMNS + OPTIONAL_COLUMNS]
    if extra:
        problems.append(f"unknown columns: {extra}")
    d = df.copy()
    d["date"] = pd.to_datetime(d["block_date"], errors="coerce", format="%Y-%m-%d")
    bad_dates = d["date"].isna().sum()
    if bad_dates:
        problems.append(f"{bad_dates} rows with an unparseable block_date")
    if d["signer"].isna().any() or (d["signer"].fillna("").str.strip() == "").any():
        problems.append("empty signer")
    n = pd.to_numeric(d["n_org"], errors="coerce")
    if n.isna().any() or (n.dropna() % 1 != 0).any():
        problems.append("n_org must be an integer on every row")
    elif (n < min_count).any():
        problems.append(f"{int((n < min_count).sum())} rows below the extract threshold of {min_count}")
    d["actions"] = n
    ok = d.dropna(subset=["date"])
    out_of = ok[(ok["date"] < start) | (ok["date"] > end)]
    if len(out_of):
        problems.append(f"{len(out_of)} rows outside {start.date()}..{end.date()}")
    dup = ok.duplicated(["date", "signer"], keep=False)
    if dup.any():
        problems.append(f"{int(dup.sum())} rows repeat a (block_date, signer) pair")
    if "segment" in d.columns:
        seg = d.dropna(subset=["segment"]).groupby("signer")["segment"].nunique()
        if (seg > 1).any():
            problems.append(f"signers with more than one segment: {sorted(seg[seg > 1].index)[:5]}")
        if d["segment"].isna().any():
            problems.append("empty segment value")
    return d, problems


def build_segment_input(
    df: pd.DataFrame,
    start: str,
    end: str,
    day_totals: pd.Series | None = None,
    min_count: int = MIN_COUNT,
) -> SegmentInput:
    """Validate the extract frame for [start, end] and return the per-account daily input. Deterministic."""
    s, e = pd.Timestamp(start), pd.Timestamp(end)
    d, problems = _validate_frame(df, s, e, min_count)
    cal = pd.date_range(s, e, freq="D")
    if problems and "missing columns" in problems[0]:
        raise SegmentInputError(problems)
    present = pd.DatetimeIndex(d["date"].dropna().unique())
    missing = cal.difference(present)
    months = []
    for m, days in pd.Series(cal, index=cal).groupby(cal.to_period("M")):
        miss = [x for x in days if x in missing]
        months.append({"month": str(m), "days_expected": len(days), "days_present": len(days) - len(miss),
                       "missing_days": [x.strftime("%Y-%m-%d") for x in miss]})
    months_df = pd.DataFrame(months)
    if len(missing):
        problems.append(f"{len(missing)} missing days, first {missing[0].date()} (a missing day is never zero)")
    listed = d.dropna(subset=["date"])[["date", "signer", "actions"]].rename(columns={"signer": "account"})
    listed = listed.assign(account=listed["account"].astype(str), actions=listed["actions"].astype("float64"))
    parts = [listed]
    if day_totals is not None:
        t = day_totals.copy()
        t.index = pd.to_datetime(t.index)
        t = t.reindex(cal)
        no_total = t.isna() & cal.isin(present)
        if no_total.any():
            problems.append(f"{int(no_total.sum())} days without an organic day total")
        sums = listed.groupby("date")["actions"].sum().reindex(cal)
        over = (sums > t) & sums.notna() & t.notna()
        if over.any():
            problems.append(f"listed signers exceed the day total on {int(over.sum())} days, first {over[over].index[0].date()}")
        rem = (t - sums.fillna(0.0)).where(cal.isin(present) & t.notna())
        rem = rem.dropna()
        if len(rem) and (rem < 0).any():
            rem = rem.clip(lower=0.0)
        parts.append(pd.DataFrame({"date": rem.index, "account": REMAINDER, "actions": rem.to_numpy(dtype="float64")}))
    if problems:
        raise SegmentInputError(problems)
    acc = pd.concat(parts, ignore_index=True).sort_values(["date", "account"], kind="stable").reset_index(drop=True)
    seg_map: dict[str, str] = {}
    if "segment" in d.columns:
        seg_map = {str(k): str(v) for k, v in sorted(d.dropna(subset=["segment"]).drop_duplicates("signer").set_index("signer")["segment"].items())}
    return SegmentInput(acc, months_df, seg_map, len(listed))


def load_segment_input(paths: list[Path | str], start: str, end: str, day_totals: pd.Series | None = None,
                       min_count: int = MIN_COUNT) -> SegmentInput:
    return build_segment_input(read_extracts(paths), start, end, day_totals, min_count)


def head_tail_inputs(
    seg: SegmentInput, before: str, head_n: int, exclude: tuple[str, ...] = ()
) -> dict[str, pd.DataFrame]:
    """Head/tail account frames with the same rule as robustness.py: head = the `head_n` accounts with the largest
    total actions over dates strictly before `before` (stable order, ties by account id), excluding `exclude` and the
    REMAINDER pseudo-account; tail = every other account plus the per-day REMAINDER. Returns {'head', 'tail'} frames in
    the engine's (date, account, actions) shape, plus the head list under attrs['head_accounts'].
    """
    a = seg.accounts
    pool = a[(a["date"] < pd.Timestamp(before)) & (~a["account"].isin(exclude)) & (a["account"] != REMAINDER)]
    tot = pool.groupby("account")["actions"].sum().reset_index()
    tot = tot.sort_values(["actions", "account"], ascending=[False, True], kind="stable")
    head = sorted(tot["account"].iloc[: head_n].tolist())
    is_head = a["account"].isin(head)
    out = {"head": a[is_head].reset_index(drop=True), "tail": a[~is_head].reset_index(drop=True)}
    for f in out.values():
        f.attrs["head_accounts"] = head
    return out
