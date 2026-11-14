"""Holdout lockbox protocol (ch.02 lockbox, ch.16b Q17).

Development code sees the holdout only through `DevLoader`, which refuses (and audits) every request that touches it.
The lockbox opens once, under a frozen preregistration hash, for one final evaluation. A second independent evaluation is
refused. An audit replay with the identical frozen configuration (configuration hash, seeds, data digest) is allowed, is
recorded as `audit_replay`, never counts as a new evaluation and never raises evidence strength; a replay with any
altered value is refused as a replay and treated as a prohibited second evaluation."""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .core import json_hash
from .dataset import Dataset, HoldoutAccessError, Inputs, LockboxError, Spec, build_dataset
from .experiment import _compare
from .frozen import Frozen, FreezeViolation
from .models import AccessRecorder, rolling_origin


class SecondEvaluationRefused(LockboxError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class DevLoader:
    """The only data interface available during development and tuning."""

    def __init__(self, ds: Dataset, audit: list):
        self._dev = ds.rows
        self._holdout_start = ds.lockbox.first_origin
        self._audit = audit

    def _refuse(self, interface: str, request: dict) -> None:
        self._audit.append({"at": _now(), "interface": interface, "request": request, "outcome": "refused", "rowsReturned": 0})
        raise HoldoutAccessError(f"{interface}: request touches the sealed holdout")

    def load(self, start: str | None = None, end: str | None = None, split: str = "dev") -> pd.DataFrame:
        req = {"start": start, "end": end, "split": split}
        if split != "dev":
            self._refuse("loader", req)
        if self._holdout_start is not None and end is not None and pd.Timestamp(end) >= self._holdout_start:
            self._refuse("loader", req)
        rows = self._dev
        if start is not None:
            rows = rows[rows["origin"] >= pd.Timestamp(start)]
        if end is not None:
            rows = rows[rows["origin"] <= pd.Timestamp(end)]
        self._audit.append({"at": _now(), "interface": "loader", "request": req, "outcome": "served", "rowsReturned": int(len(rows))})
        return rows.copy()

    def build_features(self, columns: list[str], start: str | None = None, end: str | None = None, split: str = "dev") -> pd.DataFrame:
        """Feature-builder interface: goes through the loader, so the same guard applies."""
        try:
            rows = self.load(start, end, split)
        except HoldoutAccessError:
            self._audit.append({"at": _now(), "interface": "feature_builder", "request": {"columns": columns, "start": start, "end": end, "split": split}, "outcome": "refused", "rowsReturned": 0})
            raise
        return rows[["origin", *columns]]

    def notebook_peek(self, n: int = 5, tail_of: str = "dev") -> pd.DataFrame:
        """Notebook-style convenience helper (head/tail of a split)."""
        if tail_of != "dev":
            self._refuse("notebook_helper", {"n": n, "tail_of": tail_of})
        return self.load().tail(n)


class HoldoutProtocol:
    def __init__(self, inputs: Inputs, frozen: Frozen, lockbox_days: int | None = None):
        self.frozen = frozen
        e = frozen.get("experiment")
        self.spec = Spec(
            horizon=e["primaryHorizon"],
            lag_grid=tuple(e["lagGrid"]),
            lockbox_days=e["lockboxDays"] if lockbox_days is None else lockbox_days,
            min_train=e["minTrain"],
            regime_split=e["regimeSplit"],
        )
        self.audit: list[dict] = []
        self.events: list[dict] = []
        self._ds = build_dataset(inputs, self.spec, frozen.doc_hash)
        self.lockbox = self._ds.lockbox
        self.loader = DevLoader(self._ds, self.audit)
        self.sealed_digest = self.lockbox.current_digest()
        self.evaluations: list[dict] = []
        self.replays: list[dict] = []
        self.post_holdout = False
        self._opened = False
        self.candidate = e["primaryCandidate"]
        self.seed = frozen.get("q14.interval.bootstrapSeed")

    # ---- development ----
    def develop(self, models: tuple = ("baseline", "intents", "price", "combined"), recorder: AccessRecorder | None = None) -> dict:
        rec = recorder if recorder is not None else AccessRecorder()
        ds = self._ds
        bt = rolling_origin(ds.rows, ds.feature_sets, np.ones(len(ds.rows), bool), ds.spec.min_train, ds.spec.step, models=models, baselines=False, recorder=rec)
        eb, ec = bt.abs_err("baseline"), bt.abs_err(self.candidate) if self.candidate in bt.preds else (None, None)
        hs = None if self.lockbox.first_origin is None else str(self.lockbox.first_origin.date())
        return {
            "validOrigins": int(len(bt.actual)),
            "maxTimestampTouched": max((e["maxTimestamp"] for e in rec.log), default=None),
            "holdoutStart": hs,
            "touchedHoldout": bool(hs is not None and any(e["maxTimestamp"] >= hs for e in rec.log)),
            "mae_log": {m: float(bt.abs_err(m).mean()) for m in models},
            "accessLog": rec.log[:3] + rec.log[-3:],
            "fitCalls": len(rec.log),
        }

    def tune(self, lags: tuple = (1, 2, 3)) -> dict:
        """A tuning run over single predictor lags on development data only."""
        ds = self._ds
        res = {}
        for L in lags:
            fs = {"baseline": ds.feature_sets["baseline"], "single": ds.feature_sets["baseline"] + [f"x_lag{L}"]}
            bt = rolling_origin(ds.rows, fs, np.ones(len(ds.rows), bool), ds.spec.min_train, ds.spec.step, models=("baseline", "single"), baselines=False)
            res[L] = float(bt.abs_err("baseline").mean() - bt.abs_err("single").mean())
        if self._opened:
            self.post_holdout = True
            self.events.append({"at": _now(), "kind": "tuning_after_open", "flag": "post_holdout"})
            for ev in self.evaluations:
                ev["postHoldout"] = True
                ev["evidenceStrength"] = "exploratory"
        return {"deltaMaeByLag": res, "postHoldout": self.post_holdout}

    # ---- the single opening ----
    def config(self) -> dict:
        e = self.frozen.get("experiment")
        return {"documentHash": self.frozen.doc_hash, "seed": self.seed, "dataDigest": self.sealed_digest, "horizon": self.spec.horizon, "lagGrid": list(self.spec.lag_grid),
                "candidate": self.candidate, "minTrain": self.spec.min_train, "thresholds": e["thresholds"]}

    def config_hash(self, config: dict | None = None) -> str:
        return "sha256:" + json_hash(config or self.config())

    def open(self, actor: str, environment: dict) -> dict:
        if not self.frozen.intact:
            raise FreezeViolation(self.frozen.violations)
        rows = self.lockbox.open(self.frozen.doc_hash)
        self._opened = True
        ev = {"at": _now(), "kind": "open", "preregistrationHash": self.frozen.doc_hash, "actor": actor, "environment": environment, "holdoutRows": int(len(rows))}
        self.events.append(ev)
        self._holdout_rows = rows  # kept only for the single final evaluation below
        return {k: v for k, v in ev.items()}

    def _evaluate(self, rows: pd.DataFrame) -> dict:
        thr = self.frozen.get("experiment.thresholds")
        q = self.frozen.get("q17")
        if len(rows) < q["minHoldoutOrigins"]:
            return {"status": "INSUFFICIENT_DATA", "n_origins": int(len(rows)), "required": q["minHoldoutOrigins"]}
        ds = self._ds
        allrows = pd.concat([ds.rows, rows], ignore_index=True)
        mask = allrows["origin"].isin(rows["origin"]).to_numpy()
        hbt = rolling_origin(allrows, ds.feature_sets, mask, ds.spec.min_train, 1, models=("baseline", self.candidate), baselines=False)
        hc = _compare(hbt, self.candidate, self.spec.horizon, thr, self.seed, "q17-holdout")
        ok = bool(hc.get("p_raw") is not None and hc["p_raw"] <= thr["holdoutAlpha"] and (hc["relative_improvement"] or 0) >= thr["minRelativeImprovement"])
        return {"status": "OK", "n_origins": hc["n_origins"], "delta_mae": hc["delta_mae"], "relative_improvement": hc["relative_improvement"], "p_raw": hc["p_raw"], "pass": ok}

    def _strength(self, result: dict) -> str:
        if self.post_holdout or not self.frozen.intact:
            return "exploratory"
        if result["status"] != "OK":
            return "pre_registered"
        return "out_of_sample" if result["pass"] else "pre_registered"

    def final_evaluation(self, actor: str, environment: dict) -> dict:
        if not self._opened:
            raise LockboxError("open the lockbox (under a frozen hash) before the final evaluation")
        if self.evaluations:
            self.events.append({"at": _now(), "kind": "second_independent_evaluation_refused", "actor": actor})
            raise SecondEvaluationRefused("a second independent final evaluation is refused (holdout evaluation count stays 1)")
        res = self._evaluate(self._holdout_rows)
        rec = {"kind": "final_evaluation", "actor": actor, "environment": environment, "at": _now(), "configHash": self.config_hash(), "result": res, "evidenceStrength": self._strength(res), "postHoldout": self.post_holdout}
        self.evaluations.append(rec)
        self.frozen.record_result("Q17:final_evaluation", kind="final_evaluation", configHash=rec["configHash"])
        return rec

    def audit_replay(self, actor: str, environment: dict, config: dict) -> dict:
        if not self.evaluations:
            raise LockboxError("an audit replay needs a completed final evaluation")
        if self.config_hash(config) != self.evaluations[0]["configHash"]:
            self.events.append({"at": _now(), "kind": "replay_with_altered_value_refused", "actor": actor})
            raise SecondEvaluationRefused("audit replay refused: configuration differs from the frozen one; treated as a prohibited second evaluation")
        rows = self.lockbox.replay_rows(self.frozen.doc_hash)
        res = self._evaluate(rows)
        orig = self.evaluations[0]
        rec = {"kind": "audit_replay", "audit_replay": True, "actor": actor, "environment": environment, "at": _now(), "configHash": orig["configHash"], "result": res,
               "evidenceStrength": orig["evidenceStrength"], "countsAsIndependentEvaluation": False}
        tol = self.frozen.get("q17.replayTolerance")
        rec["maxAbsDiffVsOriginal"] = max((abs(res[k] - orig["result"][k]) for k in ("delta_mae", "relative_improvement", "p_raw") if k in res and res.get(k) is not None), default=0.0)
        rec["withinTolerance"] = bool(rec["maxAbsDiffVsOriginal"] <= tol)
        self.replays.append(rec)
        return rec

    @property
    def holdout_evaluation_count(self) -> int:
        return len(self.evaluations)
