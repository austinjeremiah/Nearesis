import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { hashOf, planFor } from "@nearesis/agent-runtime";
import { createActivities, privilegedActionHash } from "../../src/index.ts";
import { makeEnv, q, runInvestigation, startWorker, waitFor, type Env } from "../helpers/harness.ts";

let env: Env;
beforeAll(async () => {
  env = await makeEnv();
}, 120_000);
afterAll(async () => env.stop());

const priv = (tenantId: string, runId: string) =>
  q<{ n: string }>(
    env,
    tenantId,
    "SELECT count(*)::text AS n FROM agent_side_effects WHERE run_id=$1 AND kind IN ('privileged_action','gw:canvas.patch@1')",
    [runId],
  ).then((r) => Number(r[0]!.n));
const atApproval = (run: { tenantId: string; runId: string }) =>
  waitFor(
    async () =>
      (await q<{ state: string }>(env, run.tenantId, "SELECT state FROM runs WHERE id=$1", [run.runId]))[0]
        ?.state === "APPROVAL_NEEDED",
  );

it("A07: mutated approval parameters invalidate the old approval and block the action", async () => {
  const w = await startWorker(env, { policy: { approvalTimeoutMs: 6000 } });
  try {
    const orig = planFor("priv").privilegedAction!;
    const h1 = privilegedActionHash(orig);
    const mutated = {
      ...orig,
      params: { ...orig.params, spec: { kind: "line", metric: "intents.swap_volume_usd_24h" } },
    };
    const h2 = privilegedActionHash(mutated);
    expect(h2).not.toBe(h1);

    // run 1: parameters mutated after the approval was prepared for the original; the old approval must not count
    const r1 = await runInvestigation(env, "priv");
    await atApproval(r1);
    await r1.handle.signal("modifyAction", { params: mutated.params });
    await r1.handle.signal("approve", { actionHash: h1, approvedBy: "owner" }); // approval for the OLD parameters
    const res1 = await r1.result(); // times out waiting for a matching approval
    expect(res1.state).toBe("BLOCKED");
    expect(res1.failure?.reasonCode).toBe("APPROVAL_INVALID");
    expect(await priv(r1.tenantId, r1.runId)).toBe(0);
    const ev1 = await q<{ kind: string; detail: Record<string, unknown> }>(
      env,
      r1.tenantId,
      "SELECT kind, detail FROM run_events WHERE run_id=$1 AND kind IN ('approval.invalidated','approval.mismatch')",
      [r1.runId],
    );
    expect(ev1.map((e) => e.kind)).toContain("approval.invalidated");
    expect(
      (
        await q(env, r1.tenantId, "SELECT 1 FROM approvals WHERE run_id=$1 AND decision='approve'", [
          r1.runId,
        ])
      ).length,
    ).toBe(0);

    // execution-time guard: stored approval for h1 does not authorise the mutated parameters
    await q(
      env,
      r1.tenantId,
      "INSERT INTO approvals (tenant_id, run_id, action_hash, decision, approved_by) VALUES ($1,$2,$3,'approve','owner')",
      [r1.tenantId, r1.runId, h1],
    );
    const acts = createActivities(w.deps);
    const guard = await acts
      .executePrivilegedAction({
        tenantId: r1.tenantId,
        workspaceId: r1.workspaceId,
        runId: r1.runId,
        directorTaskId: randomUUID(),
        action: mutated,
        actionHash: h1,
      })
      .then(
        () => "executed",
        (e) => (e as { type?: string }).type ?? String(e),
      );
    expect(guard).toBe("APPROVAL_INVALID");
    expect(await priv(r1.tenantId, r1.runId)).toBe(0);

    // run 2 (positive control): mutate, then approve the NEW hash => executes once with the new parameters
    const r2 = await runInvestigation(env, "priv");
    await atApproval(r2);
    await r2.handle.signal("modifyAction", { params: mutated.params });
    await r2.handle.signal("approve", { actionHash: h2, approvedBy: "owner" });
    const res2 = await r2.result();
    expect(res2.state).toBe("COMPLETE");
    expect(res2.approvalActionHash).toBe(h2);
    const eff = await q<{ effect_key: string }>(
      env,
      r2.tenantId,
      "SELECT effect_key FROM agent_side_effects WHERE run_id=$1 AND kind='privileged_action'",
      [r2.runId],
    );
    expect(eff).toEqual([{ effect_key: `privileged:${r2.runId}:${h2}` }]);

    observe({
      testId: "A07",
      observed: `parameters mutated while APPROVAL_NEEDED (hash ${h1.slice(0, 10)} -> ${h2.slice(0, 10)}); approval for old hash ignored: run ${res1.state}/${res1.failure?.reasonCode}, 0 privileged executions, no approval persisted, approval.invalidated event recorded; stored old-hash approval rejected at execution time (${guard}) for mutated params; positive control: approving the new hash executed once and run ${res2.state}`,
      fixtureHash: hashOf(planFor("priv")),
      evidence: {
        oldHash: h1,
        newHash: h2,
        run1: { state: res1.state, failure: res1.failure, events: ev1 },
        executionGuard: guard,
        run2: { state: res2.state, effect: eff },
      },
    });
  } finally {
    await w.stop();
  }
}, 240_000);
