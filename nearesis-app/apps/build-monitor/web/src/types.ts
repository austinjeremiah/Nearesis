// Client-side view of GET /api/state (types only; the server is the source of truth).
export type Json = Record<string, unknown>;
export interface AgentRecordT {
  agentId: string;
  parentEngine: string;
  model: string;
  taskId: string;
  task: string;
  ownedPaths: string[];
  status: string;
  startedAt: string;
  heartbeatAt: string;
  testsPassed: number;
  testsFailed: number;
  blockerIds: string[];
  commitSha: string | null;
}
export interface AgentView {
  agentId: string;
  record: AgentRecordT | null;
  effectiveStatus: string;
  heartbeatAgeMs: number | null;
  valid: boolean;
  error?: string;
}
export interface EngineStatusT {
  engine: string;
  name: string;
  sessionId: string | null;
  initialized: boolean;
  model: string | null;
  currentTask: string | null;
  currentPhase: string | null;
  ownedModules: string[];
  activeSubagents: string[];
  completedTasks: string[];
  blockers: string[];
  heartbeatAt: string | null;
  lastCommit: string | null;
  latestTestResults: { passed: number; failed: number; blocked: number } | null;
}
export interface EngineView {
  state: string;
  status: EngineStatusT | null;
  heartbeatAgeMs: number | null;
  error?: string;
  lastCommit: { sha: string; source: string } | null;
}
export interface HistoryItem {
  runId: string;
  verdict: string;
  executedAt: string;
  commitSha: string;
  path: string;
}
export interface WaitingItem {
  kind: "BLOCKER" | "QUEUE";
  id: string;
  title: string;
  severity: string | null;
  owner: string | null;
  status: string;
  path: string | null;
  since: string;
  line?: number;
}
export interface TestView {
  testId: string;
  gate: string;
  name: string;
  passCondition: string;
  owner: string;
  required: boolean;
  supersededBy: string | null;
  latestCommit: string | null;
  staleEvidence: boolean;
  history: HistoryItem[];
  implemented: boolean;
  indexStatus: string;
  latestVerdict: string;
  latestRunId: string | null;
  executedAt: string | null;
  evidencePath: string | null;
}
export interface ReportItem {
  path: string;
  name: string;
  mtime: string;
  title?: string;
  status?: string;
}
export interface GateView {
  gate: string;
  passed: number;
  total: number;
  implemented: number;
  executed: number;
  failed: number;
  blocked: number;
  lockedBy: string[];
  verdict: string;
  upstream: string[];
}
export interface TaskT {
  id: string;
  title: string;
  phase: string;
  owner: string;
  status: string;
  dependsOn: string[];
  tests: string[];
}
export interface State {
  generatedAt: string;
  heartbeatTimeoutMs: number;
  engines: { A: EngineView; B: EngineView };
  agents: AgentView[];
  declaredAgents: { agentId: string; engine: string; taskId: string; hasRecord: boolean }[];
  limits: Record<"ENGINE_A" | "ENGINE_B", { active: number; max: number; breach: boolean }>;
  tasks: TaskT[];
  waiting: WaitingItem[];
  graph: {
    nodes: { id: string; title: string; status: string; layer: number; order: number; owner: string }[];
    edges: { from: string; to: string }[];
    layers: string[][];
    missingDeps: { task: string; dep: string }[];
  };
  events: { ts: string; session: string; engine: string; kind: string; subject: string; detail?: string }[];
  tests: TestView[];
  gates: GateView[];
  phases: { total: number; completed: number; current: string | null; blocked: string[] };
  counts: {
    required: number;
    passed: number;
    failed: number;
    blocked: number;
    notRun: number;
    implemented: number;
  };
  milestone: { passed: number; total: number; percent: number; basis: string };
  latestResults: { testId: string; runId: string; verdict: string; executedAt: string; observed: string }[];
  commits: { sha: string; author: string; date: string; subject: string }[];
  reports: Record<"phase" | "blockers" | "findings" | "decisions" | "tests" | "handoffs", ReportItem[]>;
  notes: string[];
  invalid: { path: string; error: string }[];
}
