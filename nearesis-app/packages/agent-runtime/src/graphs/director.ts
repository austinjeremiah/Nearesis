import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { AgentRuntimeError } from "../errors.ts";
import type { LedgerInference } from "../inference.ts";
import type { RoleConfig } from "../roles.ts";
import { Plan, type PlannedChild, type RoleResult } from "../schemas.ts";
import type { AgentRole } from "@nearesis/contracts";

export interface PlanValidation {
  ok: boolean;
  problems: string[];
  /** Metrics the semantic catalog reported as missing. NOT a rejection: the semantic analyst must produce the cannot_compute artifact (ch.27). */
  missingMetrics: string[];
}

export interface EvidenceVerdict {
  outcome: "COMPLETE" | "PARTIAL" | "BLOCKED";
  failedBranches: Array<{ task: string; role: string; reasonCode: string }>;
  notes: string[];
}

export interface DirectorDeps {
  question: string;
  taskId: string;
  roles: Map<AgentRole, RoleConfig>;
  inference: LedgerInference;
  /** Kernel-brokered metric coverage check (semantic.discover as a service principal; counted once per key). */
  discoverMetrics: (metrics: string[], key: string) => Promise<{ available: string[]; missing: string[] }>;
  /** Parallel children of one stage. In Temporal this is done by the workflow; unit/A14 tests inject a stub. */
  runStage?: (children: PlannedChild[], stageIdx: number) => Promise<RoleResult[]>;
  review?: (results: RoleResult[]) => Promise<EvidenceVerdict>;
  heartbeat?: () => void;
  checkpointer?: BaseCheckpointSaver;
  /** "plan": plan -> validate_plan -> human_input -> END.  "full": continues spawn -> collect -> evidence_review. */
  mode: "plan" | "full";
}

/** ch.27: once a branch abstains (cannot_compute) the director stops spawning. */
export const shouldStopSpawning = (results: RoleResult[]): boolean =>
  results.some((r) => r.finding?.status === "cannot_compute");

const S = Annotation.Root({
  plan: Annotation<Plan | null>({ reducer: (_a, b) => b, default: () => null }),
  validation: Annotation<PlanValidation | null>({ reducer: (_a, b) => b, default: () => null }),
  humanInput: Annotation<string | null>({ reducer: (_a, b) => b, default: () => null }),
  stageIdx: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  results: Annotation<RoleResult[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  spawned: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  abstained: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
  verdict: Annotation<EvidenceVerdict | null>({ reducer: (_a, b) => b, default: () => null }),
});

export function validatePlanStructure(plan: Plan, roles: Map<AgentRole, RoleConfig>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [i, stage] of plan.stages.entries())
    for (const ch of stage) {
      const cfg = roles.get(ch.role);
      if (!cfg) problems.push(`unknown role ${ch.role}`);
      for (const c of ch.capabilities)
        if (cfg && !cfg.allowedTools.includes(c))
          problems.push(`stage ${i} ${ch.role}: ${c} exceeds role allowlist`);
      const k = `${ch.task}|${ch.inputSnapshot}`;
      if (seen.has(k)) continue; // identical identities are legal; the workflow dedups them (A18)
      seen.add(k);
    }
  return problems;
}

export function buildDirectorGraph(d: DirectorDeps) {
  const plan = async (_s: typeof S.State) => {
    d.heartbeat?.();
    const out = await d.inference.generate({
      key: `${d.taskId}:plan`,
      system: d.roles.get("director")!.systemPrompt,
      prompt: `[role=director] [phase=plan]\nQuestion: ${d.question}`,
      schema: Plan,
    });
    return { plan: out };
  };

  const validate = async (s: typeof S.State) => {
    const p = s.plan!;
    const problems = validatePlanStructure(p, d.roles);
    const cov = await d.discoverMetrics(p.requiredMetrics, `${d.taskId}:discover`);
    const validation: PlanValidation = { ok: problems.length === 0, problems, missingMetrics: cov.missing };
    if (!validation.ok)
      throw new AgentRuntimeError("CAPABILITY_ESCALATION", `plan invalid: ${problems.join("; ")}`, {
        problems,
      });
    return { validation };
  };

  // Separate node so a resume after the interrupt never repeats the tool call made in validate_plan.
  const humanInput = async (s: typeof S.State) => {
    if (!s.plan?.needsHumanInput) return { humanInput: null };
    const answer = interrupt({ question: "Plan needs human input", planHash: d.taskId }) as string;
    return { humanInput: answer };
  };

  const afterHuman = (): "spawn" | typeof END => (d.mode === "plan" ? END : "spawn");

  const spawn = async (s: typeof S.State) => {
    d.heartbeat?.();
    if (!d.runStage) throw new Error("runStage not provided");
    const children = s.plan!.stages[s.stageIdx]!;
    const results = await d.runStage(children, s.stageIdx);
    return {
      results,
      spawned: s.spawned + children.length,
      stageIdx: s.stageIdx + 1,
      abstained: s.abstained || shouldStopSpawning(results),
    };
  };
  const next = (s: typeof S.State): "spawn" | "evidence_review" =>
    !s.abstained && s.stageIdx < s.plan!.stages.length ? "spawn" : "evidence_review";

  const review = async (s: typeof S.State) => {
    if (!d.review) throw new Error("review not provided");
    return { verdict: await d.review(s.results) };
  };

  return new StateGraph(S)
    .addNode("make_plan", plan)
    .addNode("validate_plan", validate)
    .addNode("human_input", humanInput)
    .addNode("spawn", spawn)
    .addNode("evidence_review", review)
    .addEdge(START, "make_plan")
    .addEdge("make_plan", "validate_plan")
    .addEdge("validate_plan", "human_input")
    .addConditionalEdges("human_input", afterHuman, { spawn: "spawn", [END]: END })
    .addConditionalEdges("spawn", next, { spawn: "spawn", evidence_review: "evidence_review" })
    .addEdge("evidence_review", END)
    .compile(d.checkpointer ? { checkpointer: d.checkpointer } : {});
}

export type DirectorState = typeof S.State;
export { Command };
export const PlanSchema = Plan;
