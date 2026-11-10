import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { hashOf, planFor } from "@nearesis/agent-runtime";
import { privilegedActionHash } from "../../src/index.ts";
import {
  exportHistories,
  makeEnv,
  q,
  runViaApi,
  startApi,
  spawnWorkerProcess,
  type Api,
  waitFor,
  type Env,
  type WorkerProc,
} from "../helpers/harness.ts";

let env: Env;
let api: Api;
beforeAll(async () => {
  env = await makeEnv({ kernel: true });
  api = await startApi(env);
}, 180_000);
afterAll(async () => {
  await api?.close();
  await env.stop();
});

/** Owner decision through the approvals API for the run's pending request. */
async function decide(runId: string, decision: "approve" | "reject", expectHash?: string) {
  const list = await api.call("GET", `/v1/runs/${runId}/approvals`);
  const pending = (list.json.approvals as Array<{ approvalId: string; actionHash: string }>)[0]!;
  if (expectHash) expect(pending.actionHash).toBe(expectHash);
  const r = await api.call("POST", `/v1/runs/${runId}/approvals/${pending.approvalId}`, {
    decision,
    actionHash: pending.actionHash,
  });
  expect(r.status).toBe(202);
  return pending.actionHash;
}

const policy = { heartbeatTimeoutMs: 3000 };
const stateOf = (tenantId: string, runId: string) =>
  q<{ state: string }>(env, tenantId, "SELECT state FROM runs WHERE id=$1", [runId]).then((r) => r[0]?.state);
const privCount = (tenantId: string, runId: string) =>
  q<{ n: string }>(
    env,
    tenantId,
    "SELECT count(*)::text AS n FROM agent_side_effects WHERE run_id=$1 AND kind IN ('privileged_action','gw:canvas.patch@1')",
    [runId],
  ).then((r) => Number(r[0]!.n));

