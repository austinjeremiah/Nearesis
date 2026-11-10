# nearesis-verifier (OutLayer, `wasm32-wasip2`)

A deterministic recomputation verifier for Nearesis research claims, built for
OutLayer verifiable execution (Build Bible ch.12 "OutLayer proof layer", ch.14 R12/R13).
It takes a canonical JSON research input, **recomputes** the selected metrics with
exact integer arithmetic, digests the input and results, and compares them with the
digests the claim asserts.

It is **not** an OutLayer example program. It does **not** assert that the source data
is accurate: per the Bible, an attestation is never equated with the accuracy of a third-party source.

## I/O contract (OutLayer WASI)
- stdin: one JSON document, at most 1 MiB. stdout: one canonical JSON document, **at most 900 bytes** (the OutLayer limit).
- Exit 0 for every semantic outcome. Non-zero only on stdout I/O failure.
- No filesystem, network, randomness or wall clock is used. Component imports are
  `wasi:cli/*`, `wasi:io/*` and `wasi:clocks/monotonic-clock` only, the last one pulled in by Rust std.

## Input `nearesis.verifier.input.v1`
```json
{
  "schema_version": "nearesis.verifier.input.v1",
  "claim_id": "h1:intents-leads-usage",
  "source": {"dataset": "bigquery-public-data.crypto_near_mainnet_us", "snapshot_id": "2026-11-10T00:00Z", "synthetic": false},
  "series": {
    "x": {"name": "intents_volume", "unit": "usd_cents", "points": [["2026-11-01", "123"], ["2026-11-02", "130"]]},
    "y": {"name": "active_signers", "unit": "accounts",  "points": [["2026-11-01", "44352"], ["2026-11-02", "45012"]]}
  },
  "metrics": ["lag_pearson:7", "pearson", "summary"],
  "expected": {"input_sha256": "<hex64>", "results_sha256": "<hex64>"}
}
```
Rules (violations give `INVALID_INPUT` plus an error `code` and `path`):
- Unknown or duplicate fields are rejected.
- Values are **decimal-integer strings** `-?(0|[1-9][0-9]*)` with |v| ≤ 1e15. Floats, exponents and JSON numbers are rejected. Scale to an integer unit (e.g. cents) before submitting.
- Dates are `YYYY-MM-DD` (1970 to 2100), strictly consecutive days, identical for x and y. Each series has 2 to 4096 points.
- `metrics` must be strictly ascending (sorted and unique), chosen from `summary`, `pearson` and `lag_pearson:<1..90>` (at most 4 lags, and each lag ≤ n−2).
- Text fields are printable ASCII without `"` or `\`. IDs use `[A-Za-z0-9._:/-]`.
- `expected` is optional. Without it the status is `COMPUTED`, which is the mode used to produce a claim's digests. `expected.input_sha256` is optional; `results_sha256` is required.

## Canonical JSON and digests
Canonical form: keys sorted by byte order, no whitespace, ASCII-only strings with no escapes, and integers as strings. Under those restrictions it equals RFC 8785 (JCS) output.
- `input_sha256` = SHA-256 of the canonical input **with `expected` removed**.
- `results_sha256` = SHA-256 of the canonical `results` object.

Field order and whitespace in the submitted JSON do not change either digest (unit test).

## Metrics (exact integers, rounding half away from zero)
| Key | Definition |
|---|---|
| `n` | number of days |
| `x`/`y`.`sum`,`min`,`max` | exact |
| `x`/`y`.`mean_micro` | round(sum·10⁶ / n) |
| `x`/`y`.`growth_bps` | round((last−first)·10⁴ / first); `null` if first = 0 |
| `pearson_ppm` | round(10⁶·(nΣxy−ΣxΣy) / ⌊√(AB)⌋) with A = nΣx²−(Σx)², B = nΣy²−(Σy)², clamped to ±10⁶; `null` if A or B = 0. AB is computed in U256 |
| `lag_pearson_ppm.k` | `pearson_ppm(x[t], y[t+k])`, i.e. x leads y by k days (Bible H1) |

## Output `nearesis.verifier.output.v1`
`status` is one of `VERIFIED`, `MISMATCH`, `COMPUTED` or `INVALID_INPUT`. The output also carries `claim_id`,
`synthetic`, `input_sha256`, `results_sha256`, `checks` (one boolean per supplied digest),
`results`, `schema_version` and `verifier`. If the output would exceed 900 bytes, `results` is dropped and
`results_omitted: true` is set. The digests are always kept, and anyone can recompute the results from the input.

## Build, test and reproduce
```sh
./build.sh                               # wasm32-wasip2, pinned toolchain 1.99.1, path-remapped
cargo test --release                     # 19 unit tests (native)
python3 tools/make_fixtures.py           # regenerate the 18 SYNTHETIC fixtures with the independent Python reference
python3 tests/run_wasm_tests.py "$(which wasmtime)" out/nearesis-verifier.wasm --runs 5
```
`tools/reference_verifier.py` is a separate implementation of this spec. The WASM output must be
byte-identical to it for every valid fixture.

## Upload (testnet only)
```sh
OUTLAYER_NETWORK=testnet outlayer whoami                       # must show testnet
OUTLAYER_NETWORK=testnet outlayer upload out/nearesis-verifier.wasm
```
`upload` signs a FunctionCall to `outlayer.testnet` with method `__fastdata_fastfs`, **0 deposit** and gas=1. The call
reverts by design and the FastFS indexer records the data.
