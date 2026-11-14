import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { hashOf, planFor } from "@nearesis/agent-runtime";
import { childWorkflowId } from "../../src/index.ts";
import { exportHistories, makeEnv, q, runInvestigation, startWorker, type Env } from "../helpers/harness.ts";

let env: Env;
beforeAll(async () => {
  env = await makeEnv();
}, 120_000);
afterAll(async () => env.stop());

it("A18: duplicate spawn of the same child identity yields exactly one child execution", async () => {
  const w = await startWorker(env);
  try {
    const run = await runInvestigation(env, "A18");
    const res = await run.result();
    expect(res.state).toBe("COMPLETE");

    const tasks = await q<{
      id: string;
      dedup_hash: string;
      depth: number;
      dedup_key: Record<string, string>;
      status: string;
    }>(
      env,
      run.tenantId,
      "SELECT id, dedup_hash, depth, dedup_key, status FROM tasks WHERE run_id=$1 AND depth=1 ORDER BY dedup_hash",
      [run.runId],
    );
    // (e) tasks rows: 2 distinct identities, unique constraint enforced
    expect(tasks).toHaveLength(2);
    const dupInsert = await q(env, run.tenantId, "SELECT 1", []).then(async () => {
      try {
        await q(
          env,
          run.tenantId,
          `INSERT INTO tasks (id, tenant_id, workspace_id, run_id, role, depth, dedup_hash, dedup_key, hypothesis_id, status)
           VALUES (gen_random_uuid(), $1, $2, $3, 'quant', 1, $4, '{}'::jsonb, 'x', 'QUEUED')`,
          [run.tenantId, run.workspaceId, run.runId, tasks[0]!.dedup_hash],
        );
        return "inserted";
      } catch (e) {
        return (e as { code?: string }).code ?? "error";
      }
    });
    expect(dupInsert).toBe("23505");

    // (a) workflow IDs are a deterministic function of the 5-tuple, exactly one execution each
    const ids = tasks.map((t) =>
      childWorkflowId(t.dedup_key as unknown as Parameters<typeof childWorkflowId>[0]),
    );
    const listed: string[] = [];
    for await (const wf of env.client.workflow.list({
      query: `WorkflowId STARTS_WITH "child-" AND TaskQueue = "${env.taskQueue}"`,
    }))
      listed.push(wf.workflowId);
    for (const id of ids) expect(listed.filter((x) => x === id)).toHaveLength(1);
    expect(listed).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const t of tasks) expect(`child-${t.dedup_hash}`).toBe(childWorkflowId(t.dedup_key as never));

    // (b) duplicate start resolved to the existing child (already-started handled, not failed)
    const history = await run.handle.fetchHistory();
    const failedStarts = (history.events ?? []).filter(
      (e) => e.startChildWorkflowExecutionFailedEventAttributes,
    );
    const dupNotes = await q(
      env,
      run.tenantId,
      "SELECT detail FROM run_events WHERE run_id=$1 AND kind='child.duplicate_start'",
      [run.runId],
    );
    expect(failedStarts.length).toBeGreaterThanOrEqual(1);
    expect(dupNotes.length).toBeGreaterThanOrEqual(1);

    // (c) after the injected parent-activity failure and retry: still 1 child, side effects = 1
    const faults = await q<{ n: string }>(
      env,
      run.tenantId,
      "SELECT count(*)::text AS n FROM agent_side_effects WHERE run_id=$1 AND kind='fault'",
      [run.runId],
    );
    expect(Number(faults[0]!.n)).toBeGreaterThanOrEqual(2); // one injected failure per distinct child, each retried
    const dupTask = tasks.find((t) => t.dedup_key.inputSnapshot === "snap-1")!;
    const panels = await q<{ n: string }>(
      env,
      run.tenantId,
      "SELECT count(*)::text AS n FROM agent_side_effects WHERE effect_key=$1",
      [`artifact:${dupTask.id}`],
    );
    expect(Number(panels[0]!.n)).toBe(1);
    const infer = await q<{ effect_key: string; provider_calls: number; status: string }>(
      env,
      run.tenantId,
      "SELECT effect_key, provider_calls, status FROM agent_side_effects WHERE kind='inference' AND effect_key LIKE $1",
      [`inference:${dupTask.id}:%`],
    );
    expect(infer.length).toBe(3);
    for (const r of infer) {
      expect(r.provider_calls).toBe(1);
      expect(r.status).toBe("done");
    }
    const charges = await q<{ n: string }>(
      env,
      run.tenantId,
      "SELECT count(*)::text AS n FROM budget_ledger WHERE task_id=$1 AND kind='charge'",
      [dupTask.id],
    );
    expect(Number(charges[0]!.n)).toBe(3);
    // (d) the different-inputSnapshot request is a distinct child
    expect(new Set(tasks.map((t) => t.dedup_key.inputSnapshot))).toEqual(new Set(["snap-1", "snap-2"]));

    await exportHistories(env, run.workflowId, "a18");
    observe({
      testId: "A18",
      observed: `3 spawn requests (2 identical, 1 with different inputSnapshot) -> ${listed.length} child workflows, ${tasks.length} task rows; duplicate start handled (${failedStarts.length} StartChildWorkflowExecutionFailed events, ${dupNotes.length} duplicate_start notes); injected parent-activity failures ${faults[0]!.n}, retried; duplicate identity: panel_proposal rows=1, inference rows=${infer.length} each provider_calls=1; unique constraint 23505 on duplicate dedup_hash; run ${res.state}`,
      fixtureHash: hashOf(planFor("A18")),
      evidence: {
        childWorkflowIds: ids,
        taskRows: tasks.map((t) => ({
          id: t.id,
          dedupHash: t.dedup_hash,
          inputSnapshot: t.dedup_key.inputSnapshot,
          status: t.status,
        })),
        workflowList: listed,
        startChildFailedEvents: failedStarts.length,
        sideEffects: {
          panelProposalRowsForDuplicateIdentity: 1,
          inferenceRows: infer.map((r) => ({ key: r.effect_key, providerCalls: r.provider_calls })),
        },
        injectedFaults: Number(faults[0]!.n),
      },
    });
  } finally {
    await w.stop();
  }
}, 240_000);
