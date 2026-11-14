import { z } from "zod";
import { ResearchFinding } from "./research.ts";
import { Uuid } from "./common.ts";

/**
 * Interpretation stage (final_master_prompt s10/s20): an analyst reads the ACTUAL result rows of a run's panels and states
 * what they show; a skeptic then challenges each finding. Findings are ResearchFindings (every number tied to a ResultRef)
 * plus the labels the reader needs: observation vs inference, what kind of statement it is, which panels it came from and
 * what the skeptic said.
 */
export const FindingBasis = z.enum(["observation", "inference"]);
export type FindingBasis = z.infer<typeof FindingBasis>;

export const FindingKind = z.enum(["trend", "change", "comparison", "spike", "coverage", "other"]);
export type FindingKind = z.infer<typeof FindingKind>;

export const InterpretedFinding = ResearchFinding.extend({
  kind: FindingKind,
  /** observation: a description of the rows. inference: a reading that goes beyond the rows (never causal or significant without a validated test). */
  basis: FindingBasis,
  /** Panels whose result rows the finding was computed from (provenance links). */
  panelIds: z.array(Uuid).max(20),
  /** Skeptic pass: alternative explanations, selection effects, coverage caveats. Never empty for a published finding. */
  skepticNotes: z.array(z.string().min(1).max(1000)).max(20),
  /** True when the skeptic pass could not run (timeout, budget); the deterministic caveats are still present. */
  skepticDegraded: z.boolean().default(false),
});
export type InterpretedFinding = z.infer<typeof InterpretedFinding>;

export const InterpretationState = z.enum(["ready", "unavailable", "none"]);
export type InterpretationState = z.infer<typeof InterpretationState>;

/** The run-level interpretation record returned by `GET /v1/runs/:id` next to `findings`. */
export const RunInterpretation = z.strictObject({
  state: InterpretationState,
  /** Why it is unavailable (MODEL_TIMEOUT, BUDGET, NO_GROUNDED_FINDING, ...) or why there is none. */
  reason: z.string().max(300).nullable(),
  findingCount: z.number().int().nonnegative(),
});
export type RunInterpretation = z.infer<typeof RunInterpretation>;

/** `data` of the `finding.created` domain event (SSE). Statement text is not repeated here: re-read the run. */
export const FindingCreatedData = z.strictObject({
  runId: Uuid,
  findingId: Uuid,
  kind: FindingKind,
  basis: FindingBasis,
  status: ResearchFinding.shape.status,
  index: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});
export type FindingCreatedData = z.infer<typeof FindingCreatedData>;

/** The fields the interpretation stage adds to `GET /v1/runs/:id` (the run record itself is unchanged). */
export const RunFindingsFields = z.looseObject({
  findings: z.array(InterpretedFinding),
  interpretation: RunInterpretation,
});
export type RunFindingsFields = z.infer<typeof RunFindingsFields>;
