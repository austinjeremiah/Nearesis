# Publishing key hardening and signing-time anchoring

Status: key migrated to the macOS login Keychain and pinned (2026-11-13, owner approval in ADR-20261112-001, item 2).
The pipeline is production-hardened only while every publishing process uses the Keychain or an encrypted key
(`hardened: true` in the publish response). The legacy plaintext file `.data/keys/publish-live-ed25519.pem` still exists;
the owner decides when to retire it.

## Key handling

- Signing key: Keychain item service `nearesis-publish-key`, account `publish` (base64 of the PKCS#8 PEM). Loader:
  `packages/capsule/src/publish-key.ts`. Pinned fingerprint (sha256 of SPKI DER):
  `7c0843a313c847b62049d5201d77a12bed7b6cf89ca18654b236b0ef5cd9b446`, registry `packages/capsule/trusted-publish-keys.json`
  (public data, added with proof of possession).
- API (`apps/api/src/publish-signer.ts`): `NEARESIS_PUBLISH_KEYCHAIN=1` (hardened) or `NEARESIS_PUBLISH_KEY_ENCRYPTED_FILE` +
  `NEARESIS_PUBLISH_KEY_PASSPHRASE` (hardened). A plaintext `NEARESIS_PUBLISH_KEY_FILE` is refused (503
  `PLAINTEXT_PUBLISH_KEY_REFUSED`) unless `NEARESIS_ALLOW_PLAIN_PUBLISH_KEY=1`; then responses, logs and audit say
  `hardened: false`. With no source the manifest is unsigned (also `hardened: false`).

## The backdating limitation

A manifest carries `signedAt`, bound to the key by `signedAtSignature`. The key holder asserts that time, so a stolen key
can sign a manifest after revocation and claim an earlier `signedAt`. Signature checks alone cannot detect this.

## Independent append-only publication record

1. Postgres `publication_anchor_log` (migration `018_publication_anchor.sql`): every published manifest hash and its claimed
   `signedAt` are appended with the database clock. A trigger assigns `seq`, `prev_hash`, `anchored_at` and
   `entry_hash = sha256(seq|kind|manifest_hash|signed_at|anchored_at|payload|prev_hash)`; clients cannot choose them.
   UPDATE, DELETE and TRUNCATE are refused by trigger. `verifyAnchorChain` recomputes the chain offline.
2. The manifest hash is also committed (hash only) to `commit.majorlynx5104.testnet` (`scripts/release/testnet-anchor-manifest.ts`,
   or the `anchorChain` hook of the publish route) and a `chain-commit` entry records the transaction and the contract view
   block time.
3. `verifyPublishManifest(..., { registry, anchors })`: a revoked key's manifest is trusted only if the manifest is in an
   intact log, its earliest independent time (log time or chain view time) is not after `revokedAt`, and `signedAt` is
   before `revokedAt`. Not in the log, or logged after revocation, means untrusted. Active keys are unaffected.

Residual limits: the log is operator-hosted (a database superuser could still rewrite the whole chain; the NEAR commit
and any externally shared head hash are what defeat that); manifests published before the log existed have no anchor and
fall back to the signer-asserted time when no log is supplied.
