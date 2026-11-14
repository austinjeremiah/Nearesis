import { groundingScan } from "./grounding.ts";
import type { RoleResult } from "./schemas.ts";
import type { EvidenceVerdict } from "./graphs/director.ts";
import { guardRoleOutput } from "./research-inference-wiring.ts";
import type { InferenceRecordLike, InferenceSummaryLike } from "./research-inference-guard.ts";

/**
 * Evidence review (ch.05 "Testable run outcomes"): each child needs a trace, a labelled artifact and grounded numbers.
 * Failed branches are named; a partially completed run states which branches failed.
 */
export function reviewEvidenceResults(
  results: RoleResult[],
  ctx: {
    runId: string;
    workspaceId: string;
    /** When set, any finding that asserts an unsupported significance claim fails its branch. */
    inference?: { summary: InferenceSummaryLike; inference?: InferenceRecordLike };
  },
): EvidenceVerdict {
  const failedBranches: EvidenceVerdict["failedBranches"] = [];
  const notes: string[] = [];
  for (const r of results) {
    const task = r.finding?.statement.slice(0, 40) ?? r.role;
    if (r.parentRunId !== ctx.runId || r.workspaceId !== ctx.workspaceId) {
      failedBranches.push({ task, role: r.role, reasonCode: "TRACE_MISSING" });
      continue;
    }
    if (r.status === "failed") {
      failedBranches.push({ task, role: r.role, reasonCode: r.reasonCode ?? "FAILED" });
      continue;
    }
    if (!r.artifact?.label) {
      failedBranches.push({ task, role: r.role, reasonCode: "ARTIFACT_UNLABELLED" });
      continue;
    }
    if (r.finding) {
      const scan = groundingScan(r.finding.statement, r.finding.facts);
      if (!scan.clean) failedBranches.push({ task, role: r.role, reasonCode: "UNGROUNDED_NUMBER" });
      if (
        ctx.inference &&
        guardRoleOutput(r.role, r.finding.statement, r.finding.limitations, ctx.inference).violations.length >
          0
      )
        failedBranches.push({ task, role: r.role, reasonCode: "INFERENCE_CLAIM_UNSUPPORTED" });
      if (r.finding.status === "cannot_compute")
        notes.push(`${r.role} abstained: ${r.artifact.missingMetric ?? "unknown metric"}`);
    }
  }
  const abstained = results.some((r) => r.finding?.status === "cannot_compute");
  let outcome: EvidenceVerdict["outcome"] = "COMPLETE";
  if (results.length > 0 && failedBranches.length === results.length) outcome = "BLOCKED";
  else if (failedBranches.length > 0 || abstained) outcome = "PARTIAL";
  return { outcome, failedBranches, notes };
}
