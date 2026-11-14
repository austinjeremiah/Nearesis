import math

import numpy as np
import pandas as pd
import pytest
from sklearn.linear_model import Ridge
from statsmodels.stats.multitest import multipletests

from nearesis_research.core import canonical_json, frame_hash, json_hash, rng
from nearesis_research.dataset import Inputs, Lockbox, LockboxError, Spec, build_dataset
from nearesis_research.fixtures import make_fixture
from nearesis_research.inference import benjamini_hochberg, diebold_mariano, placebo_shift_pvalue
from nearesis_research.leakage import check_leakage
from nearesis_research.live import load_live
from nearesis_research.models import losses, ridge_fit_predict, rolling_origin
from nearesis_research.narrative import verify_narrative
from nearesis_research.prereg import default_prereg, verify_prereg


@pytest.fixture(scope="module")
def fx():
    return make_fixture("signal")


def test_fixture_deterministic_and_labelled(fx):
    again = make_fixture("signal")
    assert fx.hash == again.hash and fx.label == "SYNTHETIC"
    assert (fx.daily["label"] == "SYNTHETIC").all()
    assert make_fixture("nosignal").hash != fx.hash


def test_canonical_json_stable_and_nan_safe():
    assert canonical_json({"b": 1.00000000001, "a": float("nan")}) == '{"a":null,"b":1.0}'
    assert json_hash({"a": 1}) == json_hash({"a": 1})


def test_rng_streams_independent():
    assert rng(1, "a").random() != rng(1, "b").random()
    assert rng(1, "a").random() == rng(1, "a").random()


def test_ridge_matches_sklearn():
    r = np.random.default_rng(0)
    X, y = r.normal(size=(80, 5)), r.normal(size=80)
    mu, sd = X.mean(0), X.std(0)
    sk = Ridge(alpha=1.0).fit((X - mu) / sd, y).predict((X[:3] - mu) / sd)
    assert np.allclose(ridge_fit_predict(X, y, X[:3]), sk, atol=1e-10)


def test_bh_matches_statsmodels():
    p = rng(3, "bh").uniform(size=12).tolist()
    mine = benjamini_hochberg(p, 0.1)
    ref = multipletests(p, alpha=0.1, method="fdr_bh")
    assert np.allclose(mine["adjusted"], ref[1]) and mine["reject"] == ref[0].tolist()


def test_dm_detects_better_model_and_not_equal():
    r = np.random.default_rng(1)
    base = np.abs(r.normal(1, 0.1, 200))
    assert diebold_mariano(base, base * 0.5, 1)["p_one_sided"] < 1e-6
    assert diebold_mariano(base, base + r.normal(0, 0.01, 200), 1)["p_one_sided"] > 0.01


def test_placebo_p_never_zero():
    assert placebo_shift_pvalue(1.0, [0.1] * 40) == pytest.approx(1 / 41)


def test_lags_are_calendar_true_and_no_future(fx):
    ds = build_dataset(Inputs(fx.daily, fx.accounts), Spec(horizon=3), "h")
    row = ds.rows.iloc[100]
    o = row["origin"]
    expected = np.log1p(fx.daily.set_index("date").loc[o - pd.Timedelta(days=2), "intents_volume_usd"])
    assert row["x_lag2"] == pytest.approx(expected)
    assert row["target_date"] - o == pd.Timedelta(days=3)
    assert check_leakage(ds).clean


def test_training_rows_have_known_targets(fx):
    ds = build_dataset(Inputs(fx.daily, fx.accounts), Spec(horizon=7), "h")
    bt = rolling_origin(ds.rows, ds.feature_sets, np.ones(len(ds.rows), bool), 60)
    assert (bt.target_dates > bt.origins).all()
    assert bt.n_train.min() >= 60


def test_lockbox_opens_once_and_only_with_hash(fx):
    ds = build_dataset(Inputs(fx.daily, fx.accounts), Spec(horizon=1), "H1")
    with pytest.raises(LockboxError):
        ds.lockbox.open("other")
    assert len(ds.lockbox.open("H1")) == 30
    with pytest.raises(LockboxError):
        ds.lockbox.open("H1")


def test_dev_rows_never_overlap_lockbox(fx):
    ds = build_dataset(Inputs(fx.daily, fx.accounts), Spec(horizon=14), "H")
    lb = ds.lockbox.open("H")
    assert ds.rows["target_date"].max() <= lb["origin"].min()


def test_zero_not_filled_for_missing_target_day(fx):
    acc = fx.accounts[fx.accounts["date"] != pd.Timestamp("2026-01-05")]
    ds = build_dataset(Inputs(fx.daily, acc), Spec(horizon=1), "H")
    assert np.isnan(ds.raw["y"].loc["2026-01-05"])


def test_losses_zero_rule():
    r = losses(np.array([0.0, 0.0]), np.array([0.0, 0.0]))
    assert r["smape_raw"] == 0.0 and r["mae_log"] == 0.0


def test_prereg_hash_binds_content():
    p = default_prereg()
    assert verify_prereg(p)
    assert not verify_prereg({**p, "primaryHorizon": 7})
    assert len(p["family"]) == 9


def test_verify_narrative_flags_unknown_numbers():
    assert verify_narrative("MAE 0.1234 over 5 origins", {"a": 0.12341, "n": 5})["ok"]
    assert not verify_narrative("MAE 0.9999", {"a": 0.1})["ok"]


def test_live_loader_refuses_complete_when_partial():
    def q(sql, p=None):
        if "FROM nearesis_live.near_daily_tx" in sql:
            return [{"d": "2026-01-01", "y": 100}, {"d": "2026-01-03", "y": 120}]
        if "FROM nearesis_live.account_daily_activity" in sql:
            return [{"d": "2026-01-01", "tx_organic": 90, "top1pct_organic_tx": 5, "top5pct_organic_tx": 9, "account_rule_version": 1}, {"d": "2026-01-03", "tx_organic": 100, "top1pct_organic_tx": 5, "top5pct_organic_tx": 9, "account_rule_version": 1}]
        if "FROM nearesis_live.price_candles" in sql:
            return [{"d": "2026-01-01", "price": 3.0}, {"d": "2026-01-02", "price": 3.1}, {"d": "2026-01-03", "price": 3.2}]
        if "privacy_era AS era" in sql:
            return [{"d": "2026-01-02", "era": "public", "n_success": 6, "n_success_null_usd": 4, "vol": 55.0}]
        if "FROM nearesis_live.intents_swaps" in sql:
            return [{"d": "2026-01-02", "n": 10, "n_success": 10, "n_success_null_usd": 4, "vol": 55.0}]
        return [{"dataset": "intents_swaps", "state": "partial", "days": 1}]

    ll = load_live("2026-01-01", "2026-01-03", q)
    assert not ll.complete and ll.reasons
    x = ll.inputs.daily["intents_volume_usd"]
    assert x.isna().sum() == 2 and not (x == 0).any()  # absent swap days are NaN, never zero
    assert np.isnan(ll.inputs.target_aggregate.loc["2026-01-02"])
    assert ll.inputs.volume_completeness.loc["2026-01-02"] == pytest.approx(0.6)
    ds = build_dataset(ll.inputs, Spec(horizon=1, min_train=1, lockbox_days=0), "h")
    assert ds.complete is False and ds.incomplete_reasons


def test_frame_hash_sensitive():
    a = pd.DataFrame({"x": [1.0, float("nan")]})
    b = pd.DataFrame({"x": [1.0, 0.0]})
    assert frame_hash(a) != frame_hash(b)
