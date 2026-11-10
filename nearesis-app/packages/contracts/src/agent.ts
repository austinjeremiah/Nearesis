import { z } from "zod";
import { IsoDateTime, Uuid } from "./common.ts";
import { CapabilityId } from "./plugin.ts";

/** ch.05 roles (A11). */
export const AgentRole = z.enum([
  "director",
  "semantic_analyst",
  "data_scout",
  "quant",
  "skeptic",
  "economics",
  "composer",
  "monitoring",
  "auditor",
  "publisher",
]);
export type AgentRole = z.infer<typeof AgentRole>;

export const RunState = z.enum([
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
export type RunState = z.infer<typeof RunState>;

/** ch.05 state machine. */
export const RUN_TRANSITIONS: Record<RunState, RunState[]> = {
  REQUESTED: ["PLANNING", "CANCELLED"],
  PLANNING: ["APPROVAL_NEEDED", "EXECUTING", "BLOCKED", "PARTIAL", "CANCELLED"],
  APPROVAL_NEEDED: ["EXECUTING", "BLOCKED", "CANCELLED"],
  EXECUTING: ["EVIDENCE_REVIEW", "APPROVAL_NEEDED", "PARTIAL", "BLOCKED", "CANCELLED"],
  EVIDENCE_REVIEW: ["CANVAS_PATCH_REVIEW", "COMPLETE", "PARTIAL", "BLOCKED", "CANCELLED"],
  CANVAS_PATCH_REVIEW: ["COMPLETE", "PARTIAL", "BLOCKED", "CANCELLED"],
  COMPLETE: [],
  PARTIAL: [],
  BLOCKED: [],
  CANCELLED: [],
};

export const SpawnRequest = z.strictObject({
  role: AgentRole,
  objective: z.string().min(1).max(4000),
  workspaceId: Uuid,
  allowedCapabilities: z.array(CapabilityId).max(32),
  maxChildDepth: z.number().int().nonnegative(),
  budget: z.strictObject({
    tokens: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
  }),
});

export const AgentTask = z.strictObject({
  id: Uuid,
  runId: Uuid,
  parentTaskId: Uuid.nullable(),
  workspaceId: Uuid,
  role: AgentRole,
  depth: z.number().int().min(0).max(3),
  /** ch.05 dedup identity (A18). */
  dedupKey: z.strictObject({
    workspaceId: Uuid,
    investigationId: Uuid,
    task: z.string(),
    modelVersion: z.string(),
    inputSnapshot: z.string(),
  }),
  status: z.enum(["QUEUED", "RUNNING", "WAITING_APPROVAL", "DONE", "FAILED", "CANCELLED"]),
  outputRef: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type AgentTask = z.infer<typeof AgentTask>;

/** ch.05 "Testable run outcomes" structured failure. */
export const RunFailure = z.strictObject({
  reasonCode: z.string().min(1),
  retryability: z.enum(["retryable", "not_retryable", "human_action_needed"]),
  humanActionNeeded: z.string().nullable(),
  lastCheckpoint: z.string().nullable(),
  replayCommand: z.string().min(1),
});
export type RunFailure = z.infer<typeof RunFailure>;
