import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { child, hashOf, planFor, tag, type ScriptRule } from "@nearesis/agent-runtime";
import { makeEnv, q, startApi, waitFor, type Api, type Env } from "../helpers/harness.ts";
import {
  actorFor,
  addMember,
  addPanel,
  command,
  createMarker,
  startScriptedWorker,
} from "./m-marker-helpers.ts";

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
const ws = () => env.workspaceId;

const G = ["research.run_model@1", "semantic.query@1"]; // the parent grant set granted to the editor's delegation scope
const EXPAND = "M12-expand";
const REVOKE = "M12-revoke";
const has = (p: string, ...n: string[]) => n.every((x) => p.includes(x));
const quantOk = {
  action: "finish",
  status: "supported",
  statement: "The fitted model explains 0.82 of variance.",
  facts: [{ value: "0.82", unit: "ratio", sourceStep: 0, column: "r2" }],
  limitations: ["synthetic fixture"],
};
const runModel = {
  action: "tool",
  tool: "research.run_model@1",
  input: { model: "ols", features: ["swap_count"] },
};

let revoked = 0;
const plan = (scn: string): ScriptRule => ({
  match: (r) => has(r.prompt, "[role=director]", "[phase=plan]", tag(scn)),
  respond: () => ({ ...planFor("basic"), stages: [[child(scn, "quant", "probe the tool boundary")]] }),
});
const rules: ScriptRule[] = [
  plan(EXPAND),
  plan(REVOKE),
  // M12-expand: one valid call, then a tool outside the child's grant, then finish
  { match: (r) => has(r.prompt, tag(EXPAND), "[role=quant]", "[step=0]"), respond: () => runModel },
  {
    match: (r) => has(r.prompt, tag(EXPAND), "[role=quant]", "[step=1]"),
    respond: () => ({ action: "tool", tool: "registry.read@1", input: { key: "all-sources" } }),
  },
  { match: (r) => has(r.prompt, tag(EXPAND), "[role=quant]", "[step=2]"), respond: () => quantOk },
  // M12-revoke: the kernel lease is revoked between turns, then the model re-emits the same cached call
  { match: (r) => has(r.prompt, tag(REVOKE), "[role=quant]", "[step=0]"), respond: () => runModel },
  {
    match: (r) => has(r.prompt, tag(REVOKE), "[role=quant]", "[step=1]"),
    respond: async () => {
      const t = (
        await q<{ id: string; run_id: string }>(
          env,
          env.tenantId,
          "SELECT id, run_id FROM tasks WHERE workspace_id=$1 AND depth>0 AND role='quant' AND objective LIKE $2 ORDER BY created_at DESC LIMIT 1",
          [ws(), `%${tag(REVOKE)}%`],
        )
      )[0]!;
      // revocation through the kernel lease API (K10), exactly as the A03 broker does, issued by the run's requester
      const held = await env.kernel!.kernelAdmin.query(
        "SELECT id FROM capability_leases WHERE workspace_id=$1 AND holder_actor_id=$2 AND revoked_at IS NULL",
        [ws(), t.id],
      );
      for (const l of held.rows) await env.kernel!.kernel.leases.revoke(env.kernel!.session, l.id as string);
      revoked = held.rows.length;
      return runModel;
    },
  },
  { match: (r) => has(r.prompt, tag(REVOKE), "[role=quant]", "[step=2]"), respond: () => runModel },
  {
    match: (r) => has(r.prompt, tag(REVOKE), "[role=quant]", "[step=3]"),
    respond: () => ({
      action: "abort",
      reasonCode: "LEASE_REVOKED",
      message: "tool lease revoked; stopping",
    }),
  },
];

type MarkerView = { status: string; reasonCode: string | null; linkedEvidenceIds: string[] };

