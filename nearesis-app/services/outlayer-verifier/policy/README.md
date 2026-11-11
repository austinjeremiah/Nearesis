# Attestation proof policy

`attestation-policy.json` is the policy `@nearesis/capsule` applies to OutLayer attestation evidence (`verifyAttestation`).

- `allowedWasmSha256` pins the shipped `out/nearesis-verifier.wasm` (drift check in the V03 acceptance test).
- `allowedSigners` is **empty on purpose**. It is the list of registered TEE signer public keys (base64url ed25519). Until
  an OutLayer job has produced a real attestation and its signer has been recorded here by the owner, every evidence
  object is rejected (fail closed). No signer is invented or pre-registered.
- `allowedNetworks` is `testnet` only. Mainnet is not enabled for this project phase.

A capsule shows OutLayer "verified" only when the policy accepts real OutLayer evidence **and** an injected `QuoteVerifier`
accepts the TDX quote. No quote verifier ships in this repository (it needs a live job, see BLK-20261110-003).
