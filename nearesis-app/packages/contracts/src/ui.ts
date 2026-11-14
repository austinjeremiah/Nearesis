import { z } from "zod";
import { IsoDateTime, Uuid } from "./common.ts";

/**
 * v1.3.0 additive read-only shapes behind the UI shell (sidebar investigations list, source freshness, run budget
 * usage). Nothing here is a command; no existing contract changes.
 */
export const RunStateName = z.enum([
  "REQUESTED",
  "PLANNING",
  "APPROVAL_NEEDED",
  "EXECUTING",
  "EVIDENCE_REVIEW",
  "CANVAS_PATCH_REVIEW",
  "COMPLETE",
  "PARTIAL",
  "BLOCKED",
  "CANCELLED",
]);
export type RunStateName = z.infer<typeof RunStateName>;

/** One investigation row for `GET /v1/workspaces/:id/runs`. */
export const RunListItem = z.strictObject({
  runId: Uuid,
  questionSummary: z.string().max(200),
  state: RunStateName,
  terminal: z.boolean(),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RunListItem = z.infer<typeof RunListItem>;
export const RunListResponse = z.strictObject({ workspaceId: Uuid, runs: z.array(RunListItem) });
export type RunListResponse = z.infer<typeof RunListResponse>;

export const SourceFreshnessState = z.enum(["fresh", "late", "partial", "stale", "unavailable"]);
export type SourceFreshnessState = z.infer<typeof SourceFreshnessState>;

/** One source row for `GET /v1/workspaces/:id/sources`. */
export const SourceFreshness = z.strictObject({
  sourceId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  freshness: SourceFreshnessState,
  watermark: IsoDateTime.nullable(),
});
export type SourceFreshness = z.infer<typeof SourceFreshness>;
export const SourceListResponse = z.strictObject({ workspaceId: Uuid, sources: z.array(SourceFreshness) });
export type SourceListResponse = z.infer<typeof SourceListResponse>;

/** Spent versus reserved versus total for one run, from `runtime.budget_ledger` (added to `GET /v1/runs/:id`). */
export const BudgetAmounts = z.strictObject({
  tokens: z.number().nonnegative(),
  toolCalls: z.number().nonnegative(),
  usd: z.number().nonnegative(),
});
export const RunBudgetUsage = z.strictObject({
  total: BudgetAmounts,
  /** Charges: what was actually consumed. */
  spent: BudgetAmounts,
  /** Open reservations: reserved minus released. */
  reserved: BudgetAmounts,
});
export type RunBudgetUsage = z.infer<typeof RunBudgetUsage>;
