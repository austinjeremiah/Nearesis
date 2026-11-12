import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  loadRoles,
  reviewEvidenceResults,
  runAdversarial,
  runRoleTask,
  type AdversarialPort,
  type AgentToolClient,
  type InferenceRecordLike,
  type InferenceSummaryLike,
  type LedgerInference,
  type ResearchInferenceContext,
  type RoleResult,
} from "../src/index.ts";
import type { AgentRole } from "@nearesis/contracts";

const notSupported: InferenceSummaryLike = {
  primaryStatisticalClaim: "not_supported",
  comparisons: {
    "1:intents": {
      status: "METHOD_NOT_VALIDATED",
      nested: true,
      significanceClaimAllowed: false,
      conclusion: "comparison_method_not_validated",
    },
  },
};
const record: InferenceRecordLike = {
  status: "METHOD_NOT_VALIDATED",
  significance_claim_allowed: false,
  conclusion: { state: "comparison_method_not_validated", observed_candidate_lower_error: true },
  agreement: "disagree",
};
const ctx: ResearchInferenceContext = { summary: notSupported, inference: record };
const roles = loadRoles();

const run = (
  role: AgentRole,
  statement: string,
  limitations: string[] = [],
  c: ResearchInferenceContext = ctx,
) =>
  runRoleTask({
    tenantId: randomUUID(),
    workspaceId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
    role,
    roleCfg: roles.get(role)!,
    hypothesisId: "h",
    objective: "compare",
    tools: {} as AgentToolClient,
    inference: {
      generate: async () => ({
        action: "finish",
        status: "supported",
        statement,
        facts: [],
        limitations,
        spawn: [],
      }),
    } as unknown as LedgerInference,
    now: () => 0,
    stageDeadlineAt: 1000,
    inferenceGuard: c,
  });

const CLAIM = "The intents model is statistically significant against the baseline.";

for (const role of ["auditor", "skeptic", "composer"] as const) {
  it(`${role}: a significance claim over an unsupported inference is refused`, async () => {
    await expect(run(role, CLAIM)).rejects.toMatchObject({
      reasonCode: "INFERENCE_CLAIM_GUARD",
      detail: { role },
    });
  });
  it(`${role}: neutral wording passes`, async () => {
    const r = await run(role, "The candidate had a lower observed error; significance is not established.");
    expect(r.status).toBe("finished");
  });
}

it("skeptic: the not-supported and nested-model objections are added to the finding", async () => {
  const r = await run("skeptic", "No significant difference established between the models.");
  const l = r.finding!.limitations.join(" | ");
  expect(l).toContain("statistical significance not established");
  expect(l).toContain("nested-model comparison");
});

it("composer: carries the state and status verbatim and the disagreement limitation, and cannot upgrade the state", async () => {
  const r = await run("composer", "The comparison is neutral.");
  const l = r.finding!.limitations;
  expect(l).toContain(
    "comparison state comparison_method_not_validated; inference status METHOD_NOT_VALIDATED",
  );
  expect(l.some((x) => x.includes("disagree"))).toBe(true);
  await expect(run("composer", "The state is evidence_supports_difference.")).rejects.toMatchObject({
    reasonCode: "INFERENCE_CLAIM_GUARD",
  });
});

it("a supported primary claim lets significance wording through (guard never blocks valid inference)", async () => {
  const r = await run("auditor", CLAIM, [], { summary: { primaryStatisticalClaim: "supported" } });
  expect(r.status).toBe("finished");
});

it("without a guard context nothing changes (additive)", async () => {
  const r = await runRoleTask({
    tenantId: randomUUID(),
    workspaceId: randomUUID(),
    runId: randomUUID(),
    taskId: randomUUID(),
    role: "auditor",
    roleCfg: roles.get("auditor")!,
    hypothesisId: "h",
    objective: "x",
    tools: {} as AgentToolClient,
    inference: {
      generate: async () => ({
        action: "finish",
        status: "supported",
        statement: CLAIM,
        facts: [],
        limitations: [],
        spawn: [],
      }),
    } as unknown as LedgerInference,
    now: () => 0,
    stageDeadlineAt: 1000,
  });
  expect(r.finding!.statement).toBe(CLAIM);
});

it("review fails the branch of any role whose finding asserts unsupported significance", () => {
  const mk = (role: AgentRole, statement: string): RoleResult => ({
    taskId: randomUUID(),
    role,
    status: "finished",
    reasonCode: null,
    message: null,
    finding: {
      id: randomUUID(),
      workspaceId: "w",
      runId: "r",
      agentRole: role,
      status: "supported",
      statement,
      facts: [],
      limitations: [],
      createdAt: "2026-11-12T00:00:00.000Z",
    } as RoleResult["finding"],
    artifact: { type: "t", label: "unattested_dev", sha256: "x", missingMetric: null, nextMeasurement: null },
    toolLog: [],
    parentRunId: "r",
    workspaceId: "w",
    spawnRequests: [],
  });
  const results = ["auditor", "skeptic", "composer"].map((r) => mk(r as AgentRole, CLAIM));
  const v = reviewEvidenceResults(results, { runId: "r", workspaceId: "w", inference: ctx });
  expect(v.failedBranches.map((f) => f.reasonCode)).toEqual(Array(3).fill("INFERENCE_CLAIM_UNSUPPORTED"));
  expect(v.outcome).toBe("BLOCKED");
  expect(reviewEvidenceResults(results, { runId: "r", workspaceId: "w" }).failedBranches).toEqual([]);
});

it("adversarial graph drops branch arguments that assert unsupported significance before adjudication", async () => {
  let seen: unknown = null;
  const port: AdversarialPort = {
    protocol: async (req) => {
      seen = req.branchArgs;
      const h = "h";
      return {
        branchInputHashes: { bull: { snapshot: h, catalog: h }, bear: { snapshot: h, catalog: h } },
        inputsEqual: true,
        rejected: [],
        audit: [],
        adjudication: { outcome: "x", status: "INSUFFICIENT_DATA" },
        preregistrationHashBefore: h,
        preregistrationHashAfter: h,
        adjudicationHash: h,
        secondRunHash: h,
        engineVerdict: { status: "INSUFFICIENT_DATA", evidenceStrength: "none" },
        maxArguments: 3,
        frozenIntact: true,
      };
    },
  };
  const out = {
    stance: "SUPPORTED",
    arguments: [{ claim: CLAIM }, { claim: "Observed lower error, no significance claimed." }],
  };
  const res = await runAdversarial({
    inference: { generate: async () => out } as unknown as LedgerInference,
    port,
    taskId: "t",
    snapshotManifest: {},
    metricCatalog: {},
    results: {},
    inferenceSummary: notSupported,
  });
  expect((seen as { bull: unknown[] }).bull).toEqual([
    { claim: "Observed lower error, no significance claimed." },
  ]);
  expect(res.guardRejections).toHaveLength(2); // one per branch
  expect(res.guardRejections![0]!.rule).toBe("significance_claim_without_valid_inference");
});
