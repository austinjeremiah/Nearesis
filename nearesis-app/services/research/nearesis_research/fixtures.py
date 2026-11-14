"""Deterministic SYNTHETIC fixtures. Never presented as real NEAR data (every frame carries `label`)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .core import frame_hash, rng

LABEL = "SYNTHETIC"
START = "2025-09-01"
N_DAYS = 440  # ends 2026-11-14, so the 2026-10-27 regime boundary falls inside the series
INTENTS_ACCOUNTS = ("intents.near", "bridge.verifier.near", "omft.near", "v1.omni.hot.tg", "hot.tg")
KNOWN_LAG = 3
KNOWN_BETA = 0.35


@dataclass
class Fixture:
    name: str
    label: str
    daily: pd.DataFrame  # date, intents_volume_usd, price_close
    accounts: pd.DataFrame  # date, account, actions
    truth: dict
    hash: str


def _ar1(r: np.random.Generator, n: int, phi: float, sigma: float) -> np.ndarray:
    e = r.normal(0, sigma, n)
    out = np.zeros(n)
    for i in range(1, n):
        out[i] = phi * out[i - 1] + e[i]
    return out


def make_fixture(kind: str, seed: int = 20261111, n_days: int = N_DAYS, n_accounts: int = 200, start: str = START) -> Fixture:
    """kind: 'signal' (log intents volume leads log activity by KNOWN_LAG days) or 'nosignal' (independent)."""
    assert kind in ("signal", "nosignal")
    r = rng(seed, "fixture", kind)
    dates = pd.date_range(start, periods=n_days, freq="D")
    dow = dates.day_of_week.to_numpy()
    season = 0.15 * np.sin(2 * np.pi * dow / 7)
    lx = 10.0 + _ar1(rng(seed, "x", kind), n_days, 0.6, 0.5)  # log intents volume
    lp = np.cumsum(rng(seed, "p", kind).normal(0, 0.03, n_days)) + np.log(3.0)  # log price, independent of activity
    ar = _ar1(r, n_days, 0.7, 0.04)
    lag_x = np.concatenate([np.full(KNOWN_LAG, lx[0]), lx[:-KNOWN_LAG]])
    beta = KNOWN_BETA if kind == "signal" else 0.0
    log_level = 11.0 + season + ar + beta * (lag_x - 10.0)
    level = np.exp(log_level)
    # heavy-tailed account weights (Zipf); intents-generated accounts sit at the head
    w = 1.0 / np.arange(1, n_accounts + 1) ** 1.1
    w = w / w.sum()
    names = list(INTENTS_ACCOUNTS) + [f"acct{i:04d}.near" for i in range(n_accounts - len(INTENTS_ACCOUNTS))]
    rows = []
    pr = rng(seed, "poisson", kind)
    for i, d in enumerate(dates):
        lam = level[i] * w
        act = pr.poisson(lam)
        for a, c in zip(names, act):
            if c > 0:
                rows.append((d, a, int(c)))
    accounts = pd.DataFrame(rows, columns=["date", "account", "actions"])
    daily = pd.DataFrame(
        {"date": dates, "intents_volume_usd": np.exp(lx), "price_close": np.exp(lp), "label": LABEL}
    )
    truth = {"kind": kind, "knownLag": KNOWN_LAG if kind == "signal" else None, "beta": beta, "seed": seed}
    h = frame_hash(daily.drop(columns="label")) + frame_hash(accounts)
    from .core import sha256_hex

    return Fixture(kind, LABEL, daily, accounts, truth, sha256_hex(h))
