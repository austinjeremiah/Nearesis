"""Leakage detector. Re-derives every feature from the raw series using only information at-or-before the origin and
compares it with the stored column; any mismatch, negative lag, unexcluded mechanical overlap or split-order violation
is a finding. Publication is blocked while findings exist."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .dataset import Dataset, _TRANSFORM


class LeakageError(RuntimeError):
    def __init__(self, report: "LeakageReport"):
        super().__init__("leakage detected: " + "; ".join(f["code"] + ":" + f.get("column", "") for f in report.findings))
        self.report = report


@dataclass
class LeakageReport:
    findings: list = field(default_factory=list)
    checked_columns: int = 0

    @property
    def clean(self) -> bool:
        return not self.findings

    def to_dict(self) -> dict:
        return {"clean": self.clean, "findings": self.findings, "checkedColumns": self.checked_columns}


def _all_rows(ds: Dataset) -> pd.DataFrame:
    parts = [ds.rows, ds.post_rows]
    return pd.concat(parts, ignore_index=True)


def check_leakage(ds: Dataset) -> LeakageReport:
    rep = LeakageReport()
    rows = _all_rows(ds)
    origins = pd.DatetimeIndex(rows["origin"])
    h = ds.spec.horizon
    for col, m in ds.manifest.items():
        if m["source"] == "calendar" or m["lag"] is None:
            continue
        rep.checked_columns += 1
        if m["lag"] < 0:
            rep.findings.append({"code": "NEGATIVE_LAG", "column": col, "detail": f"lag {m['lag']}"})
            continue
        expected = _TRANSFORM[m["source"]](ds.raw[m["source"]]).shift(m["lag"]).reindex(origins).to_numpy()
        got = rows[col].to_numpy()
        both = ~np.isnan(expected)
        if not np.allclose(got[both], expected[both], rtol=0, atol=1e-9, equal_nan=False):
            # classify: does the stored column equal a *future* value?
            kind = "ALTERED_VALUE"
            bad = both & ~np.isclose(got, np.where(both, expected, 0.0), rtol=0, atol=1e-9)
            for lead in range(1, 15):
                fut = _TRANSFORM[m["source"]](ds.raw[m["source"]]).shift(-lead).reindex(origins).to_numpy()
                ok = bad & ~np.isnan(fut) & ~np.isnan(got)
                if ok.sum() >= 1 and ok.sum() == bad.sum() and np.allclose(got[ok], fut[ok], atol=1e-9):
                    kind = "FUTURE_VALUE"
                    rep.findings.append({"code": kind, "column": col, "detail": f"column equals source at t+{lead} on {int(bad.sum())} rows"})
                    break
            else:
                rep.findings.append({"code": kind, "column": col, "detail": f"{int(bad.sum())} rows differ from source[t-lag]"})
    # target alignment: target_date = origin + h and target = log1p(y[target_date])
    if not (pd.DatetimeIndex(rows["target_date"]) - origins == pd.Timedelta(days=h)).all():
        rep.findings.append({"code": "TARGET_MISALIGNED", "column": "target_date", "detail": f"origin+{h}d expected"})
    # mechanical overlap: Intents-generated actions must not sit in the target when Intents volume is a predictor
    if not ds.spec.exclude_intents and any(m["source"] == "x" for m in ds.manifest.values()):
        rep.findings.append({"code": "MECHANICAL_OVERLAP", "column": "target", "detail": "target includes Intents-generated actions"})
    # split order: development targets are revealed before the first lockbox origin
    if ds.lockbox.n and len(ds.rows) and ds.rows["target_date"].max() > ds.lockbox._rows["origin"].min():
        rep.findings.append({"code": "SPLIT_OVERLAP", "column": "lockbox", "detail": "dev target revealed after lockbox start"})
    return rep


def assert_publishable(ds: Dataset) -> LeakageReport:
    rep = check_leakage(ds)
    if not rep.clean:
        raise LeakageError(rep)
    return rep
