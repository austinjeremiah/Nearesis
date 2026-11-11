import { z } from "zod";
import { IsoDateTime, PrefixedSha256, Sha256Hex } from "./common.ts";

/**
 * Research capsule (ch.14 OutLayer, ch.15 P09): a self-contained, hash-addressed bundle of frozen raw data, the
 * deterministic computation over it, the claims that cite those results, and the published exports.
 * Local reproducibility and OutLayer attestation are separate facts and are never merged: `local` is recomputed by this
 * repository's code; `outlayer` is "verified" only when a real attestation passed the proof policy with a quote verifier.
 */
export const CapsuleLabel = z.enum(["SYNTHETIC", "RECORDED", "LIVE"]);
export const CapsuleClaimClass = z.enum([
  "observed_fact",
  "derived_statistic",
  "agent_interpretation",
  "hypothesis",
  "unsupported",
]);

const CapsuleId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);

export const CapsuleFileEntry = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(300)
    .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._\-/]+$/),
  sha256: Sha256Hex,
  bytes: z.number().int().nonnegative(),
});
export type CapsuleFileEntry = z.infer<typeof CapsuleFileEntry>;

export const CapsuleClaim = z.strictObject({
  id: CapsuleId,
  text: z.string().min(1).max(1000),
  claimClass: CapsuleClaimClass,
  resultIds: z.array(CapsuleId).max(20),
});

export const CapsuleResult = z.strictObject({
  id: CapsuleId,
  label: z.string().min(1).max(200),
  value: z.string().min(1).max(80),
  unit: z.string().max(40).nullable(),
  computation: z.string().max(300),
});

export const CapsuleManifest = z.strictObject({
  schemaVersion: z.literal("nearesis.capsule.v1"),
  capsuleId: CapsuleId,
  title: z.string().min(1).max(300),
  label: CapsuleLabel,
  /** Taken from the frozen snapshot, never from the wall clock, so a rebuild is byte-identical. */
  createdAt: IsoDateTime,
  snapshot: z.strictObject({
    snapshotId: z.string().min(1).max(120),
    files: z.array(CapsuleFileEntry).min(1).max(200),
    /** SHA-256 over the sorted `path:sha256` lines of the raw files. */
    dataHash: Sha256Hex,
  }),
  computation: z.strictObject({
    verifier: z.strictObject({ name: z.string(), wasmSha256: Sha256Hex.nullable() }),
    metrics: z.array(z.string()).min(1),
    inputFile: CapsuleFileEntry,
    resultsFile: CapsuleFileEntry,
    inputSha256: Sha256Hex,
    resultsSha256: Sha256Hex,
  }),
  research: z
    .strictObject({
      runFile: CapsuleFileEntry,
      /** `fixture` runs can be re-executed offline; `recorded` runs are checked by file hash only. */
      reproduce: z.enum(["fixture", "recorded"]),
      fixture: z.string().nullable(),
      seed: z.number().int().nullable(),
      preregistrationHash: PrefixedSha256.nullable(),
    })
    .nullable(),
  claims: z.array(CapsuleClaim).max(50),
  results: z.array(CapsuleResult).max(100),
  publication: z.strictObject({ files: z.array(CapsuleFileEntry).max(20) }),
  hashes: z.strictObject({
    preregistrationHash: Sha256Hex.nullable(),
    sourceSnapshotHash: Sha256Hex,
    semanticModelHash: Sha256Hex,
    analysisCodeCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
    containerDigest: PrefixedSha256.nullable(),
    resultManifestHash: Sha256Hex,
  }),
  limitations: z.array(z.string().max(500)).max(30),
  /** SHA-256 of the canonical manifest with this field removed. */
  capsuleHash: Sha256Hex,
});
export type CapsuleManifest = z.infer<typeof CapsuleManifest>;

