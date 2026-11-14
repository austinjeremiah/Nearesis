import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { hashOf, planFor } from "@nearesis/agent-runtime";
import { createActivities, privilegedActionHash } from "../../src/index.ts";
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

const privCount = (tenantId: string, runId: string) =>
  q<{ n: string }>(
    env,
    tenantId,
    "SELECT count(*)::text AS n FROM agent_side_effects WHERE run_id=$1 AND (kind='privileged_action' OR kind='gw:canvas.patch@1')",
    [runId],
  ).then((r) => Number(r[0]!.n));

it("A06: no privileged action before the approved action hash; interruption does not lose or bypass the approval", async () => {
  let w = await startWorker(env);
  try {
    const run = await runInvestigation(env, "priv");
    const action = planFor("priv").privilegedAction!;
    const hash = privilegedActionHash(action);
    await waitFor(
      async () =>
        (await q<{ state: string }>(env, run.tenantId, "SELECT state FROM runs WHERE id=$1", [run.runId]))[0]
          ?.state === "APPROVAL_NEEDED",
    );
    expect(await privCount(run.tenantId, run.runId)).toBe(0);

    // execution-time check: the activity itself refuses without a stored approval for the exact hash
    const acts = createActivities(w.deps);
    const direct = await acts
      .executePrivilegedAction({
        tenantId: run.tenantId,
        workspaceId: run.workspaceId,
        runId: run.runId,
        directorTaskId: randomUUID(),
        action,
        actionHash: hash,
      })
      .then(
        () => "executed",
        (e) => (e as { type?: string }).type ?? String(e),
      );
    expect(direct).toBe("APPROVAL_INVALID");
    expect(await privCount(run.tenantId, run.runId)).toBe(0);

    // interrupt: worker dies while waiting; a wrong-hash approval arrives meanwhile
    await w.stop();
    await run.handle.signal("approve", { actionHash: "0".repeat(64), approvedBy: "owner" });
    await new Promise((r) => setTimeout(r, 1500));
    w = await startWorker(env);
    await new Promise((r) => setTimeout(r, 2000));
    const state = (
      await q<{ state: string }>(env, run.tenantId, "SELECT state FROM runs WHERE id=$1", [run.runId])
    )[0]!.state;
    expect(state).toBe("APPROVAL_NEEDED");
    expect(await privCount(run.tenantId, run.runId)).toBe(0);

    // the correct approval releases the step, exactly once
    await run.handle.signal("approve", { actionHash: hash, approvedBy: "owner" });
    const res = await run.result();
    expect(res.state).toBe("COMPLETE");
    expect(res.approvalActionHash).toBe(hash);
    expect(await privCount(run.tenantId, run.runId)).toBe(2); // ledger row + one gateway execution row (same single execution)
    const priv = await q<{ provider_calls: number; effect_key: string }>(
      env,
      run.tenantId,
      "SELECT effect_key, provider_calls FROM agent_side_effects WHERE run_id=$1 AND kind='privileged_action'",
      [run.runId],
    );
    expect(priv).toEqual([{ effect_key: `privileged:${run.runId}:${hash}`, provider_calls: 1 }]);
    const appr = await q<{ action_hash: string; decision: string; approved_by: string }>(
      env,
      run.tenantId,
      "SELECT action_hash, decision, approved_by FROM approvals WHERE run_id=$1",
      [run.runId],
    );
    expect(appr).toEqual([{ action_hash: hash, decision: "approve", approved_by: "owner" }]); // the wrong-hash approval was never persisted
    const order = await q<{ kind: string; seq: number }>(
      env,
      run.tenantId,
      "SELECT kind, seq FROM run_events WHERE run_id=$1 AND kind IN ('approval.requested','privileged.executed') ORDER BY seq",
      [run.runId],
    );
    expect(order.map((o) => o.kind)).toEqual(["approval.requested", "privileged.executed"]);
    await exportHistories(env, run.workflowId, "a06-approval");
    observe({
      testId: "A06",
      observed: `privileged step waited in APPROVAL_NEEDED with 0 executions; direct execute without approval rejected APPROVAL_INVALID; worker killed while waiting and a wrong-hash approval ignored (state stayed APPROVAL_NEEDED, 0 executions) across restart; correct approval ${hash.slice(0, 12)} then executed exactly once (provider_calls=1) and run ${res.state}; only the matching approval was persisted`,
      fixtureHash: hashOf(planFor("priv")),
      evidence: { actionHash: hash, approvals: appr, order, privilegedLedger: priv },
    });
  } finally {
    await w.stop();
  }
}, 240_000);
