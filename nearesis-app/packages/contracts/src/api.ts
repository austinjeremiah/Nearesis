import { z } from "zod";
import { Uuid } from "./common.ts";
import { NetworkScope } from "./identity.ts";

/** Versioned API commands (ch.11 REST v1). Idempotency-Key and If-Match travel as headers too. */
export const CreateWorkspaceRequest = z.strictObject({
  objective: z.string().min(1).max(4000),
  networkScope: NetworkScope,
  idempotencyKey: z.string().min(8).max(200),
});
export const CreateWorkspaceResponse = z.strictObject({
  workspaceId: Uuid,
  version: z.number().int().nonnegative(),
});

export const CommandType = z.enum([
  "workspace.update_objective",
  "canvas.apply_patch",
  "marker.create",
  "plugin.enable",
  "plugin.disable",
  "graph.save_layout",
  "marker.transition",
  "marker.assign",
  "marker.link_evidence",
  "lens.create",
  "lens.update",
  "lens.delete",
  "monitor.rule_create",
  "monitor.rule_update",
  "monitor.rule_enable",
  "monitor.rule_disable",
  "notification.read",
]);
export const WorkspaceCommand = z.strictObject({
  apiVersion: z.literal("v1"),
  commandId: Uuid,
  commandType: CommandType,
  payload: z.record(z.string(), z.unknown()),
  expectedVersion: z.number().int().nonnegative(),
});
export type WorkspaceCommand = z.infer<typeof WorkspaceCommand>;
export const CommandAccepted = z.strictObject({
  commandId: Uuid,
  workspaceVersion: z.number().int().nonnegative(),
  eventSeq: z.number().int().positive(),
  resultFingerprint: z.string(),
});

/** v1.4.0 (additive): which semantic layer the run's agents query. Absent means the SYNTHETIC fixture cubes. */
export const QuestionSource = z.enum(["fixture", "live"]);
export type QuestionSource = z.infer<typeof QuestionSource>;

/**
 * Smallest budget a question may carry: the director's reservation (20k tokens, 6 calls, USD 2) plus the composer's
 * (12k, 6, USD 1). Below this the runtime cannot reserve for the plan and the run would stall (FND-20261110-042).
 */
export const MIN_QUESTION_BUDGET = { tokens: 32_000, toolCalls: 12, usd: 3 } as const;

export const SubmitQuestionRequest = z.strictObject({
  question: z.string().min(1).max(4000),
  snapshotPolicy: z.enum(["live", "pinned"]),
  source: QuestionSource.default("fixture"),
  budget: z.strictObject({
    tokens: z.number().int().positive(),
    toolCalls: z.number().int().positive().max(24),
    usd: z.number().nonnegative(),
  }),
});
export const SubmitQuestionResponse = z.strictObject({ runId: Uuid, workflowId: z.string() });

/** v1.4.0 (additive, read-only): the workspaces the signed-in user can open, for the sidebar switcher. */
export const WorkspaceListResponse = z.strictObject({
  workspaces: z.array(
    z.strictObject({
      id: Uuid,
      objective: z.string(),
      networkScope: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponse>;
