"""Hashing, canonical JSON and deterministic randomness."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

import numpy as np
import pandas as pd

FLOAT_DIGITS = 10  # canonical JSON rounds to this many decimals so hashes are stable across BLAS builds


def _canon(o: Any) -> Any:
    if isinstance(o, dict):
        return {str(k): _canon(v) for k, v in sorted(o.items(), key=lambda kv: str(kv[0]))}
    if isinstance(o, (list, tuple)):
        return [_canon(v) for v in o]
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return None if math.isnan(f) or math.isinf(f) else round(f, FLOAT_DIGITS)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (pd.Timestamp,)):
        return o.strftime("%Y-%m-%d")
    if isinstance(o, np.ndarray):
        return _canon(o.tolist())
    return o


def canonical_json(o: Any) -> str:
    return json.dumps(_canon(o), sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sha256_hex(b: bytes | str) -> str:
    return hashlib.sha256(b.encode() if isinstance(b, str) else b).hexdigest()


def json_hash(o: Any) -> str:
    return sha256_hex(canonical_json(o))


def frame_hash(df: pd.DataFrame) -> str:
    """Content hash of a frame: column names, dtypes-agnostic exact values (NaN marked), row order significant."""
    h = hashlib.sha256()
    h.update(("|".join(map(str, df.columns))).encode())
    for row in df.itertuples(index=False):
        parts = []
        for v in row:
            if isinstance(v, (float, np.floating)):
                parts.append("NaN" if math.isnan(v) else float(v).hex())
            elif isinstance(v, pd.Timestamp):
                parts.append(v.strftime("%Y-%m-%d"))
            else:
                parts.append(str(v))
        h.update(("\x1f".join(parts) + "\n").encode())
    return h.hexdigest()


def rng(seed: int, *stream: int | str) -> np.random.Generator:
    """Independent deterministic stream per (seed, stream-labels)."""
    ss = np.random.SeedSequence([seed, *[int(sha256_hex(str(s))[:8], 16) for s in stream]])
    return np.random.default_rng(ss)
