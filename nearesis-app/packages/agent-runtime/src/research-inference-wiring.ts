import { AgentRuntimeError } from "./errors.ts";
import {
  checkStateNotUpgraded,
  composerInferenceLine,
  scanSignificanceClaims,
  skepticInferenceObjections,
  type ComparisonState,
  type GuardViolation,
  type InferenceRecordLike,
  type InferenceSummaryLike,
} from "./research-inference-guard.ts";

/**
 * Wiring of the research inference guards (Amendment 002) into the role, review and adversarial graphs. A graph that is
 * given a `ResearchInferenceContext` can no longer turn an invalid or unsupported comparison into a significance claim:
 * every role's statement is scanned, and the Auditor, Skeptic and Composer add their role-specific checks.
 */
export interface ResearchInferenceContext {
  summary: InferenceSummaryLike;
  /** The per-comparison inference record the draft is about (Composer state check and verbatim line). */
  inference?: InferenceRecordLike;
}

const STATES: readonly ComparisonState[] = [
  "evidence_supports_difference",
  "insufficient_to_distinguish",
  "comparison_method_not_validated",
  "comparison_invalid_input",
];

export interface GuardedOutput {
  limitations: string[];
  violations: GuardViolation[];
}

/** Pure: the guard decision for one role output. `violations` non-empty means the output must not be published. */
export function guardRoleOutput(
  role: string,
  statement: string,
  limitations: readonly string[],
  ctx: ResearchInferenceContext,
): GuardedOutput {
  const text = [statement, ...limitations].join(" ");
  const violations = [...scanSignificanceClaims(text, ctx.summary)];
  const out = [...limitations];
  const add = (l: string): void => {
    if (!out.includes(l)) out.push(l);
  };
  if (role === "skeptic") {
    for (const o of skepticInferenceObjections(ctx.summary, ctx.inference?.status)) add(o);
  }
  if (role === "composer" && ctx.inference) {
    const line = composerInferenceLine(ctx.inference);
    add(line.text);
    for (const l of line.limitations) add(l);
    for (const s of STATES)
      if (statement.includes(s)) violations.push(...checkStateNotUpgraded(s, ctx.inference));
  }
  return { limitations: out, violations };
}

export function assertGuardedRoleOutput(
  role: string,
  taskId: string,
  statement: string,
  limitations: readonly string[],
  ctx: ResearchInferenceContext,
): string[] {
  const g = guardRoleOutput(role, statement, limitations, ctx);
  if (g.violations.length > 0)
    throw new AgentRuntimeError("INFERENCE_CLAIM_GUARD", "output asserts an unsupported inference claim", {
      taskId,
      role,
      violations: g.violations,
    });
  return g.limitations;
}
