# Attestation proof policy

`attestation-policy.json` is the policy `@nearesis/capsule` applies to OutLayer attestation evidence (`verifyAttestation`).

- `allowedWasmSha256` pins the shipped `out/nearesis-verifier.wasm` (drift check in the V03 acceptance test).
- `allowedSigners` is **empty on purpose**. It is the list of registered TEE signer public keys (base64url ed25519). Until
  an OutLayer job has produced a real attestation and its signer has been recorded here by the owner, every evidence
  object is rejected (fail closed). No signer is invented or pre-registered.
- `allowedNetworks` is `testnet` only. Mainnet is not enabled for this project phase.

- `allowedMeasurements` lists approved TD measurements (MRTD, 96 hex characters). Empty on purpose: a quote-backed
  attestation is rejected (`MEASUREMENT_NOT_ALLOWED`) until the owner records the measurement of a real OutLayer worker.
- `quoteTrustRootSha256` lists the SHA-256 of the DER of each pinned production quote-chain root certificate (the Intel SGX
  root CA that signs the PCK chain). Empty on purpose: nothing may be labelled `live` until the owner pins the fingerprint of
  the root they obtained from Intel. No fingerprint is invented here.

## Quote verifier

`packages/capsule/src/tdx.ts` verifies the Intel TDX DCAP quote v4 (ECDSA P-256) structure: header, 584-byte TD report,
attestation-key signature, QE report binding, PCK leaf signature over the QE report, the PEM certificate chain, the DEBUG
attribute bit, and a pinned root. It performs no network access and does **not** check TCB level, QE identity or
revocation (those need Intel PCS collateral); every result says `collateralChecked: false`. The evidence's response binding
is `reportData[0..32] = SHA-256(canonical attestation payload)`; this binding is this project's policy, to be confirmed
against a real OutLayer quote when one exists.

Evidence is `live` only if the quote chained to a root listed in `quoteTrustRootSha256`; evidence cannot declare it and no
code path upgrades `fixture` to `live`. Tests chain quotes to a locally minted root, so their label is always
"fixture evidence, not OutLayer-backed". A capsule shows OutLayer "verified" only when real OutLayer evidence passes this
policy and the quote verifier. Until BLK-20261110-003 is resolved, that is unreachable by construction.
