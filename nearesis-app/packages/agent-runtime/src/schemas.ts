import { z } from "zod";
import { AgentRole, CapabilityId, ResearchFinding } from "@nearesis/contracts";

export const BudgetSchema = z.strictObject({
  tokens: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});

export const PlannedChild = z.strictObject({
  /** The `task` element of the ch.05 dedup identity. */
  task: z.string().min(1).max(500),
  role: AgentRole,
  objective: z.string().min(1).max(4000),
  capabilities: z.array(CapabilityId).max(32),
  /** The `inputSnapshot` element of the dedup identity. */
  inputSnapshot: z.string().min(1).max(500),
  budget: BudgetSchema,
  maxChildDepth: z.number().int().nonnegative().default(1),
});
export type PlannedChild = z.infer<typeof PlannedChild>;

export const PrivilegedAction = z.strictObject({
  kind: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  network: z.string().min(1),
  costLimit: z.number().nonnegative(),
});
export type PrivilegedAction = z.infer<typeof PrivilegedAction>;

/** plan.json (director expected artifact). */
export const Plan = z.strictObject({
  question: z.string().min(1),
  modelVersion: z.string().min(1),
  requiredMetrics: z.array(z.string().min(1)).max(50),
  /** Stages run in order; children within a stage run in parallel. */
  stages: z.array(z.array(PlannedChild).min(1).max(12)).min(1).max(6),
  privilegedAction: PrivilegedAction.nullable(),
  needsHumanInput: z.boolean().default(false),
  estimatedCost: BudgetSchema,
});
export type Plan = z.infer<typeof Plan>;

/** One model turn of a role worker. */
const PlannedChildBase = PlannedChild;
export const Decision = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("tool"), tool: z.string().min(1).max(200), input: z.unknown() }),
  z.strictObject({
    action: z.literal("finish"),
    status: ResearchFinding.shape.status,
    statement: z.string().min(1).max(8000),
    facts: z
      .array(
        z.strictObject({
          value: z.string(),
          unit: z.string(),
          /** index into this task's tool log whose result the value was read from */
          sourceStep: z.number().int().nonnegative(),
          column: z.string(),
        }),
      )
      .max(200),
    limitations: z.array(z.string()).max(50),
    /** For cannot_compute: the missing metric and the minimal next measurement/permission. */
    missingMetric: z.string().optional(),
    nextMeasurement: z.string().optional(),
    /** Delegation requests (director-role agents only; validated server-side by the supervisor). */
    spawn: z.array(PlannedChildBase).max(12).default([]),
  }),
  z.strictObject({ action: z.literal("abort"), reasonCode: z.string().min(1), message: z.string().min(1) }),
]);
export type Decision = z.infer<typeof Decision>;

export const ToolLogEntry = z.strictObject({
  step: z.number().int().nonnegative(),
  tool: z.string(),
  ok: z.boolean(),
  reasonCode: z.string().nullable(),
  resultHash: z.string().nullable(),
});
export type ToolLogEntry = z.infer<typeof ToolLogEntry>;

/** Labelled child artifact (ch.05 testable run outcomes). */
export const RoleResult = z.strictObject({
  taskId: z.string(),
  role: AgentRole,
  status: z.enum(["finished", "failed"]),
  reasonCode: z.string().nullable(),
  message: z.string().nullable(),
  finding: ResearchFinding.nullable(),
  artifact: z.strictObject({
    type: z.string(),
    label: z.enum(["unattested_dev", "fixture_synthetic"]),
    sha256: z.string(),
    missingMetric: z.string().nullable(),
    nextMeasurement: z.string().nullable(),
  }),
  toolLog: z.array(ToolLogEntry),
  /** Parsed tool envelope hashes: one per ok tool call. */
  parentRunId: z.string(),
  workspaceId: z.string(),
  spawnRequests: z.array(PlannedChild).default([]),
});
export type RoleResult = z.infer<typeof RoleResult>;
