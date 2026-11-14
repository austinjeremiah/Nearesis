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
import {
  exportHistories,
  makeEnv,
  q,
  runInvestigation,
  seedBudget,
  startWorker,
  type Env,
} from "../helpers/harness.ts";

let env: Env;
beforeAll(async () => {
  env = await makeEnv();
}, 120_000);
afterAll(async () => env.stop());

const policy = { stageTimeboxMs: 2500, heartbeatTimeoutMs: 6000 };

async function sample(tenantId: string, workspaceId: string, stop: () => boolean) {
  let max = 0;
  let samples = 0;
  const series: Array<[number, number]> = [];
  const t0 = Date.now();
  while (!stop()) {
    const r = await q<{ n: string }>(
      env,
      tenantId,
      `SELECT count(*)::text AS n FROM tasks WHERE workspace_id=$1 AND depth>=1 AND status IN ('QUEUED','RUNNING','WAITING_APPROVAL')`,
      [workspaceId],
    );
    const n = Number(r[0]!.n);
    max = Math.max(max, n);
    samples++;
    if (series.at(-1)?.[1] !== n) series.push([Date.now() - t0, n]);
    await new Promise((res) => setTimeout(res, 20));
  }
  return { max, samples, series };
}

it("A12: depth, fan-out, tool-call and stage-timebox limits are enforced server-side", async () => {
  const w = await startWorker(env, { policy });
  try {
    // ---- (a)(b) spawn storm through the real workflow
    const storm = await runInvestigation(env, "A12-storm", { workspaceId: randomUUID() });
    let done = false;
    const sampling = sample(storm.tenantId, storm.workspaceId, () => done);
    const stormRes = await storm.result();
    done = true;
    const conc = await sampling;
    expect(conc.max).toBeLessThanOrEqual(6);
    expect(conc.max).toBeGreaterThanOrEqual(4); // the cap was actually pressed
    const maxDepth = await q<{ d: number }>(
      env,
      storm.tenantId,
      "SELECT max(depth) AS d FROM tasks WHERE run_id=$1",
      [storm.runId],
    );
    expect(maxDepth[0]!.d).toBeLessThanOrEqual(3);
    const rejects = await q<{ reason_code: string; n: string }>(
      env,
      storm.tenantId,
      "SELECT reason_code, count(*)::text AS n FROM agent_audit WHERE run_id=$1 AND kind='spawn.rejected' GROUP BY 1",
      [storm.runId],
    );
    const rej = Object.fromEntries(rejects.map((r) => [r.reason_code, Number(r.n)]));
    expect(rej.FANOUT_LIMIT ?? 0).toBeGreaterThanOrEqual(1);
    const queued = await q(
      env,
      storm.tenantId,
      "SELECT 1 FROM run_events WHERE run_id=$1 AND kind='spawn.queued'",
      [storm.runId],
    );
    const tree = await q(
      env,
      storm.tenantId,
      "SELECT depth, role, status FROM tasks WHERE run_id=$1 ORDER BY depth",
      [storm.runId],
    );
    await exportHistories(env, storm.workflowId, "a12-storm");

    // ---- (b)(e) supervisor-level: depth-4 spawn rejected, maxChildDepth clamped by server policy, caps from policy
    const ws = randomUUID();
    const budgetId = await seedBudget(env, env.tenantId, ws);
    const audit = new PgAudit(env.db.app);
    const sup = new Supervisor(env.db.app, makePolicy(), audit, loadRoles());
    const runId = randomUUID();
    const root = await sup.createRootTask({
      tenantId: env.tenantId,
      workspaceId: ws,
      runId,
      investigationId: randomUUID(),
      budgetId,
      snapshotRef: "s",
      role: "director",
      capabilities: INVESTIGATION_GRANT,
      budget: { tokens: 1000, toolCalls: 10, usd: 1 },
    });
    const req = (n: number, maxChildDepth = 10) => ({
      role: "director" as const,
      objective: `x${n}`,
      workspaceId: ws,
      allowedCapabilities: ["agent.spawn@1"],
      maxChildDepth,
      budget: { tokens: 10, toolCalls: 1, usd: 0.1 },
    });
    const ctx = (parent: { taskId: string; depth: number }, n: number) => ({
      tenantId: env.tenantId,
      runId,
      budgetId,
      parent: { ...parent, allowedCapabilities: INVESTIGATION_GRANT },
      dedupKey: {
        workspaceId: ws,
        investigationId: "i",
        task: `t${n}`,
        modelVersion: "m",
        inputSnapshot: "s",
      },
      hypothesisId: "h",
    });
    const c1 = await sup.spawn(req(1), ctx({ taskId: root.taskId, depth: 0 }, 1));
    const c2 = await sup.spawn(req(2), ctx({ taskId: c1.taskId, depth: 1 }, 2));
    const c3 = await sup.spawn(req(3), ctx({ taskId: c2.taskId, depth: 2 }, 3));
    expect(c3.depth).toBe(3);
    expect(c1.clampedMaxChildDepth).toBe(3); // request said 10
    let depthErr = "";
    await sup.spawn(req(4), ctx({ taskId: c3.taskId, depth: 3 }, 4)).catch((e) => (depthErr = e.reasonCode));
    expect(depthErr).toBe("DEPTH_LIMIT");
    const t4 = await q(env, env.tenantId, "SELECT 1 FROM tasks WHERE workspace_id=$1 AND depth>3", [ws]);
    expect(t4).toHaveLength(0);
    const clamp = await q(
      env,
      env.tenantId,
      "SELECT detail FROM agent_audit WHERE workspace_id=$1 AND kind='spawn.clamped'",
      [ws],
    );
    expect(clamp.length).toBeGreaterThanOrEqual(1);
    expect(() => makePolicy({ maxDepth: 10 })).toThrow(); // policy cannot be raised above ch.05 defaults
    // concurrent children never exceed 6 even under a burst of 12 simultaneous spawn calls
    const ws2 = randomUUID();
    const b2 = await seedBudget(env, env.tenantId, ws2);
    const runId2 = randomUUID();
    const root2 = await sup.createRootTask({
      tenantId: env.tenantId,
      workspaceId: ws2,
      runId: runId2,
      investigationId: randomUUID(),
      budgetId: b2,
      snapshotRef: "s",
      role: "director",
      capabilities: INVESTIGATION_GRANT,
      budget: { tokens: 1000, toolCalls: 10, usd: 1 },
    });
    const burst = await Promise.allSettled(
      Array.from({ length: 12 }, (_v, n) =>
        sup.spawn(
          { ...req(n), workspaceId: ws2 },
          {
            tenantId: env.tenantId,
            runId: runId2,
            budgetId: b2,
            parent: { taskId: root2.taskId, depth: 0, allowedCapabilities: INVESTIGATION_GRANT },
            dedupKey: {
              workspaceId: ws2,
              investigationId: "i",
              task: `b${n}`,
              modelVersion: "m",
              inputSnapshot: "s",
            },
            hypothesisId: "h",
          },
        ),
      ),
    );
    const okN = burst.filter((b) => b.status === "fulfilled").length;
    const fanErr = burst.filter(
      (b) => b.status === "rejected" && (b.reason as { reasonCode?: string }).reasonCode === "FANOUT_LIMIT",
    ).length;
    expect(okN).toBe(6);
    expect(fanErr).toBe(6);
    expect(await sup.activeChildren(env.tenantId, ws2)).toBe(6);

    // ---- (c) tool loop: call 25 rejected, run BLOCKED with reason
    const loop = await runInvestigation(env, "A12-toolloop", { workspaceId: randomUUID() });
    const loopRes = await loop.result();
    const calls = await q<{ n: string; mx: number }>(
      env,
      loop.tenantId,
      "SELECT count(*)::text AS n, max(n) AS mx FROM tool_call_log WHERE run_id=$1",
      [loop.runId],
    );
    const rej25 = await q<{ detail: { limit: number } }>(
      env,
      loop.tenantId,
      "SELECT detail FROM agent_audit WHERE run_id=$1 AND reason_code='TOOL_CALL_BUDGET'",
      [loop.runId],
    );
    const executed = await q<{ n: string }>(
      env,
      loop.tenantId,
      "SELECT count(*)::text AS n FROM agent_side_effects WHERE run_id=$1 AND kind='gw:stats.read@1'",
      [loop.runId],
    );
    expect(Number(calls[0]!.n)).toBe(24);
    expect(rej25.length).toBeGreaterThanOrEqual(1);
    expect(Number(executed[0]!.n)).toBe(24); // the 25th never reached the gateway
    expect(["BLOCKED", "PARTIAL"]).toContain(loopRes.state);
    expect(loopRes.failure?.reasonCode).toBe("TOOL_CALL_BUDGET");
    await exportHistories(env, loop.workflowId, "a12-toolloop");

    // ---- (d) slow stage cancelled at its timebox
    const t0 = Date.now();
    const slow = await runInvestigation(env, "A12-slow", { workspaceId: randomUUID() });
    const slowRes = await slow.result();
    const elapsed = Date.now() - t0;
    const slowAudit = await q(
      env,
      slow.tenantId,
      "SELECT detail FROM agent_audit WHERE run_id=$1 AND reason_code='STAGE_TIMEOUT'",
      [slow.runId],
    );
    expect(["BLOCKED", "PARTIAL"]).toContain(slowRes.state);
    expect(slowRes.failure?.reasonCode).toBe("STAGE_TIMEOUT");
    expect(slowAudit.length).toBeGreaterThanOrEqual(1);
    expect(elapsed).toBeLessThan(policy.stageTimeboxMs + 12_000);

    observe({
      testId: "A12",
      observed: `storm (10 children, recursive grandchildren): concurrent children max=${conc.max} over ${conc.samples} samples (cap 6), max task depth ${maxDepth[0]!.d}, rejections ${JSON.stringify(rej)}, ${queued.length} queued-spawn events, run ${stormRes.state}; supervisor: depth-4 spawn rejected DEPTH_LIMIT, maxChildDepth:10 clamped to 3, policy>defaults throws, burst of 12 -> 6 accepted/6 FANOUT_LIMIT; tool-loop: ${calls[0]!.n} calls accepted, #25 rejected TOOL_CALL_BUDGET, ${executed[0]!.n} gateway executions, run ${loopRes.state}; slow stage: STAGE_TIMEOUT at ${elapsed}ms (timebox ${policy.stageTimeboxMs}ms), run ${slowRes.state}`,
      fixtureHash: hashOf([planFor("A12-storm"), planFor("A12-toolloop"), planFor("A12-slow")]),
      evidence: {
        concurrency: { max: conc.max, samples: conc.samples, series: conc.series.slice(0, 200) },
        taskTree: tree,
        rejections: rej,
        loop: {
          accepted: Number(calls[0]!.n),
          maxN: calls[0]!.mx,
          state: loopRes.state,
          failure: loopRes.failure,
        },
        slow: { elapsedMs: elapsed, state: slowRes.state, failure: slowRes.failure },
        burst: { accepted: okN, fanoutRejected: fanErr },
      },
    });
  } finally {
    await w.stop();
  }
}, 300_000);
