/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsdCreditsService } from "@nearesis/kernel";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import type { InvestigationEngine } from "../src/runs.ts";

class FakeEngine implements InvestigationEngine {
  starts: Array<{ runId: string; budgetId: string }> = [];
  async start(i: { runId: string; investigationId: string; questionId: string; budgetId: string }) {
    this.starts.push(i);
    return { runId: i.runId, workflowId: `investigation-${i.investigationId}-${i.questionId}` };
  }
  async signal() {
    /* not used */
  }
}

let f: ApiFixture;
const engine = new FakeEngine();
let orgId: string;
let alice: string;
let aliceId: string;
let bob: string;
let bobId: string;
let ws: string;
let wsBob: string;
let svc: UsdCreditsService;
const post = (tok: string, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  f.app.inject({ method: "POST", url, headers: { ...bearer(tok), ...headers }, payload: payload as never });
const credits = async (tok: string) =>
  (await f.app.inject({ method: "GET", url: "/v1/credits", headers: bearer(tok) })).json() as Record<
    string,
    any
  >;

/** A run row plus the budget-ledger charges the runtime wrote for it (the actual model USD). */
async function seedRun(o: {
  tenant?: string;
  workspace?: string;
  requestedBy: string | null;
  state: string;
  charges: number[];
  interpretation?: boolean;
  ageMinutes?: number;
  createdBefore?: boolean;
}) {
  const runId = randomUUID();
  const budgetId = randomUUID();
  const tenant = o.tenant ?? orgId;
  const workspace = o.workspace ?? ws;
  await f.db.admin.query(
    `INSERT INTO runtime.budgets(id, tenant_id, workspace_id, tokens_total, tool_calls_total, usd_total) VALUES ($1,$2,$3,100000,20,3)`,
    [budgetId, tenant, workspace],
  );
  await f.db.admin.query(
    `INSERT INTO runtime.runs(id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state, requested_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'live',$6,$7,$8,$9, now() - ($10 || ' minutes')::interval, now() - ($11 || ' minutes')::interval)`,
    [
      runId,
      tenant,
      workspace,
      randomUUID(),
      randomUUID(),
      budgetId,
      `wf-${runId}`,
      o.state,
      o.requestedBy,
      o.createdBefore ? "100000000" : "0",
      String(o.ageMinutes ?? 0),
    ],
  );
  for (const [i, usd] of o.charges.entries())
    await f.db.admin.query(
      `INSERT INTO runtime.budget_ledger(tenant_id, workspace_id, budget_id, run_id, entry_key, kind, tokens, usd) VALUES ($1,$2,$3,$4,$5,'charge',100,$6)`,
      [tenant, workspace, budgetId, runId, `charge:${runId}:${i}`, usd],
    );
  if (o.interpretation)
    await f.db.admin.query(
      `INSERT INTO runtime.run_interpretation(run_id, tenant_id, workspace_id, state) VALUES ($1,$2,$3,'ready')`,
      [runId, tenant, workspace],
    );
  return runId;
}

beforeAll(async () => {
  f = await apiFixture({ runtime: true, engine, appOptions: { nearUsdRate: async () => null } });
  const a = await seedOrg(f.db.admin, "uc", { alice: "owner", bob: "owner" });
  orgId = a.orgId;
  aliceId = a.users.alice!.userId;
  bobId = a.users.bob!.userId;
  alice = await login(f.app, a.users.alice!.subject);
  bob = await login(f.app, a.users.bob!.subject);
  const mk = async (tok: string, key: string) =>
    (
      (
        await post(
          tok,
          "/v1/workspaces",
          { objective: "o", networkScope: "fixture-only" },
          { "idempotency-key": key },
        )
      ).json() as { workspaceId: string }
    ).workspaceId;
  ws = await mk(alice, "uc-ws-0000001");
  wsBob = await mk(bob, "uc-ws-0000002");
  svc = new UsdCreditsService(f.db.app);
}, 60_000);
afterAll(async () => f?.close());

describe("model spend of runs is charged to the user who started them, once", () => {
  it("charges the exact recorded USD of a finished run when credits are read, and never again", async () => {
    const before = await credits(alice);
    expect(before.byCategory.modelUsd).toBe("0.000000");
    const runId = await seedRun({ requestedBy: aliceId, state: "PARTIAL", charges: [0.25, 0.1234565] });
    const c1 = await credits(alice);
    expect(c1.byCategory.modelUsd).toBe("0.373457"); // 0.3734565 rounded up to a micro-USD
    expect(c1.spentUsd).toBe("0.373457");
    expect(c1.availableUsd).toBe("2.626543");
    const e = c1.entries[0];
    expect(e).toMatchObject({
      kind: "charge",
      category: "model",
      refKind: "run",
      refId: runId,
      amountUsd: "0.373457",
    });
    // reading again, /v1/me, a second reconcile and a "restarted" service all leave it at one charge
    await credits(alice);
    await f.app.inject({ method: "GET", url: "/v1/me", headers: bearer(alice) });
    expect(await svc.reconcileRuns()).toEqual({ charged: 0 });
    expect(await new UsdCreditsService(f.db.app).reconcileRuns(aliceId)).toEqual({ charged: 0 });
    const c2 = await credits(alice);
    expect(c2.spentUsd).toBe("0.373457");
    expect(c2.entries.filter((x: any) => x.refId === runId && x.kind === "charge")).toHaveLength(1);
  });

  it("restart path: runs that finished while no API was watching are charged by the startup reconcile, to their own users", async () => {
    const r1 = await seedRun({
      requestedBy: bobId,
      state: "COMPLETE",
      charges: [0.5],
      interpretation: true,
      tenant: orgId,
      workspace: wsBob,
    });
    const r2 = await seedRun({ requestedBy: bobId, state: "CANCELLED", charges: [0.01], workspace: wsBob });
    const r3 = await seedRun({
      requestedBy: bobId,
      state: "COMPLETE",
      charges: [0.02],
      ageMinutes: 20,
      workspace: wsBob,
    });
    const startup = new UsdCreditsService(f.db.app); // a new process: no memory of earlier charges
    expect((await startup.reconcileRuns()).charged).toBe(3);
    expect((await startup.reconcileRuns()).charged).toBe(0);
    const c = await credits(bob);
    expect(c.byCategory.modelUsd).toBe("0.530000");
    for (const id of [r1, r2, r3]) expect(c.entries.some((x: any) => x.refId === id)).toBe(true);
    // alice was not charged for bob's runs
    expect((await credits(alice)).byCategory.modelUsd).toBe("0.373457");
  });

  it("does not charge runs still in flight, a fresh COMPLETE run still being interpreted, runs without a requester, runs from before credits, or zero spend", async () => {
    const before = (await credits(alice)).spentUsd;
    await seedRun({ requestedBy: aliceId, state: "EXECUTING", charges: [0.2] });
    await seedRun({ requestedBy: aliceId, state: "COMPLETE", charges: [0.2], ageMinutes: 1 });
    await seedRun({ requestedBy: null, state: "COMPLETE", charges: [0.2], interpretation: true });
    await seedRun({
      requestedBy: aliceId,
      state: "COMPLETE",
      charges: [0.2],
      interpretation: true,
      createdBefore: true,
    });
    await seedRun({ requestedBy: aliceId, state: "BLOCKED", charges: [] });
    expect((await credits(alice)).spentUsd).toBe(before);
  });

  it("a run whose spend is above the user's available credits charges what is left and records the shortfall", async () => {
    const carol = await seedOrg(f.db.admin, "uc3", { carol: "owner" });
    const carolId = carol.users.carol!.userId;
    const tok = await login(f.app, carol.users.carol!.subject);
    const wsC = (
      (
        await post(
          tok,
          "/v1/workspaces",
          { objective: "o", networkScope: "fixture-only" },
          { "idempotency-key": "uc-ws-0000003" },
        )
      ).json() as any
    ).workspaceId;
    const runId = await seedRun({
      requestedBy: carolId,
      state: "PARTIAL",
      charges: [3.5],
      tenant: carol.orgId,
      workspace: wsC,
    });
    const c = await credits(tok);
    expect(c).toMatchObject({ spentUsd: "3.000000", availableUsd: "0.000000", exhausted: true });
    const e = c.entries.find((x: any) => x.refId === runId);
    expect(e.amountUsd).toBe("3.000000");
    expect(e.detail.shortfallUsd).toBe("0.500000");
  });
});

describe("POST /v1/workspaces/:id/questions is gated by credits", () => {
  const q = {
    question: "Why did fees spike?",
    snapshotPolicy: "live",
    budget: { tokens: 200000, toolCalls: 12, usd: 10 },
  };
  it("starts with credits and caps a larger run budget (never below the runtime minimum)", async () => {
    const r = await post(alice, `/v1/workspaces/${ws}/questions`, q, {
      "idempotency-key": "uc-question-0001",
    });
    expect(r.statusCode).toBe(202);
    const started = engine.starts.at(-1)!;
    const b = (
      await f.db.admin.query("SELECT usd_total::float8 AS u FROM runtime.budgets WHERE id=$1", [
        started.budgetId,
      ])
    ).rows[0];
    // 10 asked, 2.626543 left: capped, but never below the USD 3 minimum the runtime must reserve
    expect(b.u).toBe(3);
  });
  it("refuses with 402 CREDITS_EXHAUSTED at zero and starts nothing", async () => {
    const carol = await seedOrg(f.db.admin, "uc4", { dave: "owner" });
    const tok = await login(f.app, carol.users.dave!.subject);
    const wsD = (
      (
        await post(
          tok,
          "/v1/workspaces",
          { objective: "o", networkScope: "fixture-only" },
          { "idempotency-key": "uc-ws-0000004" },
        )
      ).json() as any
    ).workspaceId;
    await svc.charge({ orgId: carol.orgId, userId: carol.users.dave!.userId }, 3_000_000n, {
      refKind: "run",
      refId: "earlier",
      category: "model",
    });
    const n = engine.starts.length;
    const r = await post(tok, `/v1/workspaces/${wsD}/questions`, q, {
      "idempotency-key": "uc-question-0002",
    });
    expect(r.statusCode).toBe(402);
    expect(r.json()).toMatchObject({
      errorCode: "BUDGET_EXCEEDED",
      reasonCode: "CREDITS_EXHAUSTED",
      message: "You have used your credits. Write to connect@kaushikh.xyz to request more access.",
      details: {
        allowanceUsd: "3.000000",
        spentUsd: "3.000000",
        availableUsd: "0.000000",
        requiredUsd: null,
        contactEmail: "connect@kaushikh.xyz",
      },
    });
    expect(engine.starts.length).toBe(n);
  });
});