it("M12: a marker-spawned child holds only a subset of its parent's grants, is denied and audited outside them, stops when its lease or budget is revoked, and cannot exceed depth 3 or fan-out 6", async () => {
  const kenv = env.kernel!;
  const owner = actorFor(api.app, "owner", kenv.userId, await kenv.kernel.devAuth!.login(kenv.subject));
  const editor = await addMember(env, api.app, "ed", "analyst");
  const panel = await addPanel(owner, ws());
  expect(
    (
      await owner.call("PUT", `/v1/workspaces/${ws()}/delegation-scopes`, {
        userId: editor.userId,
        agents: ["quant", "skeptic", "semantic_analyst"],
        grants: G,
        delegateTo: [],
        maxBudget: { tokens: 200_000, toolCalls: 24, usd: 20 },
      })
    ).status,
  ).toBe(204);
  const w = await startScriptedWorker(env, rules, {
    policy: { stageTimeboxMs: 20_000, heartbeatTimeoutMs: 30_000 },
  });
  try {
    const marker = async (id: string) =>
      (await owner.call("GET", `/v1/workspaces/${ws()}/markers/${id}`)).json as unknown as MarkerView;
    const runUntil = (id: string, done: (m: MarkerView) => boolean) =>
      waitFor(
        async () => {
          await owner.call("POST", `/v1/workspaces/${ws()}/marker-tasks/dispatch`);
          const m = await marker(id);
          return done(m) ? m : null;
        },
        150_000,
        400,
      );
    const finished = (m: MarkerView) => m.status === "REVIEW_REQUIRED" || m.reasonCode !== null;
    const assign = async (scenario: string, grants: string[], extra: Record<string, unknown> = {}) => {
      const id = await createMarker(owner, ws(), panel.panelId, `[scenario=${scenario}] probe`);
      const r = await command(editor, ws(), "marker.assign", {
        markerId: id,
        agents: ["quant"],
        grants,
        ...extra,
      });
      return { id, r };
    };
    const taskOf = async (id: string) =>
      (
        (await owner.call("GET", `/v1/workspaces/${ws()}/markers/${id}/tasks`)).json as {
          tasks: Array<{ runId: string; status: string; reasonCode: string | null; grants: string[] }>;
        }
      ).tasks[0]!;
    const kq = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
      (await kenv.kernelAdmin.query(sql, p)).rows as T[];

    // ---- (a) the child's grants are a subset of the assigner's, never a superset. Choice: REJECT the expansion.
    const spawnsBefore = Number(
      (
        await q<{ n: string }>(env, env.tenantId, "SELECT count(*)::text n FROM runs WHERE workspace_id=$1", [
          ws(),
        ])
      )[0]!.n,
    );
    const expandMarker = await createMarker(owner, ws(), panel.panelId, `[scenario=${EXPAND}] probe`);
    const tooMany = await command(editor, ws(), "marker.assign", {
      markerId: expandMarker,
      agents: ["quant"],
      grants: [...G, "registry.read@1"],
    });
    expect(tooMany.status).toBe(403);
    expect((tooMany.json as { reasonCode: string }).reasonCode).toBe("DELEGATION_EXPANSION_DENIED");
    expect(await kq("SELECT 1 FROM marker_tasks WHERE marker_id=$1", [expandMarker])).toHaveLength(0);
    const denialAudit = await kq<{ reason_code: string }>(
      "SELECT reason_code FROM audit_events WHERE action='access.denied' AND reason_code='DELEGATION_EXPANSION_DENIED' AND actor_id=$1",
      [editor.userId],
    );
    expect(denialAudit.length).toBeGreaterThanOrEqual(1); // denied and audited
    expect(
      Number(
        (
          await q<{ n: string }>(
            env,
            env.tenantId,
            "SELECT count(*)::text n FROM runs WHERE workspace_id=$1",
            [ws()],
          )
        )[0]!.n,
      ),
    ).toBe(spawnsBefore);
    // negative control: the owner holds implicit unbounded scope, so the same request is accepted and the recorded grant set
    // is a SUPERSET of G; the subset check used below must flag it.
    const ctlMarker = await createMarker(owner, ws(), panel.panelId, `[scenario=${EXPAND}] control`);
    const ctl = await command(owner, ws(), "marker.assign", {
      markerId: ctlMarker,
      agents: ["quant"],
      grants: [...G, "registry.read@1"],
    });
    expect(ctl.status).toBe(200);
    const isSubset = (g: string[], parent: string[]) => g.every((x) => parent.includes(x));
    const ctlGrants = (await taskOf(ctlMarker)).grants;
    expect(isSubset(ctlGrants, G)).toBe(false);
    // (a) positive: the editor's accepted assignment records exactly G
    const ok = await assign(EXPAND, G);
    expect(ok.r.status).toBe(200);
    expect(isSubset((await taskOf(ok.id)).grants, G)).toBe(true);
    expect((await taskOf(ok.id)).grants).toEqual(G);

    // ---- (b) a tool outside the child's grant is denied and audited with 0 executions
    // (the control marker is also PENDING; let both run, only the editor's is asserted on)
    const done1 = await runUntil(ok.id, finished);
    const t1 = await taskOf(ok.id);
    const kids = await q<{ id: string; role: string }>(
      env,
      t1.runId ? env.tenantId : env.tenantId,
      "SELECT id, role FROM tasks WHERE run_id=$1 AND depth>0",
      [t1.runId],
    );
    expect(kids).toHaveLength(1);
    const childId = kids[0]!.id;
    const inv = await kq<{ capability: string; state: string; reason_code: string | null }>(
      "SELECT capability, state, reason_code FROM tool_invocations WHERE actor_id=$1 ORDER BY started_at",
      [childId],
    );
    // 0 executions: the out-of-scope tool never reached an executed state in the kernel
    expect(inv.filter((r) => r.capability === "registry.read@1" && r.state === "ok")).toHaveLength(0);
    expect(inv.filter((r) => r.capability === "research.run_model@1" && r.state === "ok")).toHaveLength(1);
    // denied and audited (runtime decision trace; the kernel audits denials that reach the gateway)
    const raudit = await q<{ kind: string; reason_code: string | null; detail: unknown }>(
      env,
      env.tenantId,
      "SELECT kind, reason_code, detail FROM agent_audit WHERE task_id=$1 AND kind IN ('gateway.denied','limit.rejected') ORDER BY created_at",
      [childId],
    );
    expect(raudit.length).toBeGreaterThanOrEqual(1);
    const denied = raudit.map((r) => ({ kind: r.kind, reasonCode: r.reason_code }));
    const kaudit = await kq<{ reason_code: string }>(
      "SELECT reason_code FROM audit_events WHERE actor_id=$1 AND action='tool.invoke.denied' AND subject='registry.read@1'",
      [childId],
    );
    expect(done1.status).toBe("REVIEW_REQUIRED"); // the run itself still completed on its allowed call

    // ---- (c) revoke the child's lease mid-run: the next call is denied despite the cached call; the child fails visibly
    const rev = await assign(REVOKE, G);
    expect(rev.r.status).toBe(200);
    const done2 = await runUntil(rev.id, finished);
    const t2 = await taskOf(rev.id);
    const revKid = (
      await q<{ id: string; status: string; result: { reasonCode?: string } }>(
        env,
        env.tenantId,
        "SELECT id, status, result FROM tasks WHERE run_id=$1 AND depth>0",
        [t2.runId],
      )
    )[0]!;
    expect(revoked).toBeGreaterThanOrEqual(1);
    const rinv = await kq<{ capability: string; state: string; reason_code: string | null }>(
      "SELECT capability, state, reason_code FROM tool_invocations WHERE actor_id=$1 AND capability='research.run_model@1' ORDER BY started_at",
      [revKid.id],
    );
    expect(rinv.map((r) => r.state)).toEqual(["ok", "blocked", "blocked"]); // exactly 1 execution before revocation
    expect(rinv.slice(1).every((r) => r.reason_code === "TOOL_NOT_GRANTED")).toBe(true);
    const leases = await kq<{ n: string }>(
      "SELECT count(*)::text n FROM capability_leases WHERE holder_actor_id=$1 AND revoked_at IS NOT NULL",
      [revKid.id],
    );
    expect(Number(leases[0]!.n)).toBeGreaterThanOrEqual(1);
    expect(revKid.status).toMatch(/FAILED|CANCELLED/);
    expect(revKid.result.reasonCode).toBe("LEASE_REVOKED");
    expect(done2.status).not.toBe("REVIEW_REQUIRED"); // visible non-success
    expect(done2.reasonCode).toBeTruthy();
    expect(done2.linkedEvidenceIds).toEqual([]);

    // ---- (d) a child that exceeds its budget is blocked at the cap with a cost and audit record
    const over = await assign("A05-over", G);
    expect(over.r.status).toBe(200);
    const done3 = await runUntil(over.id, finished);
    const t3 = await taskOf(over.id);
    const overRun = (
      await q<{ state: string; failure: { reasonCode: string } | null }>(
        env,
        env.tenantId,
        "SELECT state, failure FROM runs WHERE id=$1",
        [t3.runId],
      )
    )[0]!;
    expect(overRun.state).toBe("BLOCKED");
    expect(overRun.failure?.reasonCode).toBe("BUDGET_EXCEEDED");
    const bAudit = await q<{
      detail: { reserved: { tokens: number }; spent: { tokens: number }; attempted: { tokens: number } };
    }>(env, env.tenantId, "SELECT detail FROM agent_audit WHERE run_id=$1 AND kind='budget.exceeded'", [
      t3.runId,
    ]);
    expect(bAudit).toHaveLength(1);
    const RESERVED = 200; // the child's own reservation in the A05-over plan
    const charged = Number(
      (
        await q<{ n: string }>(
          env,
          env.tenantId,
          "SELECT coalesce(sum(tokens),0)::text n FROM budget_ledger WHERE run_id=$1 AND kind='charge'",
          [t3.runId],
        )
      )[0]!.n,
    );
    const IN_FLIGHT = 150; // one decide turn, recorded explicitly
    expect(charged).toBeLessThanOrEqual(RESERVED + IN_FLIGHT);
    expect(bAudit[0]!.detail.reserved.tokens).toBe(RESERVED);
    expect(done3.status).not.toBe("REVIEW_REQUIRED");
    expect(done3.reasonCode).toBe("BUDGET_EXCEEDED");

    // ---- (e) depth and fan-out stay within 3 and 6 on the marker path (spawn storm through the marker)
    const storm = await assign("A12-storm", G);
    expect(storm.r.status).toBe(200);
    let maxActive = 0;
    let stop = false;
    const sampler = (async () => {
      while (!stop) {
        const r = await q<{ n: string }>(
          env,
          env.tenantId,
          "SELECT count(*)::text n FROM tasks WHERE workspace_id=$1 AND depth>=1 AND status IN ('QUEUED','RUNNING','WAITING_APPROVAL')",
          [ws()],
        );
        maxActive = Math.max(maxActive, Number(r[0]!.n));
        await new Promise((res) => setTimeout(res, 25));
      }
    })();
    const done4 = await runUntil(storm.id, finished).catch((e) => {
      throw e;
    });
    stop = true;
    await sampler;
    const t4 = await taskOf(storm.id);
    const depth = (
      await q<{ d: number; n: string }>(
        env,
        env.tenantId,
        "SELECT max(depth) d, count(*)::text n FROM tasks WHERE run_id=$1",
        [t4.runId],
      )
    )[0]!;
    expect(depth.d).toBeLessThanOrEqual(3);
    expect(maxActive).toBeLessThanOrEqual(6);
    const rejectedLimits = await q<{ reason_code: string }>(
      env,
      env.tenantId,
      "SELECT reason_code FROM agent_audit WHERE run_id=$1 AND kind='limit.rejected'",
      [t4.runId],
    );

    observe({
      testId: "M12",
      observed: `Editor scope G=[${G.join(", ")}]. (a) Assigning G + registry.read@1 was REJECTED 403 DELEGATION_EXPANSION_DENIED (choice: reject, never clip), audited as access.denied, 0 tasks, 0 runs; the accepted assignment recorded exactly G; control: the owner's unbounded scope accepted the same request and the subset check flagged the superset. (b) The child's call to registry.read@1 (outside its grant) was denied (runtime audit: ${denied.map((d) => d.kind + "/" + d.reasonCode).join(", ")}; kernel audit rows ${kaudit.length}) with 0 executions; the allowed call ran and the marker reached REVIEW_REQUIRED. (c) After the kernel revoked the child's lease (${revoked} leases) the cached call was denied twice (tool_invocations ok/blocked/blocked), the child ended ${revKid.status} with reason_code LEASE_REVOKED and the marker kept status ${done2.status} with reason_code ${done2.reasonCode}, 0 evidence. (d) The over-spending child was blocked: run BLOCKED BUDGET_EXCEEDED, 1 budget.exceeded audit (reserved ${bAudit[0]!.detail.reserved.tokens}, attempted ${bAudit[0]!.detail.attempted.tokens}), charged ${charged} tokens <= reservation ${RESERVED} + 1 in-flight ${IN_FLIGHT}; marker reason_code ${done3.reasonCode}. (e) Spawn storm via a marker: max task depth ${depth.d} (<= 3), max concurrent children ${maxActive} (<= 6), limit.rejected audits ${rejectedLimits.length}; marker ${done4.status}/${done4.reasonCode}`,
      fixtureHash: hashOf({ grants: G, scenarios: [EXPAND, REVOKE, "A05-over", "A12-storm"] }),
      evidence: {
        grants: G,
        expansion: {
          status: tooMany.status,
          reasonCode: (tooMany.json as { reasonCode: string }).reasonCode,
          auditRows: denialAudit.length,
          control: { recordedGrants: ctlGrants, subsetOfG: isSubset(ctlGrants, G) },
        },
        outOfScope: denied,
        revocation: {
          revokedLeases: revoked,
          invocations: rinv,
          childStatus: revKid.status,
          childReason: revKid.result.reasonCode,
          marker: done2,
        },
        budget: {
          runState: overRun.state,
          failure: overRun.failure,
          audit: bAudit[0]!.detail,
          charged,
          reserved: RESERVED,
          inFlight: IN_FLIGHT,
          marker: done3,
        },
        limits: {
          maxDepth: depth.d,
          maxConcurrentChildren: maxActive,
          tasksInRun: depth.n,
          limitRejections: rejectedLimits.map((r) => r.reason_code),
          marker: done4,
        },
        notes: [
          "The assigner's grant set G is checked at assignment and recorded on the task and delegation chain. The runtime derives a child's leases from its role allowlist; narrowing a run's leases to G needs a grants field on the run submission (queue entry), so (b) shows the kernel lease boundary of the child's role, not G itself.",
          "The scripted model chooses to abort after the revoked-lease denials (a real model also stops); the denials, the audit and the revocation are product behaviour.",
          "Budget B in (d) is the child's own reservation (200 tokens) in the A05-over plan; the marker budget caps the run total.",
        ],
        engine: "real Temporal worker with the deterministic ScriptedProvider (not a live model)",
      },
    });
  } finally {
    await w.stop();
  }
}, 900_000);
