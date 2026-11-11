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
  /** ch.20: attestation and chain-commitment state. Never filled with invented values: null fields mean not done. */
  attestation: z
    .strictObject({
      status: z.enum(["unverified", "verified", "blocked"]),
      evidenceSource: z.enum(["fixture", "live"]).nullable(),
      jobId: z.string().max(200).nullable(),
      reason: z.string().max(300).nullable(),
    })
    .optional(),
  chainCommitment: z
    .strictObject({
      status: z.enum(["unverified", "committed", "blocked"]),
      network: z.enum(["testnet", "mainnet"]).nullable(),
      txHash: z.string().max(100).nullable(),
      reason: z.string().max(300).nullable(),
    })
    .optional(),
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
  /** Approved TD measurements (MRTD, 96 hex chars). Empty list rejects every quote-backed attestation. */
  allowedMeasurements: z.array(z.string().regex(/^[0-9a-f]{96}$/)).default([]),
  /** SHA-256 of the DER of each pinned production quote-chain root certificate. Empty: no live proof is reachable. */
  quoteTrustRootSha256: z.array(Sha256Hex).default([]),
});
export type AttestationPolicy = z.infer<typeof AttestationPolicy>;

export const AttestationDecision = z.strictObject({
  decision: z.enum(["accept", "reject"]),
  /** Machine-readable reasons; every rejection carries at least one. */
  reasons: z.array(z.string()),
  /** `outlayer_attested` only with real provenance AND an accepting quote verifier. Otherwise a policy-only label. */
  proofLabel: z.enum(["outlayer_attested", "fixture_attested", "policy_checked_synthetic", "none"]),
  /** `live` only when a quote chained to a pinned production root; otherwise `fixture`. Never upgraded afterwards. */
  evidenceSource: z.enum(["fixture", "live"]).optional(),
  /** First (highest priority) rejection reason, or null on accept. */
  reasonCode: z.string().nullable().optional(),
  /** MRTD of the quoted TD, hex. Present when a quote was verified. */
  measurement: z.string().nullable().optional(),
});
export type AttestationDecision = z.infer<typeof AttestationDecision>;

const Hex64 = Sha256Hex;
/**
 * Stored proof record (ch.12 "OutLayer proof layer"). A completed record has all seven fields non-null and every hash is
 * the SHA-256 of the artifact it names. A blocked record has `jobId: null`, status `unverified`, a reason, and `null`
 * (never a placeholder hash) for anything that does not exist.
 */
export const ProofRecord = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("verified"),
    evidenceSource: z.enum(["fixture", "live"]),
    sourceArtifactSha256: Hex64,
    exactInputs: z.strictObject({ path: z.string().min(1).max(300), sha256: Hex64 }),
    wasmSha256: Hex64,
    outputSha256: Hex64,
    approvedMeasurements: z.array(z.string().regex(/^[0-9a-f]{96}$/)).min(1),
    quoteVerification: z.strictObject({ ok: z.literal(true), reasonCode: z.null(), measurement: z.string() }),
    jobId: z.string().min(1).max(200),
  }),
  z.strictObject({
    status: z.literal("unverified"),
    evidenceSource: z.enum(["fixture", "live"]).nullable(),
    sourceArtifactSha256: Hex64.nullable(),
    exactInputs: z.strictObject({ path: z.string().min(1).max(300), sha256: Hex64 }).nullable(),
    wasmSha256: Hex64.nullable(),
    outputSha256: Hex64.nullable(),
    approvedMeasurements: z.array(z.string().regex(/^[0-9a-f]{96}$/)),
    quoteVerification: z
      .strictObject({ ok: z.literal(false), reasonCode: z.string().nullable(), measurement: z.null() })
      .nullable(),
    jobId: z.null(),
    reason: z.string().min(1).max(500),
  }),
]);
export type ProofRecord = z.infer<typeof ProofRecord>;
