import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorResponse } from "@nearesis/contracts";
import { apiFixture, bearer, login, sansTrace, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import type { InvestigationEngine } from "../src/runs.ts";

interface Started {
  runId: string;
  workspaceId: string;
  tenantId: string;
  budgetId: string;
  question: string;
  snapshotRef: string;
  investigationId: string;
  questionId: string;
}
class FakeEngine implements InvestigationEngine {
  starts: Started[] = [];
  signals: Array<{ workflowId: string; name: string; payload: Record<string, unknown> }> = [];
  failStart = false;
  failSignal: string | null = null;
  private seen = new Set<string>();
  async start(i: Started) {
    if (this.failStart) throw new Error("temporal down");
    const workflowId = `investigation-${i.investigationId}-${i.questionId}`;
    if (this.seen.has(workflowId)) {
      const e = new Error("already started");
      e.name = "WorkflowExecutionAlreadyStartedError";
      throw e;
    }
    this.seen.add(workflowId);
    this.starts.push(i);
    return { runId: i.runId, workflowId };
  }
  async signal(workflowId: string, name: "approve" | "reject" | "cancel", payload: Record<string, unknown>) {
    if (this.failSignal) {
      const e = new Error("x");
      e.name = this.failSignal;
      throw e;
    }
    this.signals.push({ workflowId, name, payload });
  }
}

let f: ApiFixture;
const engine = new FakeEngine();
let alice: string;
let ana: string;
let vic: string;
let bob: string;
let orgA: string;
let orgB: string;
let aliceId: string;
let wsA: string;
let wsB: string;

const create = async (tok: string, key: string) =>
  (
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(tok), "idempotency-key": key },
        payload: { objective: "o", networkScope: "fixture-only" },
      })
    ).json() as { workspaceId: string }
  ).workspaceId;

beforeAll(async () => {
  f = await apiFixture({ runtime: true, engine });
  const a = await seedOrg(f.db.admin, "rn", { alice: "owner", ana: "analyst", vic: "viewer" });
  const b = await seedOrg(f.db.admin, "rn2", { bob: "owner" });
  orgA = a.orgId;
  orgB = b.orgId;
  aliceId = a.users.alice!.userId;
  alice = await login(f.app, a.users.alice!.subject);
  ana = await login(f.app, a.users.ana!.subject);
  vic = await login(f.app, a.users.vic!.subject);
  bob = await login(f.app, b.users.bob!.subject);
  wsA = await create(alice, "create-runs-a1");
  wsB = await create(bob, "create-runs-b1");
});
afterAll(async () => f?.close());

