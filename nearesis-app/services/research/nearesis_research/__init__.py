"""Nearesis statistical research engine (ch.08). Code computes every estimate; no LLM is involved."""

import os

# Reproducibility: single-thread BLAS/OpenMP must be set before numpy is imported anywhere.
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_v] = "1"

METHOD_VERSION = "near.intents_pred_v1@1.0.0"
SCHEMA_VERSION = "research-artifacts@1"
REGIME_SPLIT_DATE = "2026-10-27"  # first day of the private-settlement regime (ch.02, ch.14)