/** Exactly the record the capsule viewer renders (apps/web CapsuleView). `GET /v1/capsules/:id` returns it. */
export const CapsuleViewRecord = z.strictObject({
  capsuleId: CapsuleId,
  title: z.string().min(1).max(300),
  sourceLabel: CapsuleLabel,
  createdAt: IsoDateTime,
  claims: z.array(CapsuleClaim).max(50),
  results: z.array(CapsuleResult).max(100),
  hashes: CapsuleManifest.shape.hashes,
  verification: z.strictObject({
    local: z.strictObject({
      status: z.enum(["reproduced", "mismatch", "not_run"]),
      method: z.string().max(300),
      checkedAt: IsoDateTime.nullable(),
      detail: z.string().max(500),
    }),
    outlayer: z.strictObject({
      status: z.enum(["verified", "failed", "unverified", "not_submitted"]),
      method: z.string().max(300),
      jobId: z.string().max(200).nullable(),
      checkedAt: IsoDateTime.nullable(),
      detail: z.string().max(500),
    }),
    failures: z
      .array(z.strictObject({ at: IsoDateTime, kind: z.string().max(80), detail: z.string().max(500) }))
      .max(50),
  }),
  provenance: z
    .array(
      z.strictObject({
        id: CapsuleId,
        kind: z.enum(["source", "snapshot", "query", "model", "result", "claim", "code"]),
        label: z.string().max(300),
        hash: z.string().max(80).nullable(),
        parents: z.array(CapsuleId).max(20),
      }),
    )
    .max(200),
  rebuild: z.strictObject({
    command: z.string().max(300),
    snapshotId: z.string().max(120),
    steps: z.array(z.string().max(300)).max(20),
  }),
  exports: z
    .array(
      z.strictObject({ label: z.string().max(120), href: z.string().max(500), sha256: Sha256Hex.nullable() }),
    )
    .max(20),
  limitations: z.array(z.string().max(500)).max(30),
});
export type CapsuleViewRecord = z.infer<typeof CapsuleViewRecord>;

export const CapsuleResponseRecord = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), capsule: CapsuleViewRecord }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type CapsuleResponseRecord = z.infer<typeof CapsuleResponseRecord>;

/** Evidence of one OutLayer (or stand-in) execution, as presented to the proof policy. */
export const AttestationEvidence = z.strictObject({
  /** `outlayer` evidence must come with a quote that a registered QuoteVerifier accepts. `synthetic` is test-only. */
  provenance: z.enum(["outlayer", "synthetic"]),
  jobId: z.string().min(1).max(200),
  network: z.enum(["testnet", "mainnet", "none"]),
  wasmSha256: Sha256Hex,
  inputSha256: Sha256Hex,
  outputSha256: Sha256Hex,
  /** Identity of the TEE signer (public key, base64url or hex) */
  signer: z.string().min(1).max(500),
  /** Signature over the canonical attestation payload (see packages/capsule attestation). */
  signature: z.string().min(1).max(2000),
  quote: z.string().max(100_000).nullable(),
  issuedAt: IsoDateTime,
});
export type AttestationEvidence = z.infer<typeof AttestationEvidence>;

export const AttestationPolicy = z.strictObject({
  schemaVersion: z.literal("nearesis.attestation-policy.v1"),
  /** Pinned WASM component hashes. Empty list rejects everything. */
  allowedWasmSha256: z.array(Sha256Hex),
  /** Registered TEE signers. Empty list rejects everything (fail closed). */
  allowedSigners: z.array(z.string().min(1)),
  allowedNetworks: z.array(z.enum(["testnet", "mainnet"])),
  maxAgeSeconds: z.number().int().positive(),
});
export type AttestationPolicy = z.infer<typeof AttestationPolicy>;

export const AttestationDecision = z.strictObject({
  decision: z.enum(["accept", "reject"]),
  /** Machine-readable reasons; every rejection carries at least one. */
  reasons: z.array(z.string()),
  /** `outlayer_attested` only with real provenance AND an accepting quote verifier. Otherwise a policy-only label. */
  proofLabel: z.enum(["outlayer_attested", "policy_checked_synthetic", "none"]),
});
export type AttestationDecision = z.infer<typeof AttestationDecision>;