const q = {
  question: "Why did fees spike?",
  snapshotPolicy: "live",
  budget: { tokens: 5000, toolCalls: 8, usd: 1 },
};
const post = (tok: string | null, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  f.app.inject({
    method: "POST",
    url,
    headers: { ...(tok ? bearer(tok) : {}), ...headers },
    payload: payload as never,
  });
const get = (tok: string | null, url: string) => f.app.inject({ url, headers: tok ? bearer(tok) : {} });

/** Seed a run directly (A6 owns the writer; the API only reads). */
async function seedRun(
  tenant: string,
  workspaceId: string,
  o: { state?: string; events?: Array<{ kind: string; detail: object }> } = {},
) {
  const runId = randomUUID();
  const wf = `investigation-${randomUUID()}-${randomUUID()}`;
  await f.db.admin.query(
    `INSERT INTO runtime.runs(id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state, failure)
     VALUES ($1,$2,$3,$4,$5,'live',$6,$7,$8,$9)`,
    [
      runId,
      tenant,
      workspaceId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      wf,
      o.state ?? "EXECUTING",
      o.state === "BLOCKED"
        ? JSON.stringify({ reasonCode: "APPROVAL_REJECTED", retryability: "human_action_needed" })
        : null,
    ],
  );
  const dir = randomUUID();
  const child = randomUUID();
  const task = (
    id: string,
    role: string,
    depth: number,
    status: string,
    parent: string | null,
    out: string | null,
  ) =>
    f.db.admin.query(
      `INSERT INTO runtime.tasks(id, tenant_id, workspace_id, run_id, parent_task_id, role, depth, dedup_hash, dedup_key, hypothesis_id, status, output_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb,'h1',$9,$10)`,
      [id, tenant, workspaceId, runId, parent, role, depth, randomUUID(), status, out],
    );
  await task(dir, "director", 0, "RUNNING", null, null);
  await task(child, "semantic_analyst", 1, "DONE", dir, "result:abc");
  let seq = 0;
  for (const e of o.events ?? [])
    await f.db.admin.query(
      "INSERT INTO runtime.run_events(tenant_id, run_id, source, seq, kind, detail) VALUES ($1,$2,'run',$3,$4,$5)",
      [tenant, runId, ++seq, e.kind, JSON.stringify(e.detail)],
    );
  return { runId, workflowId: wf, events: seq, childTaskId: child };
}
const eventId = async (runId: string, nth: number) =>
  String(
    (
      await f.db.admin.query(
        "SELECT id FROM runtime.run_events WHERE run_id=$1 ORDER BY seq OFFSET $2 LIMIT 1",
        [runId, nth],
      )
    ).rows[0].id,
  );

const HASH = "a".repeat(64);
const approvalRun = (extra: Array<{ kind: string; detail: object }> = []) =>
  seedRun(orgA, wsA, {
    state: "APPROVAL_NEEDED",
    events: [
      { kind: "transition", detail: {} },
      {
        kind: "approval.requested",
        detail: { actionHash: HASH, kind: "swap", network: "near-testnet", costLimit: 5 },
      },
      ...extra,
    ],
  });

describe("POST /v1/workspaces/:id/questions", () => {
  it("starts a run for a member, with server-resolved tenant and a budget row, and returns {runId, workflowId}", async () => {
    const r = await post(ana, `/v1/workspaces/${wsA}/questions`, q);
    expect(r.statusCode).toBe(202);
    const body = r.json() as { runId: string; workflowId: string };
    expect(body.workflowId).toMatch(/^investigation-/);
    const s = engine.starts.find((x) => x.runId === body.runId)!;
    expect(s).toMatchObject({ workspaceId: wsA, tenantId: orgA, question: q.question });
    expect(s.snapshotRef).toMatch(/^live:/);
    const b = (await f.db.admin.query("SELECT * FROM runtime.budgets WHERE id=$1", [s.budgetId])).rows[0];
    expect(b).toMatchObject({ tenant_id: orgA, workspace_id: wsA, tool_calls_total: 8 });
    const audit = await f.db.admin.query(
      "SELECT 1 FROM audit_events WHERE action='question.submitted' AND subject=$1",
      [body.runId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it("ignores a smuggled tenant: strict schema rejects extra fields with 422", async () => {
    const before = engine.starts.length;
    const r = await post(alice, `/v1/workspaces/${wsA}/questions`, { ...q, tenantId: orgB });
    expect(r.statusCode).toBe(422);
    expect(engine.starts.length).toBe(before);
    for (const bad of [
      { ...q, question: "" },
      { ...q, budget: { ...q.budget, toolCalls: 99 } },
      { ...q, snapshotPolicy: "x" },
    ])
      expect((await post(alice, `/v1/workspaces/${wsA}/questions`, bad)).statusCode).toBe(422);
  });

  it("ACL: unauthenticated 401, viewer 403, foreign workspace 404 identical to unknown, none start a run", async () => {
    const before = engine.starts.length;
    expect((await post(null, `/v1/workspaces/${wsA}/questions`, q)).statusCode).toBe(401);
    expect((await post(vic, `/v1/workspaces/${wsA}/questions`, q)).statusCode).toBe(403);
    const foreign = await post(bob, `/v1/workspaces/${wsA}/questions`, q);
    const unknown = await post(bob, `/v1/workspaces/${randomUUID()}/questions`, q);
    const malformed = await post(bob, `/v1/workspaces/nope/questions`, q);
    expect([foreign.statusCode, unknown.statusCode, malformed.statusCode]).toEqual([404, 404, 404]);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
    expect(sansTrace(foreign.json())).toEqual(sansTrace(malformed.json()));
    expect(engine.starts.length).toBe(before);
    const budgets = await f.db.admin.query(
      "SELECT 1 FROM runtime.budgets WHERE workspace_id=$1 AND tenant_id=$2",
      [wsA, orgB],
    );
    expect(budgets.rowCount).toBe(0);
  });

  it("an Idempotency-Key makes a retried submit return the same run without a second start", async () => {
    const h = { "idempotency-key": "question-key-0001" };
    const r1 = await post(alice, `/v1/workspaces/${wsA}/questions`, q, h);
    const n = engine.starts.length;
    const r2 = await post(alice, `/v1/workspaces/${wsA}/questions`, q, h);
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);
    expect(r2.json()).toEqual(r1.json());
    expect(engine.starts.length).toBe(n);
  });

  it("a workflow engine outage is 503 UPSTREAM_DEGRADED, retryable, without internals", async () => {
    engine.failStart = true;
    const r = await post(alice, `/v1/workspaces/${wsA}/questions`, q);
    engine.failStart = false;
    expect(r.statusCode).toBe(503);
    expect(ErrorResponse.parse(r.json())).toMatchObject({ errorCode: "UPSTREAM_DEGRADED", retryable: true });
    expect(JSON.stringify(r.json())).not.toContain("temporal down");
  });
});

describe("GET /v1/runs/:id", () => {
  it("returns state, child statuses, evidence links and failure fields to workspace members", async () => {
    const run = await seedRun(orgA, wsA, { state: "BLOCKED", events: [{ kind: "transition", detail: {} }] });
    const r = await get(vic, `/v1/runs/${run.runId}`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      runId: run.runId,
      workspaceId: wsA,
      state: "BLOCKED",
      terminal: true,
      version: 1,
      failure: { reasonCode: "APPROVAL_REJECTED", retryability: "human_action_needed" },
      rootTask: { role: "director", depth: 0 },
      children: [{ role: "semantic_analyst", status: "DONE", depth: 1 }],
      evidenceLinks: [{ taskId: run.childTaskId, outputRef: "result:abc" }],
    });
  });

  it("foreign tenants, unknown ids and malformed ids are the same 404; unauthenticated is 401", async () => {
    const run = await seedRun(orgA, wsA);
    const foreign = await get(bob, `/v1/runs/${run.runId}`);
    const unknown = await get(bob, `/v1/runs/${randomUUID()}`);
    const malformed = await get(bob, `/v1/runs/nope`);
    expect([foreign.statusCode, unknown.statusCode, malformed.statusCode]).toEqual([404, 404, 404]);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
    expect(sansTrace(foreign.json())).toEqual(sansTrace(malformed.json()));
    expect((await get(null, `/v1/runs/${run.runId}`)).statusCode).toBe(401);
    // a run of org B in org B's workspace is invisible to org A as well
    const other = await seedRun(orgB, wsB);
    expect((await get(alice, `/v1/runs/${other.runId}`)).statusCode).toBe(404);
  });
});

describe("POST /v1/runs/:id/cancel", () => {
  it("requires an expected version, rejects stale ones with the current version, and signals cancel once current", async () => {
    const run = await seedRun(orgA, wsA, {
      events: [
        { kind: "transition", detail: {} },
        { kind: "x", detail: {} },
      ],
    });
    const url = `/v1/runs/${run.runId}/cancel`;
    const missing = await post(alice, url, {});
    expect(missing.statusCode).toBe(422);
    const stale = await post(alice, url, { expectedVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(ErrorResponse.parse(stale.json())).toMatchObject({
      errorCode: "STALE_VERSION",
      lastStableRevision: 2,
    });
    expect(engine.signals.filter((s) => s.workflowId === run.workflowId)).toEqual([]);
    const ok = await post(ana, url, {}, { "if-match": "2" });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toMatchObject({
      runId: run.runId,
      cancelRequested: true,
      requestedBy: expect.any(String),
    });
    expect(engine.signals.filter((s) => s.workflowId === run.workflowId)).toEqual([
      { workflowId: run.workflowId, name: "cancel", payload: { requestedBy: expect.any(String) } },
    ]);
  });

  it("ACL: viewer 403, foreign 404 (same as unknown), terminal runs 422; none signal", async () => {
    const run = await seedRun(orgA, wsA, { events: [{ kind: "t", detail: {} }] });
    const done = await seedRun(orgA, wsA, { state: "COMPLETE", events: [{ kind: "t", detail: {} }] });
    const n = engine.signals.length;
    expect((await post(null, `/v1/runs/${run.runId}/cancel`, { expectedVersion: 1 })).statusCode).toBe(401);
    expect((await post(vic, `/v1/runs/${run.runId}/cancel`, { expectedVersion: 1 })).statusCode).toBe(403);
    const foreign = await post(bob, `/v1/runs/${run.runId}/cancel`, { expectedVersion: 1 });
    const unknown = await post(bob, `/v1/runs/${randomUUID()}/cancel`, { expectedVersion: 1 });
    expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
    const term = await post(alice, `/v1/runs/${done.runId}/cancel`, { expectedVersion: 1 });
    expect(term.statusCode).toBe(422);
    expect(engine.signals.length).toBe(n);
  });

  it("a signal to a finished workflow is a 409, and an engine outage is 503", async () => {
    const run = await seedRun(orgA, wsA, { events: [{ kind: "t", detail: {} }] });
    engine.failSignal = "WorkflowNotFoundError";
    expect((await post(alice, `/v1/runs/${run.runId}/cancel`, { expectedVersion: 1 })).statusCode).toBe(409);
    engine.failSignal = "Boom";
    expect((await post(alice, `/v1/runs/${run.runId}/cancel`, { expectedVersion: 1 })).statusCode).toBe(503);
    engine.failSignal = null;
  });
});

describe("approvals API", () => {
  it("lists the pending request with its action hash; members only", async () => {
    const run = await approvalRun();
    const r = await get(vic, `/v1/runs/${run.runId}/approvals`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      runId: run.runId,
      state: "APPROVAL_NEEDED",
      approvals: [
        { actionHash: HASH, status: "pending", kind: "swap", network: "near-testnet", costLimit: 5 },
      ],
    });
    const foreign = await get(bob, `/v1/runs/${run.runId}/approvals`);
    const unknown = await get(bob, `/v1/runs/${randomUUID()}/approvals`);
    expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
    expect((await get(null, `/v1/runs/${run.runId}/approvals`)).statusCode).toBe(401);
  });

  it("an exact action hash approves: signals the workflow with approvedBy, audits and journals it", async () => {
    const run = await approvalRun();
    const id = await eventId(run.runId, 1);
    const r = await post(ana, `/v1/runs/${run.runId}/approvals/${id}`, {
      decision: "approve",
      actionHash: HASH,
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ decision: "approve", actionHash: HASH, signalled: true });
    const sig = engine.signals.filter((s) => s.workflowId === run.workflowId);
    expect(sig).toEqual([
      {
        workflowId: run.workflowId,
        name: "approve",
        payload: { actionHash: HASH, approvedBy: expect.any(String) },
      },
    ]);
    const ev = await f.db.admin.query(
      "SELECT 1 FROM workspace_events WHERE workspace_id=$1 AND event_type='approval.granted' AND payload->>'runId'=$2",
      [wsA, run.runId],
    );
    expect(ev.rowCount).toBe(1);
    const grant = await f.db.admin.query(
      "SELECT used_at FROM command_approvals WHERE run_id=$1 AND action_hash=$2",
      [run.runId, HASH],
    );
    expect(grant.rows).toEqual([{ used_at: null }]);
    const aud = await f.db.admin.query(
      "SELECT actor_id FROM audit_events WHERE action='approval.approve' AND subject=$1",
      [run.runId],
    );
    expect(aud.rows).toHaveLength(1);
  });

  it("a mismatching hash is 409 with no signal, and the denial is audited", async () => {
    const run = await approvalRun();
    const id = await eventId(run.runId, 1);
    for (const bad of ["b".repeat(64), HASH.toUpperCase(), `${HASH} `, HASH.slice(0, 63)]) {
      const r = await post(alice, `/v1/runs/${run.runId}/approvals/${id}`, {
        decision: "approve",
        actionHash: bad,
      });
      expect(r.statusCode).toBe(409);
      expect(ErrorResponse.parse(r.json()).reasonCode).toBe("ACTION_HASH_MISMATCH");
    }
    expect(
      (
        await post(alice, `/v1/runs/${run.runId}/approvals/${id}`, {
          decision: "reject",
          actionHash: "c".repeat(64),
        })
      ).statusCode,
    ).toBe(409);
    expect(engine.signals.filter((s) => s.workflowId === run.workflowId)).toEqual([]);
    const aud = await f.db.admin.query(
      "SELECT outcome FROM audit_events WHERE action='approval.hash_mismatch' AND subject=$1",
      [run.runId],
    );
    expect(aud.rows.length).toBe(5);
    expect(aud.rows.every((x) => x.outcome === "denied")).toBe(true);
  });

  it("reject signals reject; a superseded request (modified action) cannot be decided", async () => {
    const run = await approvalRun([
      { kind: "approval.invalidated", detail: { newActionHash: "d".repeat(64), staleApprovals: 0 } },
    ]);
    const oldId = await eventId(run.runId, 1);
    const newId = await eventId(run.runId, 2);
    const list = (await get(alice, `/v1/runs/${run.runId}/approvals?status=all`)).json() as {
      approvals: Array<{ approvalId: string; status: string; actionHash: string }>;
    };
    expect(list.approvals.map((a) => a.status)).toEqual(["superseded", "pending"]);
    const stale = await post(alice, `/v1/runs/${run.runId}/approvals/${oldId}`, {
      decision: "approve",
      actionHash: HASH,
    });
    expect(stale.statusCode).toBe(409);
    expect(ErrorResponse.parse(stale.json()).reasonCode).toBe("APPROVAL_NOT_PENDING");
    expect(engine.signals.filter((s) => s.workflowId === run.workflowId)).toEqual([]);
    const rej = await post(alice, `/v1/runs/${run.runId}/approvals/${newId}`, {
      decision: "reject",
      actionHash: "d".repeat(64),
    });
    expect(rej.statusCode).toBe(202);
    expect(engine.signals.filter((s) => s.workflowId === run.workflowId)).toEqual([
      {
        workflowId: run.workflowId,
        name: "reject",
        payload: { actionHash: "d".repeat(64), rejectedBy: expect.any(String) },
      },
    ]);
    expect(aliceId).toBeTruthy();
  });

  it("ACL: viewer 403, foreign 404 same as unknown, unknown approval id 404, bad body 422; none signal", async () => {
    const run = await approvalRun();
    const id = await eventId(run.runId, 1);
    const body = { decision: "approve", actionHash: HASH };
    expect((await post(null, `/v1/runs/${run.runId}/approvals/${id}`, body)).statusCode).toBe(401);
    expect((await post(vic, `/v1/runs/${run.runId}/approvals/${id}`, body)).statusCode).toBe(403);
    const foreign = await post(bob, `/v1/runs/${run.runId}/approvals/${id}`, body);
    const unknown = await post(bob, `/v1/runs/${randomUUID()}/approvals/${id}`, body);
    expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
    expect((await post(alice, `/v1/runs/${run.runId}/approvals/999999999`, body)).statusCode).toBe(404);
    expect((await post(alice, `/v1/runs/${run.runId}/approvals/abc`, body)).statusCode).toBe(404);
    // an approval id that belongs to ANOTHER run must not be usable here
    const other = await approvalRun();
    const otherId = await eventId(other.runId, 1);
    expect((await post(alice, `/v1/runs/${run.runId}/approvals/${otherId}`, body)).statusCode).toBe(404);
    expect(
      (await post(alice, `/v1/runs/${run.runId}/approvals/${id}`, { decision: "maybe", actionHash: HASH }))
        .statusCode,
    ).toBe(422);
    expect(
      (await post(alice, `/v1/runs/${run.runId}/approvals/${id}`, { ...body, approvedBy: "x" })).statusCode,
    ).toBe(422);
    expect(
      engine.signals.filter((s) => s.workflowId === run.workflowId || s.workflowId === other.workflowId),
    ).toEqual([]);
  });

  it("a run that is no longer awaiting approval lists nothing pending and refuses decisions", async () => {
    const run = await seedRun(orgA, wsA, {
      state: "EXECUTING",
      events: [
        {
          kind: "approval.requested",
          detail: { actionHash: HASH, kind: "swap", network: "near-testnet", costLimit: 5 },
        },
      ],
    });
    expect(
      ((await get(alice, `/v1/runs/${run.runId}/approvals`)).json() as { approvals: unknown[] }).approvals,
    ).toEqual([]);
    const id = await eventId(run.runId, 0);
    expect(
      (await post(alice, `/v1/runs/${run.runId}/approvals/${id}`, { decision: "approve", actionHash: HASH }))
        .statusCode,
    ).toBe(409);
    expect(engine.signals.filter((s) => s.workflowId === run.workflowId)).toEqual([]);
  });
});
