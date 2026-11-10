import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { hashOf, planFor } from "@nearesis/agent-runtime";
import {
  exportHistories,
  makeEnv,
  q,
  runInvestigation,
  startWorker,
  waitFor,
  type Env,
} from "../helpers/harness.ts";

let env: Env;
beforeAll(async () => {
  env = await makeEnv();
}, 120_000);
afterAll(async () => env.stop());

async function cancelRun(how: "signal" | "native") {
  const run = await runInvestigation(env, "A10");
  // both children are mid-call (inference in its delivery window)
  await waitFor(async () => {
    const r = await q<{ n: string }>(
      env,
      run.tenantId,
      "SELECT count(DISTINCT split_part(effect_key, ':decide:', 1))::text AS n FROM agent_side_effects WHERE run_id=$1 AND kind='inference' AND effect_key LIKE '%:decide:%' AND status='started'",
      [run.runId],
    );
    return Number(r[0]!.n) >= 2 ? true : null;
  });
  if (how === "signal") await run.handle.signal("cancel", { requestedBy: "owner" });
  else await run.handle.cancel();
  const res = await run.result();
  const tasks = await q<{ id: string; depth: number; status: string }>(
    env,
    run.tenantId,
    "SELECT id, depth, status FROM tasks WHERE run_id=$1 ORDER BY depth, id",
    [run.runId],
  );
  const events = await q<{ from_state: string; to_state: string; detail: Record<string, unknown> }>(
    env,
    run.tenantId,
    "SELECT from_state, to_state, detail FROM run_events WHERE run_id=$1 AND kind='transition' ORDER BY seq",
    [run.runId],
  );
  const before = await q<{ n: string }>(
    env,
    run.tenantId,
    "SELECT count(*)::text AS n FROM agent_side_effects WHERE run_id=$1 AND status='done' AND kind='inference'",
    [run.runId],
  );
  await new Promise((r) => setTimeout(r, 3000)); // nothing may be accepted after cancellation
  const after = await q<{ n: string }>(
    env,
    run.tenantId,
    "SELECT count(*)::text AS n FROM agent_side_effects WHERE run_id=$1 AND status='done' AND kind='inference'",
    [run.runId],
  );
  const started = await q<{ effect_key: string }>(
    env,
    run.tenantId,
    "SELECT effect_key FROM agent_side_effects WHERE run_id=$1 AND status='started' AND kind='inference'",
    [run.runId],
  );
  const desc = await run.handle.describe();
  const childStatuses: Record<string, string> = {};
  for await (const wf of env.client.workflow.list({
    query: `WorkflowId STARTS_WITH "child-" AND TaskQueue = "${env.taskQueue}"`,
  }))
    childStatuses[wf.workflowId.slice(0, 14)] = wf.status.name;
  return {
    run,
    res,
    tasks,
    events,
    before: Number(before[0]!.n),
    after: Number(after[0]!.n),
    started,
    parentStatus: desc.status.name,
    childStatuses,
  };
}

it("A10: cancelling the whole investigation cancels children and leaves a stable CANCELLED parent", async () => {
  const w = await startWorker(env, { stepDelayMs: 1500 });
  try {
    const sig = await cancelRun("signal");
    const nat = await cancelRun("native");
    for (const r of [sig, nat]) {
      expect(r.res.state).toBe("CANCELLED");
      expect(r.parentStatus).toBe("COMPLETED"); // stable terminal parent
      const kids = r.tasks.filter((t) => t.depth === 1);
      expect(kids).toHaveLength(2);
      for (const k of kids) expect(k.status).toBe("CANCELLED");
      const last = r.events.at(-1)!;
      expect(last.to_state).toBe("CANCELLED");
      const inFlight = (
        last.detail as { inFlightExternalCalls: Array<{ effectKey: string; compensation: string }> }
      ).inFlightExternalCalls;
      expect(inFlight.length).toBeGreaterThanOrEqual(2); // calls that may still complete are recorded
      expect(inFlight.map((i) => i.effectKey).sort()).toEqual(r.started.map((s) => s.effect_key).sort());
      expect(r.after).toBe(r.before); // no result accepted after cancellation
      expect(Object.values(r.childStatuses).every((s) => s === "CANCELLED")).toBe(true);
    }
    await exportHistories(env, sig.run.workflowId, "a10-cancel");
    observe({
      testId: "A10",
      observed: `cancel via signal and via native workflow cancel, both with 2 children mid-inference: parent returned stable state CANCELLED (workflow status COMPLETED); child tasks CANCELLED (${JSON.stringify(sig.tasks.filter((t) => t.depth === 1).map((t) => t.status))}); child workflows ${JSON.stringify(Object.values(sig.childStatuses))}; ${(sig.events.at(-1)!.detail as { inFlightExternalCalls: unknown[] }).inFlightExternalCalls.length} in-flight external calls recorded as may-still-complete; accepted inference results unchanged after cancel (${sig.before} -> ${sig.after})`,
      fixtureHash: hashOf(planFor("A10")),
      evidence: {
        signal: { events: sig.events, tasks: sig.tasks, childStatuses: sig.childStatuses },
        native: { events: nat.events, tasks: nat.tasks, childStatuses: nat.childStatuses },
      },
    });
  } finally {
    await w.stop();
  }
}, 240_000);
