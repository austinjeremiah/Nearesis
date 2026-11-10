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

export const SubmitQuestionRequest = z.strictObject({
  question: z.string().min(1).max(4000),
  snapshotPolicy: z.enum(["live", "pinned"]),
  budget: z.strictObject({
    tokens: z.number().int().positive(),
    toolCalls: z.number().int().positive().max(24),
    usd: z.number().nonnegative(),
  }),
});
export const SubmitQuestionResponse = z.strictObject({ runId: Uuid, workflowId: z.string() });
