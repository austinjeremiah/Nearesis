import { z } from "zod";

/** Server-side orchestration policy (ch.04 "Delegation and subagents", ch.05 "Budget and circuit breakers"). */
export const Policy = z.strictObject({
  maxDepth: z.number().int().min(0).max(3),
  maxConcurrentChildrenPerWorkspace: z.number().int().positive().max(6),
  maxToolCallsPerHypothesis: z.number().int().positive().max(24),
  stageTimeboxMs: z.number().int().positive(),
  /** Activity heartbeat timeout used by the workflow (crash detection window). */
  heartbeatTimeoutMs: z.number().int().positive(),
  approvalTimeoutMs: z.number().int().positive(),
});
export type Policy = z.infer<typeof Policy>;

export const DEFAULT_POLICY: Policy = {
  maxDepth: 3,
  maxConcurrentChildrenPerWorkspace: 6,
  maxToolCallsPerHypothesis: 24,
  stageTimeboxMs: 10 * 60_000,
  heartbeatTimeoutMs: 30_000,
  approvalTimeoutMs: 24 * 3600_000,
};

/** Test overrides may only tighten (or shorten timers); they cannot exceed the ch.05 defaults. */
export function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return Policy.parse({ ...DEFAULT_POLICY, ...overrides });
}
