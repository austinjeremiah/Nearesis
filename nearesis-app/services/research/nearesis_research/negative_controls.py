"""Deliberately wrong implementations used ONLY by acceptance tests as negative controls (ch.16b: each must be detected by
the assertion it targets). Nothing in production imports this module."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .dataset import Dataset
from .models import AccessRecorder, RIDGE_ALPHA


def leaky_scaler_rolling_origin(ds: Dataset, models: tuple, min_train: int, recorder: AccessRecorder) -> int:
    """Q11 control: standardises features on the FULL series before the walk-forward loop and records what it touched."""
    rows = ds.rows.reset_index(drop=True)
    origins, tdates, y = rows["origin"].to_numpy(), rows["target_date"].to_numpy(), rows["target"].to_numpy()
    n_origins = 0
    for m in models:
        X = rows[ds.feature_sets[m]].to_numpy(dtype=float)
        mu, sd = X.mean(axis=0), X.std(axis=0)  # fitted on the whole series: the leak
        sd[sd == 0] = 1.0
        Z = (X - mu) / sd
        for i in range(len(rows)):
            tr = np.flatnonzero(tdates <= origins[i])
            if len(tr) < min_train:
                continue
            Zt = Z[tr]
            yb = y[tr].mean()
            np.linalg.solve(Zt.T @ Zt + RIDGE_ALPHA * np.eye(Zt.shape[1]), Zt.T @ (y[tr] - yb))
            recorder.record(origins[i], "scaler_fit", max(origins.max(), tdates.max()))
            n_origins += 1
    return n_origins


# ---- Q17 controls ----
from .lockbox_protocol import DevLoader, HoldoutProtocol, SecondEvaluationRefused  # noqa: E402


class _LeakyLoader(DevLoader):
    """Returns holdout rows when a flag is set."""

    def __init__(self, ds, audit, holdout_rows):
        super().__init__(ds, audit)
        self._leak = holdout_rows

    def load(self, start=None, end=None, split="dev", include_holdout=False):
        if include_holdout:
            return self._leak.copy()
        return super().load(start, end, split)


class LeakyLoaderProtocol(HoldoutProtocol):
    def __init__(self, inputs, frozen, lockbox_days=None):
        super().__init__(inputs, frozen, lockbox_days)
        # the control deliberately reaches into a second copy of the dataset to build the leak it simulates
        from .dataset import build_dataset

        twin = build_dataset(inputs, self.spec, frozen.doc_hash)
        leak = twin.lockbox.open(frozen.doc_hash)
        self.loader = _LeakyLoader(self._ds, self.audit, leak)


class CountsReplayAsEvaluation(HoldoutProtocol):
    """Control: an implementation that counts an audit replay as a new independent evaluation."""

    def audit_replay(self, actor, environment, config):
        rec = super().audit_replay(actor, environment, config)
        self.evaluations.append(rec)
        return rec


class AcceptsAlteredReplay(HoldoutProtocol):
    """Control: an implementation that accepts a replay whose configuration was altered."""

    def audit_replay(self, actor, environment, config):
        rows = self.lockbox.replay_rows(self.frozen.doc_hash)
        return {"audit_replay": True, "result": self._evaluate(rows), "configHash": self.config_hash(config)}
