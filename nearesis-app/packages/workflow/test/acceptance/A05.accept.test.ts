import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  PgAudit,
  Supervisor,
  hashOf,
  loadRoles,
  makePolicy,
  planFor,
  INVESTIGATION_GRANT,
} from "@nearesis/agent-runtime";
import { makeEnv, q, runInvestigation, seedBudget, startWorker, type Env } from "../helpers/harness.ts";

let env: Env;
beforeAll(async () => {
  env = await makeEnv();
}, 120_000);
afterAll(async () => env.stop());

it("A05: a child that exceeds its budget is blocked with a cost and audit record", async () => {
  const w = await startWorker(env);
  try {
    // 1. runtime overspend: reservation 200 tokens, scripted model spends 150 per turn
    const run = await runInvestigation(env, "A05-over", { workspaceId: randomUUID() });
    const res = await run.result();
    expect(res.state).toBe("BLOCKED");
    expect(res.failure?.reasonCode).toBe("BUDGET_EXCEEDED");
    expect(res.failure?.retryability).toBe("human_action_needed");
    const audit = await q<{ detail: Record<string, unknown>; task_id: string }>(
      env,
      run.tenantId,
      "SELECT detail, task_id FROM agent_audit WHERE run_id=$1 AND kind='budget.exceeded'",
      [run.runId],
    );
    expect(audit).toHaveLength(1);
    const d = audit[0]!.detail as {
      reserved: { tokens: number };
      spent: { tokens: number };
      attempted: { tokens: number; usd: number };
    };
    expect(d.reserved.tokens).toBe(200);
    expect(d.spent.tokens + d.attempted.tokens).toBeGreaterThan(200); // cost recorded in the audit row
    expect(d.attempted.usd).toBeGreaterThan(0);
    const charged = await q<{ tokens: string }>(
      env,
      run.tenantId,
      "SELECT COALESCE(sum(tokens),0)::text AS tokens FROM budget_ledger WHERE task_id=$1 AND kind='charge'",
      [audit[0]!.task_id],
    );
    expect(Number(charged[0]!.tokens)).toBeLessThanOrEqual(200); // the overage is never charged
    const net = await q<{ t: string; r: string }>(
      env,
      run.tenantId,
      "SELECT COALESCE(sum(CASE kind WHEN 'reserve' THEN tokens WHEN 'release' THEN -tokens ELSE 0 END),0)::text AS t, COALESCE(sum(CASE kind WHEN 'charge' THEN tokens ELSE 0 END),0)::text AS r FROM budget_ledger WHERE run_id=$1",
      [run.runId],
    );
    expect(Number(net[0]!.r)).toBeLessThanOrEqual(Number(net[0]!.t)); // charged <= net reserved
    const childTask = await q<{ status: string }>(env, run.tenantId, "SELECT status FROM tasks WHERE id=$1", [
      audit[0]!.task_id,
    ]);
    expect(childTask[0]!.status).toBe("FAILED");

    // 2. reserve refused at spawn: allowance smaller than the request
    const ws = randomUUID();
    const tiny = await seedBudget(env, env.tenantId, ws, randomUUID(), {
      tokens: 1000,
      toolCalls: 100,
      usd: 1,
    });
    const sup = new Supervisor(env.db.app, makePolicy(), new PgAudit(env.db.app), loadRoles());
    const runId = randomUUID();
    const root = await sup.createRootTask({
      tenantId: env.tenantId,
      workspaceId: ws,
      runId,
      investigationId: randomUUID(),
      budgetId: tiny,
      snapshotRef: "s",
      role: "director",
      capabilities: INVESTIGATION_GRANT,
      budget: { tokens: 500, toolCalls: 10, usd: 0.5 },
    });
    let code = "";
    await sup
      .spawn(
        {
          role: "quant",
          objective: "big",
          workspaceId: ws,
          allowedCapabilities: ["stats.read@1"],
          maxChildDepth: 0,
          budget: { tokens: 600, toolCalls: 1, usd: 0.1 },
        },
        {
          tenantId: env.tenantId,
          runId,
          budgetId: tiny,
          parent: { taskId: root.taskId, depth: 0, allowedCapabilities: INVESTIGATION_GRANT },
          dedupKey: {
            workspaceId: ws,
            investigationId: "i",
            task: "big",
            modelVersion: "m",
            inputSnapshot: "s",
          },
          hypothesisId: "h",
        },
      )
      .catch((e) => (code = e.reasonCode));
    expect(code).toBe("BUDGET_EXCEEDED");
    const refused = await q<{ detail: { requested: { tokens: number }; allowance: { tokens: number } } }>(
      env,
      env.tenantId,
      "SELECT detail FROM agent_audit WHERE workspace_id=$1 AND kind='spawn.rejected' AND reason_code='BUDGET_EXCEEDED'",
      [ws],
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail.requested.tokens).toBe(600);
    const tasks = await q(env, env.tenantId, "SELECT 1 FROM tasks WHERE workspace_id=$1 AND depth=1", [ws]);
    expect(tasks).toHaveLength(0); // never executed

    observe({
      testId: "A05",
      observed: `child reserved 200 tokens, scripted model spent 150/turn: 2nd charge refused with BUDGET_EXCEEDED, audit row has reserved=${d.reserved.tokens} spent=${d.spent.tokens} attempted=${d.attempted.tokens} tokens / usd ${d.attempted.usd}; charged ${charged[0]!.tokens} <= 200; child task FAILED; run ${res.state} (reason ${res.failure?.reasonCode}, ${res.failure?.retryability}); reserve refused at spawn for a 600-token request over a 500-token remainder (no task created, audit row with allowance)`,
      fixtureHash: hashOf(planFor("A05-over")),
      evidence: {
        auditDetail: d,
        charged: charged[0]!.tokens,
        runFailure: res.failure,
        spawnRefusal: refused[0]!.detail,
      },
    });
  } finally {
    await w.stop();
  }
}, 240_000);
