import { afterAll, beforeAll, expect, it } from "vitest";
import { validatorActorId } from "@nearesis/agent-runtime";
import { observe } from "@nearesis/acceptance";
import { hashOf, planFor } from "@nearesis/agent-runtime";
import { makeEnv, q, runInvestigation, startWorker, type Env } from "../helpers/harness.ts";

let env: Env;
beforeAll(async () => {
  env = await makeEnv();
}, 120_000);
afterAll(async () => env.stop());

it("A01: four role subagents are all traceable to the parent run and workspace", async () => {
  const w = await startWorker(env);
  try {
    const run = await runInvestigation(env, "A01");
    const res = await run.result();
    expect(res.state).toBe("COMPLETE");
    const tasks = await q<{
      id: string;
      parent_task_id: string | null;
      run_id: string;
      workspace_id: string;
      role: string;
      depth: number;
      result: {
        result: {
          parentRunId: string;
          workspaceId: string;
          taskId: string;
          role: string;
          toolLog: unknown[];
        };
      } | null;
    }>(
      env,
      run.tenantId,
      "SELECT id, parent_task_id, run_id, workspace_id, role, depth, result FROM tasks WHERE run_id=$1 ORDER BY depth, role",
      [run.runId],
    );
    const root = tasks.find((t) => t.depth === 0)!;
    const kids = tasks.filter((t) => t.depth === 1);
    expect(kids.map((k) => k.role).sort()).toEqual(["composer", "quant", "semantic_analyst", "skeptic"]);
    for (const k of kids) {
      expect(k.parent_task_id).toBe(root.id);
      expect(k.run_id).toBe(run.runId);
      expect(k.workspace_id).toBe(run.workspaceId);
      expect(k.result!.result.parentRunId).toBe(run.runId); // artifact trace
      expect(k.result!.result.workspaceId).toBe(run.workspaceId);
      expect(k.result!.result.taskId).toBe(k.id);
      expect(k.result!.result.toolLog.length).toBeGreaterThan(0);
    }
    // every gateway call is attributable to one of the four tasks, this run and this workspace
    const gw = await q<{ task_id: string; run_id: string; workspace_id: string }>(
      env,
      run.tenantId,
      "SELECT task_id, run_id, workspace_id FROM agent_audit WHERE kind='gateway.executed' AND run_id=$1",
      [run.runId],
    );
    expect(gw.length).toBeGreaterThanOrEqual(4);
    // plan-validation discover runs as the run's semantic_analyst validator principal (FND-20261110-030), a lease-derived agent of this run
    const ids = new Set([root.id, ...kids.map((k) => k.id), validatorActorId(run.runId)]);
    for (const g of gw) {
      expect(ids.has(g.task_id)).toBe(true);
      expect(g.workspace_id).toBe(run.workspaceId);
    }
    const covered = new Set(
      gw.map((g) => g.task_id).filter((id) => id !== root.id && id !== validatorActorId(run.runId)),
    );
    expect(covered.size).toBe(4);
    observe({
      testId: "A01",
      observed: `director spawned 4 role subagents (${kids.map((k) => k.role).join(", ")}): each task row has parent_task_id=director task, run_id=${run.runId.slice(0, 8)}, workspace_id matching; each artifact carries parentRunId/workspaceId/taskId; ${gw.length} gateway executions attributed to 4 distinct task ids with run and workspace; run ${res.state}`,
      fixtureHash: hashOf(planFor("A01")),
      evidence: {
        tasks: tasks.map((t) => ({
          id: t.id,
          parent: t.parent_task_id,
          role: t.role,
          depth: t.depth,
          run: t.run_id,
          workspace: t.workspace_id,
        })),
        gatewayExecutionsByTask: [...covered],
      },
    });
  } finally {
    await w.stop();
  }
}, 240_000);
