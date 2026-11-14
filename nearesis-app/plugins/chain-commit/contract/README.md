# commit.wat: hash-commitment contract (ADR-20261111-006)

Deployed to `commit.majorlynx5104.testnet` (testnet only), tx `EpjYmTZUx5ZNBD76HKRSCxXoW6YSvKVk5PRJDf5QUDMi`.
Build: `./build.sh` (wasm-tools 1.263.0 parse, deterministic). Deployed WASM sha256 (915 bytes):
`3e0f38459bd910e1ac69ccf5a7f02ff9ce90a2bd5bd73d5c5dcf1c6144fb22c3`.
`commit_hash` is owner-only (`majorlynx5104.testnet`), stores a hash once; `get_commitment` is a public view.
The account has no access keys, so the contract is immutable.
