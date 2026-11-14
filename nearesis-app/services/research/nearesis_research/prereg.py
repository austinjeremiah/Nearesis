"""Frozen preregistration. The hash covers everything that determines verdict thresholds; the verdict engine recomputes
it and refuses to grade a run whose preregistration was altered after the fact."""

from __future__ import annotations

from . import METHOD_VERSION, REGIME_SPLIT_DATE
from .core import json_hash
from .fixtures import INTENTS_ACCOUNTS

CANDIDATES = ("intents", "price", "combined")
HORIZONS = (1, 7, 14)


def default_prereg(seed: int = 20261111, hypothesis: str | None = None, lockbox_days: int = 30) -> dict:
    p = {
        "experimentId": "experiment.near.intents_predictive_power@1",
        "methodVersion": METHOD_VERSION,
        "hypothesis": hypothesis
        or "Lagged completed 1Click/Intents volume improves out-of-sample forecasts of organic NEAR-native daily "
        "activity beyond usage and calendar history. Predictive claim only; causality is excluded.",
        "primaryOutcome": "organic daily successful actions (Intents-generated accounts excluded), log1p scale",
        "horizons": list(HORIZONS),
        "primaryHorizon": 1,
        "primaryCandidate": "intents",
        "family": [{"candidate": c, "horizon": h, "versus": "baseline"} for h in HORIZONS for c in CANDIDATES],
        "fdr": {"method": "benjamini_hochberg", "q": 0.05},
        "loss": "mae_log",
        "secondaryLosses": ["rmse_log", "bias_log", "mae_raw", "smape_raw"],
        "split": {
            "method": "rolling_origin_expanding",
            "lockboxDays": lockbox_days,
            "minTrain": 60,
            "regimeSplit": REGIME_SPLIT_DATE,
            "randomCrossValidation": False,
        },
        "thresholds": {
            "minRelativeImprovement": 0.02,
            "minDevOrigins": 60,
            "minHoldoutOrigins": 14,
            "bootstrap": {"n": 500, "block": 7, "level": 0.95},
            "placebo": {"n": 40, "alpha": 0.05},
            "robustnessAgreeShare": 0.8,
            "holdoutAlpha": 0.05,
        },
        "nullPolicy": "complete_case_no_fill_no_zero",
        "accountExclusionRule": {
            "intentsGeneratedAccounts": list(INTENTS_ACCOUNTS),
            "sensitivityTopPct": [1, 5],
            "ruleSetFromDevelopmentWindowOnly": True,
        },
        "featureSpec": {"lagGrid": [0, 1, 2, 3, 4, 5, 7], "yLags": [0, 1, 2, 6], "priceLags": [1, 2, 3]},
        "randomSeed": seed,
        "causalClaim": "excluded",
    }
    p["hash"] = prereg_hash(p)
    return p


def prereg_hash(p: dict) -> str:
    body = {k: v for k, v in p.items() if k != "hash"}
    return "sha256:" + json_hash(body)


def verify_prereg(p: dict) -> bool:
    return p.get("hash") == prereg_hash(p)
