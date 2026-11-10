import { z } from "zod";
import { IsoDateTime, Sha256Hex, Uuid } from "./common.ts";

export const EvidenceRelation = z.enum([
  "supports",
  "contradicts",
  "derived_from",
  "monitors",
  "references",
  "reproduces",
  "supersedes",
]);

export const ResultRef = z.strictObject({
  queryHash: Sha256Hex,
  semanticVersion: z.string(),
  rowIds: z.array(z.string()).max(1000),
  column: z.string(),
});

export const ResearchFinding = z.strictObject({
  id: Uuid,
  workspaceId: Uuid,
  runId: Uuid,
  agentRole: z.string(),
  status: z.enum(["supported", "contradicted", "mixed", "insufficient_data", "cannot_compute", "unverified"]),
  statement: z.string().min(1).max(8000),
  /** Every quantitative value in `statement` must appear here (A19 grounding). */
  facts: z.array(z.strictObject({ value: z.string(), unit: z.string(), resultRef: ResultRef })).max(200),
  limitations: z.array(z.string()).max(50),
  createdAt: IsoDateTime,
});
export type ResearchFinding = z.infer<typeof ResearchFinding>;
