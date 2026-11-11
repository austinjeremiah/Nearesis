import { z } from "zod";
import { PrefixedSha256 } from "./common.ts";

/**
 * Machine-readable output of the statistical research engine (ch.08, services/research). Python computes every
 * number; agents (Research Director, Skeptic, Auditor, Composer) and the dashboard only read this envelope.
 * `status` and `evidenceStrength` are separate axes. `claimScope` makes explicit that fixture runs make no live claim.
 */
export const ResearchStatus = z.enum([
  "SUPPORTED",
  "MIXED",
  "UNSUPPORTED",
  "INSUFFICIENT_DATA",
  "NOT_REPRODUCIBLE",
]);
export const ResearchEvidenceStrength = z.enum([
  "exploratory",
  "pre_registered",
  "out_of_sample",
  "independent_replication",
]);
export const ResearchClaimScope = z.enum([
  "synthetic_fixture_only_no_live_claim",
  "live_dataset_subject_to_coverage",
]);

const Num = z.number().nullable();

export const ResearchConfidenceInterval = z.strictObject({
  lo: Num,
  hi: Num,
  level: z.number(),
  n_boot: z.number().int(),
});

export const ResearchDieboldMariano = z.looseObject({
  n: z.number().int(),
  mean_diff: Num,
  t: Num,
  p_one_sided: Num,
});

/** Candidate model versus the baseline at one horizon (delta_mae > 0 means the candidate is better). */
export const ResearchComparison = z.looseObject({
  candidate: z.enum(["intents", "price", "combined"]),
  horizon: z.number().int().positive(),
  n_origins: z.number().int().nonnegative(),
  mae_baseline: z.number().optional(),
  mae_candidate: z.number().optional(),
  delta_mae: z.number().optional(),
  relative_improvement: z.number().nullable().optional(),
  dm: ResearchDieboldMariano.optional(),
  p_raw: Num.optional(),
  p_adjusted: z.number().optional(),
  fdr_reject: z.boolean().optional(),
  delta_mae_ci: ResearchConfidenceInterval.optional(),
  status: z.string().optional(),
});

export const ResearchVerdict = z.strictObject({
  status: ResearchStatus,
  evidenceStrength: ResearchEvidenceStrength,
  reasons: z.array(z.string()),
  thresholdsFrom: z.literal("frozen_preregistration"),
});

export const ResearchPreregistration = z.looseObject({
  experimentId: z.string(),
  methodVersion: z.string(),
  hypothesis: z.string(),
  horizons: z.array(z.number().int().positive()),
  primaryHorizon: z.number().int().positive(),
  primaryCandidate: z.enum(["intents", "price", "combined"]),
  family: z.array(
    z.strictObject({ candidate: z.string(), horizon: z.number().int(), versus: z.literal("baseline") }),
  ),
  fdr: z.strictObject({ method: z.literal("benjamini_hochberg"), q: z.number() }),
  loss: z.string(),
  randomSeed: z.number().int(),
  causalClaim: z.literal("excluded"),
  hash: PrefixedSha256,
});

export const ResearchInputSnapshot = z.looseObject({
  label: z.enum(["SYNTHETIC", "LIVE"]),
  datasetHash: PrefixedSha256,
  complete: z.boolean(),
  developmentRows: z.number().int(),
  postRegimeRows: z.number().int(),
  straddleRowsExcluded: z.number().int(),
  lockbox: z.strictObject({ n: z.number().int(), hash: z.string(), opened: z.boolean() }),
  droppedSamples: z.looseObject({ count: z.number().int(), protocol: z.string() }),
  regimeSplit: z.string(),
});

export const ResearchCounterEvidence = z.looseObject({ kind: z.string() });

export const ResearchRunArtifact = z.strictObject({
  schemaVersion: z.literal("research-artifacts@1"),
  methodVersion: z.string(),
  experimentId: z.string(),
  status: ResearchStatus,
  evidenceStrength: ResearchEvidenceStrength,
  verdict: ResearchVerdict,
  claimScope: ResearchClaimScope,
  preregistrationVerified: z.boolean(),
  hypothesis: z.looseObject({
    text: z.string(),
    primaryComparison: z.string(),
    primaryHorizon: z.number().int(),
    causalClaim: z.literal("excluded"),
  }),
  preregistration: ResearchPreregistration,
  inputSnapshot: ResearchInputSnapshot,
  features: z.looseObject({
    horizon: z.number().int(),
    columns: z.record(z.string(), z.looseObject({ source: z.string() })),
  }),
  models: z.looseObject({
    classes: z.array(z.string()),
    simpleBaselines: z.array(z.string()),
    libraryVersions: z.record(z.string(), z.string()),
  }),
  windows: z.looseObject({ design: z.string() }),
  estimates: z.looseObject({
    primary: ResearchComparison,
    byHorizonCandidate: z.record(z.string(), ResearchComparison),
    fdr: z.looseObject({
      m: z.number().int(),
      q: z.number(),
      adjusted: z.array(z.number()),
      reject: z.array(z.boolean()),
    }),
    holdout: z.looseObject({}).nullable(),
  }),
  uncertainty: z.looseObject({
    deltaMaeCI: ResearchConfidenceInterval.nullable().optional(),
    method: z.string(),
    validOrigins: z.number().int().optional(),
  }),
  counterevidence: z.array(ResearchCounterEvidence),
  limitations: z.array(z.string()).min(1),
  falsification: z.looseObject({ placebo: z.looseObject({ passed: z.boolean(), p_value: Num }).nullable() }),
  reproduction: z.looseObject({
    command: z.string().nullable(),
    seed: z.number().int(),
    preregistrationHash: PrefixedSha256,
  }),
  artifactHashes: z.record(z.string(), PrefixedSha256),
});
export type ResearchRunArtifact = z.infer<typeof ResearchRunArtifact>;
export type ResearchStatus = z.infer<typeof ResearchStatus>;
