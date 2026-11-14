"""live_segments: schema validation, completeness, head/tail inputs, determinism.

Every fixture here is SYNTHETIC (generated in the test); no real extract exists yet.
"""

from __future__ import annotations

import pandas as pd
import pytest

from nearesis_research.live_segments import (
    REMAINDER,
    SegmentInputError,
    build_segment_input,
    head_tail_inputs,
    load_segment_input,
)

START, END = "2026-01-30", "2026-02-03"  # spans a month boundary: 2026-01 (2 days), 2026-02 (3 days)
DAYS = pd.date_range(START, END, freq="D")
SIGNERS = {"a.near": 900, "b.near": 500, "c.near": 300, "d.near": 150, "e.near": 100}


def synthetic_extract() -> pd.DataFrame:  # SYNTHETIC
    rows = [(d.strftime("%Y-%m-%d"), s, n + i) for i, d in enumerate(DAYS) for s, n in SIGNERS.items()]
    return pd.DataFrame(rows, columns=["block_date", "signer", "n_org"])


def synthetic_totals() -> pd.Series:  # SYNTHETIC: listed sum + a 700-tx tail per day
    listed = synthetic_extract().groupby("block_date")["n_org"].sum()
    return pd.Series((listed + 700).to_numpy(), index=pd.to_datetime(listed.index))


def test_valid_extract_conserves_day_totals():
    si = build_segment_input(synthetic_extract(), START, END, synthetic_totals())
    by_day = si.accounts.groupby("date")["actions"].sum()
    assert by_day.to_dict() == synthetic_totals().astype(float).to_dict()
    assert (si.accounts[si.accounts["account"] == REMAINDER]["actions"] == 700).all()
    assert list(si.months["month"]) == ["2026-01", "2026-02"]
    assert list(si.months["days_present"]) == [2, 3]
    assert set(si.accounts.columns) == {"date", "account", "actions"}


def test_missing_columns_and_bad_values_rejected():
    with pytest.raises(SegmentInputError, match="missing columns"):
        build_segment_input(synthetic_extract().drop(columns=["n_org"]), START, END)
    df = synthetic_extract()
    df["n_org"] = df["n_org"].astype(float)
    df.loc[0, "n_org"] = 99  # below the extract threshold
    df.loc[1, "n_org"] = 120.5
    df.loc[2, "signer"] = ""
    with pytest.raises(SegmentInputError) as ei:
        build_segment_input(df, START, END)
    text = str(ei.value)
    assert "integer" in text and "empty signer" in text


def test_duplicates_and_out_of_range_rejected():
    df = pd.concat([synthetic_extract(), synthetic_extract().iloc[:1]], ignore_index=True)
    df.loc[len(df)] = ["2026-03-01", "z.near", 200]
    with pytest.raises(SegmentInputError) as ei:
        build_segment_input(df, START, END)
    assert "repeat" in str(ei.value) and "outside" in str(ei.value)


def test_missing_day_is_reported_never_zero():
    df = synthetic_extract()
    df = df[df["block_date"] != "2026-02-01"]
    with pytest.raises(SegmentInputError, match="1 missing days, first 2026-02-01"):
        build_segment_input(df, START, END)


def test_listed_over_total_and_missing_total_rejected():
    t = synthetic_totals()
    low = t.copy()
    low.iloc[0] = 10
    with pytest.raises(SegmentInputError, match="exceed the day total"):
        build_segment_input(synthetic_extract(), START, END, low)
    with pytest.raises(SegmentInputError, match="without an organic day total"):
        build_segment_input(synthetic_extract(), START, END, t.iloc[1:])


def test_head_tail_split_inputs():
    si = build_segment_input(synthetic_extract(), START, END, synthetic_totals())
    ht = head_tail_inputs(si, before="2026-02-02", head_n=2)
    assert ht["head"].attrs["head_accounts"] == ["a.near", "b.near"]
    assert set(ht["head"]["account"]) == {"a.near", "b.near"}
    assert set(ht["tail"]["account"]) == {"c.near", "d.near", "e.near", REMAINDER}
    assert len(ht["head"]) + len(ht["tail"]) == len(si.accounts)
    both = pd.concat([ht["head"], ht["tail"]]).groupby("date")["actions"].sum()
    assert both.to_dict() == si.accounts.groupby("date")["actions"].sum().to_dict()
    ex = head_tail_inputs(si, before="2026-02-02", head_n=2, exclude=("a.near",))
    assert ex["head"].attrs["head_accounts"] == ["b.near", "c.near"]


def test_segment_column_one_per_signer():
    df = synthetic_extract()
    df["segment"] = df["signer"].map(lambda s: "alpha" if s < "c" else "beta")
    assert build_segment_input(df, START, END).segments["a.near"] == "alpha"
    df.loc[0, "segment"] = "beta"
    with pytest.raises(SegmentInputError, match="more than one segment"):
        build_segment_input(df, START, END)


def test_files_and_determinism(tmp_path):
    df = synthetic_extract()
    jan, feb = df[df["block_date"] < "2026-02-01"], df[df["block_date"] >= "2026-02-01"]
    p1, p2 = tmp_path / "per_signer_daily_organic_2026-01.csv", tmp_path / "per_signer_daily_organic_2026-02.csv"
    jan.to_csv(p1, index=False)
    feb.to_csv(p2, index=False)
    a = load_segment_input([p2, p1], START, END, synthetic_totals())
    b = load_segment_input([p1, p2], START, END, synthetic_totals())
    pd.testing.assert_frame_equal(a.accounts, b.accounts)
    assert a.accounts["date"].is_monotonic_increasing
    pd.testing.assert_frame_equal(
        head_tail_inputs(a, "2026-02-02", 3)["head"], head_tail_inputs(b, "2026-02-02", 3)["head"]
    )
