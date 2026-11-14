"""Rolling-origin evaluation entry point for Q11. Every parameter comes from the frozen preregistration; random k-fold
evaluation is refused with a structured error; every fit call is recorded by an access recorder."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .dataset import Inputs, Spec, build_dataset
from .frozen import Frozen
from .models import AccessRecorder, rolling_origin, losses


class EvaluationRefused(ValueError):
    """Structured refusal: `code` and `detail` are machine readable."""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail

    def to_dict(self) -> dict:
        return {"error": self.code, "detail": self.detail}


def spec_from_frozen(frozen: Frozen) -> Spec:
    e = frozen.get("experiment")
    q = frozen.get("q11")
    return Spec(
        horizon=q["horizon"],
        lag_grid=tuple(q["lagGrid"]),
        lockbox_days=e["lockboxDays"],
        min_train=q["minTrainingLength"],
        regime_split=e["regimeSplit"],
    )


def evaluate_rolling_origin(inputs: Inputs, frozen: Frozen, scheme: str = "rolling_origin", recorder: AccessRecorder | None = None) -> dict:
    """Walk-forward evaluation of M0-M3 at the frozen horizon. Refuses a run whose frozen file is missing a value or was
    edited after results; refuses random cross-validation."""
    if scheme != "rolling_origin":
        raise EvaluationRefused("random_cross_validation_prohibited", f"scheme '{scheme}' is not allowed on serially correlated data; use rolling_origin")
    frozen.require_intact()
    q = frozen.get("q11")
    spec = spec_from_frozen(frozen)
    ds = build_dataset(inputs, spec, frozen.doc_hash)
    rec = recorder if recorder is not None else AccessRecorder()
    models = tuple(q["models"].values())
    bt = rolling_origin(ds.rows, ds.feature_sets, np.ones(len(ds.rows), bool), spec.min_train, spec.step, models=models, recorder=rec)
    n = int(len(bt.actual))
    td = pd.DatetimeIndex(bt.target_dates)
    chrono = bool((np.diff(bt.origins.asi8) > 0).all() and (np.diff(td.asi8) > 0).all()) if n > 1 else True
    status = "OK" if n >= q["minValidOrigins"] else "INSUFFICIENT_DATA"
    out = {
        "status": status,
        "validOrigins": n,
        "minValidOrigins": q["minValidOrigins"],
        "horizon": spec.horizon,
        "lagGrid": list(spec.lag_grid),
        "minTrainingLength": spec.min_train,
        "models": {name: models[i] for i, name in enumerate(q["models"])},
        "strictlyChronologicalNonOverlappingTargets": chrono,
        "firstOrigin": None if n == 0 else str(bt.origins[0].date()),
        "lastOrigin": None if n == 0 else str(bt.origins[-1].date()),
        "mae_log": {name: (losses(bt.actual, bt.preds[m])["mae_log"] if n else None) for name, m in q["models"].items()},
        "fitCalls": len(rec.log),
        "violations": rec.violations(),
        "registration": {"label": frozen.registration_label, "documentHash": frozen.doc_hash, "frozenAt": frozen.record["frozenAt"]},
        "developmentRows": int(len(ds.rows)),
    }
    frozen.record_result("Q11:rolling_origin", n=n)
    return out
