import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { hashOf, planFor } from "@nearesis/agent-runtime";
import {
  exportHistories,
  makeEnv,
  q,
  runInvestigation,
  spawnWorkerProcess,
  waitFor,
  type Env,
} from "../helpers/harness.ts";

let env: Env;
beforeAll(async () => {
  env = await makeEnv();
}, 120_000);
afterAll(async () => env.stop());

it("A02: worker killed mid-task; work resumes and external effects are accepted exactly once", async () => {
  const policy = { heartbeatTimeoutMs: 3000 };
  const w1 = await spawnWorkerProcess(env, "w1", { policy, stepDelayMs: 1500 });
  let w2: Awaited<ReturnType<typeof spawnWorkerProcess>> | null = null;
  try {
    const run = await runInvestigation(env, "basic");
    // wait until a model call is inside its delivery window (effect row 'started')
    const inflight = await waitFor(async () => {
      const r = await q<{ effect_key: string }>(
        env,
        run.tenantId,
        "SELECT effect_key FROM agent_side_effects WHERE run_id=$1 AND kind='inference' AND status='started' AND effect_key LIKE '%:decide:%'",
        [run.runId],
      );
      return r.length ? r : null;
    });
    const killedAt = new Date().toISOString();
    await w1.kill();
    const killedKeys = inflight.map((r) => r.effect_key);
    await new Promise((r) => setTimeout(r, 4000));
    const restartedAt = new Date().toISOString();
    w2 = await spawnWorkerProcess(env, "w2", { policy, stepDelayMs: 1500 });
    const res = await run.result();
    expect(res.state).toBe("COMPLETE");

    const eff = await q<{
      effect_key: string;
      kind: string;
      guarantee: string;
      provider_calls: number;
      status: string;
    }>(
      env,
      run.tenantId,
      "SELECT effect_key, kind, guarantee, provider_calls, status FROM agent_side_effects WHERE run_id=$1 AND kind <> 'fault' ORDER BY effect_key",
      [run.runId],
    );
    // exactly-once ACCEPTANCE for every effect: all done, one row per key (PK)
    for (const e of eff) expect(e.status).toBe("done");
    const inference = eff.filter((e) => e.kind === "inference");
    const charges = await q<{ entry_key: string }>(
      env,
      run.tenantId,
      "SELECT entry_key FROM budget_ledger WHERE run_id=$1 AND kind='charge'",
      [run.runId],
    );
    expect(charges.length).toBe(inference.length); // one charge per accepted inference result
    expect(new Set(charges.map((c) => c.entry_key)).size).toBe(charges.length);
    // at-least-once DELIVERY is disclosed: duplicates only where the crash hit the call window
    const duplicates = inference
      .filter((e) => e.provider_calls > 1)
      .map((e) => ({ key: e.effect_key, providerCalls: e.provider_calls }));
    const killedSet = new Set(killedKeys.map((k) => k.replace(/^/, "")));
    for (const e of inference) {
      if (e.provider_calls > 1) expect(killedSet.has(e.effect_key)).toBe(true);
      expect(e.provider_calls).toBeLessThanOrEqual(2);
    }
    const internal = eff.filter((e) => e.guarantee === "internal");
    for (const e of internal) expect(e.provider_calls).toBe(1); // internal effects exactly once
    const panels = eff.filter((e) => e.kind === "panel_proposal");
    expect(panels).toHaveLength(2);
    const gw = eff.filter((e) => e.kind.startsWith("gw:"));
    expect(gw.length).toBeGreaterThan(0);

    await exportHistories(env, run.workflowId, "a02-crash");
    observe({
      testId: "A02",
      observed: `worker w1 SIGKILLed at ${killedAt} with ${killedKeys.length} inference call(s) in flight; w2 started ${restartedAt}; run ${res.state}. ${eff.length} ledger effects all status=done; inference accepted+charged once per key (${inference.length} keys, ${charges.length} charges); internal effects provider_calls=1; duplicate provider deliveries disclosed: ${JSON.stringify(duplicates)} (at-least-once delivery, exactly-once acceptance)`,
      fixtureHash: hashOf(planFor("basic")),
      evidence: { killedAt, restartedAt, killedKeys, duplicates, ledger: eff, chargeCount: charges.length },
    });
  } finally {
    await w1.stop();
    await w2?.stop();
  }
}, 300_000);