it("A20: four-agent investigation survives a worker crash and restart with no repeated side effects (P/N1/N2)", async () => {
  const procs: WorkerProc[] = [];
  try {
    // ================= A20-P: all branches succeed; worker 1 SIGKILLed with >=2 children mid-activity =================
    const w1 = await spawnWorkerProcess(env, "w1", { policy, stepDelayMs: 1200 });
    procs.push(w1);
    const P = await runViaApi(env, api, "A20-P");
    const inflight = await waitFor(async () => {
      const r = await q<{ effect_key: string }>(
        env,
        P.tenantId,
        "SELECT effect_key FROM agent_side_effects WHERE run_id=$1 AND kind='inference' AND status='started' AND effect_key LIKE '%:decide:%'",
        [P.runId],
      );
      return new Set(r.map((x) => x.effect_key.split(":decide:")[0])).size >= 2 ? r : null;
    });
    const w2 = await spawnWorkerProcess(env, "w2", { policy, stepDelayMs: 1200 });
    procs.push(w2);
    const killedAt = new Date().toISOString();
    await w1.kill();
    // authoritative set of calls inside their delivery window at the moment of the crash (rows stay 'started')
    const killedKeys = (
      await q<{ effect_key: string }>(
        env,
        P.tenantId,
        "SELECT effect_key FROM agent_side_effects WHERE run_id=$1 AND kind='inference' AND status='started'",
        [P.runId],
      )
    ).map((r) => r.effect_key);
    expect(killedKeys.length).toBeGreaterThanOrEqual(inflight.length > 0 ? 1 : 0);
    await new Promise((r) => setTimeout(r, 10_000)); // replacement after 10 s
    const w3 = await spawnWorkerProcess(env, "w3", { policy, stepDelayMs: 1200 });
    procs.push(w3);
    const restartedAt = new Date().toISOString();

    // (e) privileged step must not execute before approval
    await waitFor(async () => (await stateOf(P.tenantId, P.runId)) === "APPROVAL_NEEDED", 120_000);
    expect(await privCount(P.tenantId, P.runId)).toBe(0);
    const action = planFor("A20-P").privilegedAction!;
    const hash = privilegedActionHash(action);
    await decide(P.runId, "approve", hash);
    const res = await P.result();
    expect(res.state).toBe("COMPLETE"); // (a) A20-P reaches COMPLETE

    // (b) 4 agents traceable
    const tasks = await q<{
      id: string;
      parent_task_id: string | null;
      role: string;
      depth: number;
      workspace_id: string;
      result: {
        result: {
          parentRunId: string;
          workspaceId: string;
          toolLog: Array<{ ok: boolean; resultHash: string | null }>;
          artifact: { label: string; type: string };
          finding: { facts: Array<{ resultRef: { queryHash: string } }> } | null;
        };
      } | null;
    }>(
      env,
      P.tenantId,
      "SELECT id, parent_task_id, role, depth, workspace_id, result FROM tasks WHERE run_id=$1 ORDER BY depth, role",
      [P.runId],
    );
    const root = tasks.find((t) => t.depth === 0)!;
    const kids = tasks.filter((t) => t.depth === 1);
    expect(tasks).toHaveLength(4);
    expect(kids.map((k) => k.role).sort()).toEqual(["composer", "quant", "semantic_analyst"]);
    for (const k of kids) {
      expect(k.parent_task_id).toBe(root.id);
      expect(k.workspace_id).toBe(P.workspaceId);
      const r = k.result!.result;
      expect(r.parentRunId).toBe(P.runId);
      // (g) trace, parsed tool envelopes, verified metric refs, labelled artifact
      expect(r.toolLog.filter((l) => l.ok).every((l) => /^[0-9a-f]{64}$/.test(l.resultHash ?? ""))).toBe(
        true,
      );
      expect(r.toolLog.some((l) => l.ok)).toBe(true);
      const hashes = new Set(r.toolLog.map((l) => l.resultHash));
      for (const f of r.finding?.facts ?? []) expect(hashes.has(f.resultRef.queryHash)).toBe(true);
      expect(["unattested_dev", "fixture_synthetic"]).toContain(r.artifact.label);
    }
    // (c) side effects by guarantee class
    const eff = await q<{
      effect_key: string;
      kind: string;
      guarantee: string;
      provider_calls: number;
      status: string;
    }>(
      env,
      P.tenantId,
      "SELECT effect_key, kind, guarantee, provider_calls, status FROM agent_side_effects WHERE run_id=$1 AND kind <> 'fault' ORDER BY effect_key",
      [P.runId],
    );
    for (const e of eff) expect(e.status).toBe("done");
    const internal = eff.filter((e) => e.guarantee === "internal");
    for (const e of internal) expect(e.provider_calls).toBe(1); // internal: exactly once
    expect(eff.filter((e) => e.kind === "panel_proposal")).toHaveLength(3);
    expect(eff.filter((e) => e.kind === "privileged_action")).toHaveLength(1); // (e) executes once after approval
    const inference = eff.filter((e) => e.kind === "inference");
    const charges = await q<{ entry_key: string }>(
      env,
      P.tenantId,
      "SELECT entry_key FROM budget_ledger WHERE run_id=$1 AND kind='charge'",
      [P.runId],
    );
    expect(charges.length).toBe(inference.length); // exactly 1 accepted+charged result per key
    expect(new Set(charges.map((c) => c.entry_key)).size).toBe(charges.length);
    const duplicates = inference
      .filter((e) => e.provider_calls > 1)
      .map((e) => ({ key: e.effect_key, providerCalls: e.provider_calls }));
    const killedSet = new Set(killedKeys);
    for (const d of duplicates) expect(killedSet.has(d.key)).toBe(true); // duplicates only inside a crashed call window
    for (const e of inference) expect(e.provider_calls).toBeLessThanOrEqual(2); // <= 1 + crashes (1 kill)
    expect(duplicates.length).toBeLessThanOrEqual(killedKeys.length);
    // financial / chain effects are not exercised
    expect(eff.filter((e) => /paid|chain/i.test(e.kind))).toHaveLength(0);
    // (d) scope-expansion request denied with an audit record
    const denied = await q<{ task_id: string; reason_code: string; detail: { capability: string } }>(
      env,
      P.tenantId,
      "SELECT task_id, reason_code, detail FROM agent_audit WHERE run_id=$1 AND kind='gateway.denied'",
      [P.runId],
    );
    const quant = kids.find((k) => k.role === "quant")!;
    expect(
      denied.some(
        (d) =>
          d.task_id === quant.id &&
          d.reason_code === "TOOL_NOT_GRANTED" &&
          d.detail.capability === "registry.read@1",
      ),
    ).toBe(true);
    expect(
      (
        await q(
          env,
          P.tenantId,
          "SELECT 1 FROM agent_side_effects WHERE run_id=$1 AND kind='gw:registry.read@1'",
          [P.runId],
        )
      ).length,
    ).toBe(0);
    // (f) budget ledger total <= reserved
    const led = await q<{ reserved: string; charged: string }>(
      env,
      P.tenantId,
      "SELECT COALESCE(sum(CASE kind WHEN 'reserve' THEN tokens WHEN 'release' THEN -tokens ELSE 0 END),0)::text AS reserved, COALESCE(sum(CASE kind WHEN 'charge' THEN tokens ELSE 0 END),0)::text AS charged FROM budget_ledger WHERE run_id=$1",
      [P.runId],
    );
    expect(Number(led[0]!.charged)).toBeLessThanOrEqual(Number(led[0]!.reserved));
    const approval = await q<{ action_hash: string; approved_by: string }>(
      env,
      P.tenantId,
      "SELECT action_hash, approved_by FROM approvals WHERE run_id=$1 AND decision='approve'",
      [P.runId],
    );
    expect(approval).toEqual([{ action_hash: hash, approved_by: env.kernel!.userId }]);
    // (e) the approved patch was applied once through the kernel canvas.apply_patch command
    const applied = await env.kernel!.kernelAdmin.query(
      "SELECT count(*)::int AS n FROM canvas_patches WHERE workspace_id=$1",
      [env.workspaceId],
    );
    expect(applied.rows[0].n).toBe(1);
    const timeline = await q<{
      kind: string;
      from_state: string | null;
      to_state: string | null;
      created_at: string;
    }>(
      env,
      P.tenantId,
      "SELECT kind, from_state, to_state, created_at FROM run_events WHERE run_id=$1 ORDER BY seq",
      [P.runId],
    );
    await exportHistories(env, P.workflowId, "a20-p");

    // ================= A20-N1: one child's source unavailable => exactly PARTIAL, failed branch named =================
    const N1 = await runViaApi(env, api, "A20-N1");
    const n1 = await N1.result();
    expect(n1.state).toBe("PARTIAL");
    expect(n1.failedBranches).toEqual([
      { task: "fit swap model", role: "quant", reasonCode: "SOURCE_UNAVAILABLE" },
    ]);
    expect(await privCount(N1.tenantId, N1.runId)).toBe(0);
    await exportHistories(env, N1.workflowId, "a20-n1");

    // ================= A20-N2: approval rejected => exactly BLOCKED, no privileged execution =================
    const N2 = await runViaApi(env, api, "A20-N2");
    await waitFor(async () => (await stateOf(N2.tenantId, N2.runId)) === "APPROVAL_NEEDED", 120_000);
    await decide(N2.runId, "reject");
    const n2 = await N2.result();
    expect(n2.state).toBe("BLOCKED");
    expect(n2.failure?.reasonCode).toBe("APPROVAL_REJECTED");
    expect(await privCount(N2.tenantId, N2.runId)).toBe(0);
    await exportHistories(env, N2.workflowId, "a20-n2");

    observe({
      testId: "A20",
      observed: `questions via the API, approvals via the approvals API, real kernel gateway/leases and near-thesis plugin, canvas.apply_patch applied once (canvas_patches=${applied.rows[0].n}). A20-P COMPLETE: director + 3 children traceable; w1 SIGKILLed at ${killedAt} with ${killedKeys.length} inference calls in flight across >=2 children, replacement w3 started ${restartedAt}; privileged step waited in APPROVAL_NEEDED (0 executions) then ran once after approval ${hash.slice(0, 10)}; internal effects ${internal.length} rows all provider_calls=1; inference ${inference.length} keys, ${charges.length} charges (exactly-once acceptance), duplicate provider deliveries disclosed: ${JSON.stringify(duplicates)} (at-least-once delivery, exactly-once acceptance); 0 financial/chain effects; quant scope-expansion registry.read@1 denied TOOL_NOT_GRANTED with audit; charged ${led[0]!.charged} <= reserved ${led[0]!.reserved} tokens. A20-N1 PARTIAL named ${JSON.stringify(n1.failedBranches)}; A20-N2 BLOCKED ${n2.failure?.reasonCode}`,
      fixtureHash: hashOf([planFor("A20-P"), planFor("A20-N1"), planFor("A20-N2")]),
      evidence: {
        killedAt,
        restartedAt,
        killedKeys,
        duplicates,
        approval: { actionHash: hash, record: approval },
        timeline: timeline.map((t) => ({
          kind: t.kind,
          from: t.from_state,
          to: t.to_state,
          at: t.created_at,
        })),
        ledger: eff.map((e) => ({
          key: e.effect_key,
          kind: e.kind,
          guarantee: e.guarantee,
          providerCalls: e.provider_calls,
        })),
        budget: led[0],
        tasks: tasks.map((t) => ({ id: t.id, role: t.role, depth: t.depth, parent: t.parent_task_id })),
        scopeExpansionDenials: denied,
        n1: { state: n1.state, failedBranches: n1.failedBranches },
        n2: { state: n2.state, failure: n2.failure },
      },
    });
  } finally {
    for (const p of procs) await p.stop();
  }
}, 600_000);
