import { z } from "zod";
import { IsoDateTime } from "./common.ts";

/** Build-monitor status records (directive §6). Heartbeat timeout defines STALE. */
export const HEARTBEAT_TIMEOUT_MS = 10 * 60_000;

export const EngineId = z.enum(["ENGINE_A", "ENGINE_B"]);
export const AgentStatus = z.enum(["QUEUED", "RUNNING", "BLOCKED", "WAITING", "DONE", "FAILED", "STALE"]);

export const AgentRecord = z.strictObject({
  agentId: z.string().min(1),
  parentEngine: EngineId,
  model: z.string().min(1),
  taskId: z.string().min(1),
  task: z.string().min(1),
  ownedPaths: z.array(z.string()),
  status: AgentStatus,
  startedAt: IsoDateTime,
  heartbeatAt: IsoDateTime,
  testsPassed: z.number().int().nonnegative(),
  testsFailed: z.number().int().nonnegative(),
  blockerIds: z.array(z.string()),
  commitSha: z.string().nullable(),
});
export type AgentRecord = z.infer<typeof AgentRecord>;

export const EngineStatus = z.strictObject({
  engine: EngineId,
  name: z.string(),
  sessionId: z.string().nullable(),
  initialized: z.boolean(),
  model: z.string().nullable(),
  currentTask: z.string().nullable(),
  currentPhase: z.string().nullable(),
  ownedModules: z.array(z.string()),
  activeSubagents: z.array(z.string()),
  completedTasks: z.array(z.string()),
  blockers: z.array(z.string()),
  heartbeatAt: IsoDateTime.nullable(),
  lastCommit: z.string().nullable(),
  latestTestResults: z
    .strictObject({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      blocked: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type EngineStatus = z.infer<typeof EngineStatus>;

export const TaskStatus = z.enum([
  "READY",
  "RUNNING",
  "WAITING_INTERFACE",
  "WAITING_TESTS",
  "WAITING_CREDENTIALS",
  "BLOCKED",
  "DONE",
]);
export const BoardTask = z.strictObject({
  id: z.string().regex(/^T-[A-Z0-9-]+$/),
  title: z.string(),
  phase: z.enum(["P00", "P01", "P02", "P03", "P04", "P05", "INT"]),
  owner: z.string(),
  status: TaskStatus,
  dependsOn: z.array(z.string()),
  tests: z.array(z.string()),
});
export const TaskBoard = z.strictObject({
  version: z.number().int().positive(),
  updatedAt: IsoDateTime,
  tasks: z.array(BoardTask),
});
export type TaskBoard = z.infer<typeof TaskBoard>;

export const CoordinationEventKind = z.enum([
  "agent.started",
  "agent.stopped",
  "subagent.spawned",
  "task.assigned",
  "task.completed",
  "test.started",
  "test.passed",
  "test.failed",
  "test.blocked",
  "finding.recorded",
  "blocker.recorded",
  "commit.created",
  "gate.passed",
  "gate.failed",
  "heartbeat",
]);
export const CoordinationEvent = z.strictObject({
  ts: IsoDateTime,
  session: z.string().min(1),
  engine: EngineId,
  kind: CoordinationEventKind,
  subject: z.string().min(1),
  detail: z.string().max(2000).optional(),
});
export type CoordinationEvent = z.infer<typeof CoordinationEvent>;

/** ch.16 PASS evidence per test (templates/TEST_RESULT.json). */
export const TestVerdict = z.enum(["PASS", "FAIL", "BLOCKED_DEPENDENCY", "NOT_RUN"]);
export const TestResult = z.strictObject({
  testId: z.string().regex(/^(BOOT|K|D|S|A|C)\d{2}$/),
  phase: z.string(),
  runId: z.string().min(1),
  executedAt: IsoDateTime,
  command: z.string().min(1),
  fixtureHash: z.string().nullable(),
  commitSha: z.string().regex(/^[0-9a-f]{7,40}$/),
  runtimeVersions: z.record(z.string(), z.string()),
  environment: z.string().min(1),
  expected: z.string().min(1),
  observed: z.string().min(1),
  verdict: TestVerdict,
  evidenceRefs: z.array(z.string()),
  failureReason: z.string().nullable(),
});
export type TestResult = z.infer<typeof TestResult>;
export type EngineId = z.infer<typeof EngineId>;
export type AgentStatus = z.infer<typeof AgentStatus>;
export type TaskStatus = z.infer<typeof TaskStatus>;
export type TestVerdict = z.infer<typeof TestVerdict>;
