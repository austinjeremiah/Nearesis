import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunBudgetUsage, RunListResponse, SourceListResponse } from "@nearesis/contracts";
import { apiFixture, bearer, login, sansTrace, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

let f: ApiFixture;
let alice: string;
let vic: string;
let bob: string;
let orgA: string;
let wsA: string;
let wsB: string;
let wsEmpty: string;

const get = (tok: string | null, url: string) => f.app.inject({ url, headers: tok ? bearer(tok) : {} });
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

async function seedRun(
  workspaceId: string,
  o: { state: string; objective?: string; budget?: [number, number, number]; created?: string },
) {
  const runId = randomUUID();
  const budgetId = randomUUID();
  const [t, c, u] = o.budget ?? [1000, 10, 2];
  await f.db.admin.query(
    "INSERT INTO runtime.budgets(id, tenant_id, workspace_id, tokens_total, tool_calls_total, usd_total) VALUES ($1,$2,$3,$4,$5,$6)",
    [budgetId, orgA, workspaceId, t, c, u],
  );
  await f.db.admin.query(
    `INSERT INTO runtime.runs(id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state, created_at)
     VALUES ($1,$2,$3,$4,$5,'live',$6,$7,$8,$9)`,
    [
      runId,
      orgA,
      workspaceId,
      randomUUID(),
      randomUUID(),
      budgetId,
      `wf-${runId}`,
      o.state,
      o.created ?? new Date().toISOString(),
    ],
  );
  await f.db.admin.query(
    `INSERT INTO runtime.tasks(id, tenant_id, workspace_id, run_id, role, depth, dedup_hash, dedup_key, hypothesis_id, status, objective)
     VALUES ($1,$2,$3,$4,'director',0,$5,'{}'::jsonb,'h1','RUNNING',$6)`,
    [randomUUID(), orgA, workspaceId, runId, randomUUID(), o.objective ?? null],
  );
  return { runId, budgetId };
}
const ledger = (runId: string, budgetId: string, kind: string, t: number, c: number, u: number) =>
  f.db.admin.query(
    `INSERT INTO runtime.budget_ledger(tenant_id, workspace_id, budget_id, run_id, entry_key, kind, tokens, tool_calls, usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [orgA, wsA, budgetId, runId, randomUUID(), kind, t, c, u],
  );

beforeAll(async () => {
  f = await apiFixture({ runtime: true });
  const a = await seedOrg(f.db.admin, "ui", { alice: "owner", vic: "viewer" });
  const b = await seedOrg(f.db.admin, "ui2", { bob: "owner" });
  orgA = a.orgId;
  alice = await login(f.app, a.users.alice!.subject);
  vic = await login(f.app, a.users.vic!.subject);
  bob = await login(f.app, b.users.bob!.subject);
  wsA = await create(alice, "create-ui-a1");
  wsEmpty = await create(alice, "create-ui-a2");
  wsB = await create(bob, "create-ui-b1");
});
afterAll(async () => f?.close());

describe("GET /v1/workspaces/:id/runs", () => {
  it("lists investigations newest first with question summary, state and start time", async () => {
    await seedRun(wsA, { state: "COMPLETE", objective: "older question", created: "2026-11-01T10:00:00Z" });
    const newer = await seedRun(wsA, { state: "APPROVAL_NEEDED", objective: "Why did fees spike?" });
    const r = await get(vic, `/v1/workspaces/${wsA}/runs`);
    expect(r.statusCode).toBe(200);
    const body = RunListResponse.parse(r.json());
    expect(body.runs.map((x) => x.questionSummary)).toEqual(["Why did fees spike?", "older question"]);
    expect(body.runs[0]).toMatchObject({ runId: newer.runId, state: "APPROVAL_NEEDED", terminal: false });
    expect(body.runs[1]).toMatchObject({ state: "COMPLETE", terminal: true });
  });
  it("is empty for a workspace with no runs", async () => {
    expect(RunListResponse.parse((await get(alice, `/v1/workspaces/${wsEmpty}/runs`)).json()).runs).toEqual(
      [],
    );
  });
  it("ACL: unauthenticated 401, foreign and unknown and malformed are the same 404", async () => {
    expect((await get(null, `/v1/workspaces/${wsA}/runs`)).statusCode).toBe(401);
    const foreign = await get(bob, `/v1/workspaces/${wsA}/runs`);
    const unknown = await get(bob, `/v1/workspaces/${randomUUID()}/runs`);
    const malformed = await get(bob, `/v1/workspaces/nope/runs`);
    expect([foreign.statusCode, unknown.statusCode, malformed.statusCode]).toEqual([404, 404, 404]);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
    // org B's own workspace shows none of org A's runs
    expect(RunListResponse.parse((await get(bob, `/v1/workspaces/${wsB}/runs`)).json()).runs).toEqual([]);
  });
});

describe("GET /v1/workspaces/:id/sources", () => {
  it("returns an empty typed list for members (no watermark view in the API, see FND-20261110-041)", async () => {
    const r = await get(vic, `/v1/workspaces/${wsA}/sources`);
    expect(r.statusCode).toBe(200);
    expect(SourceListResponse.parse(r.json()).sources).toEqual([]);
  });
  it("ACL: unauthenticated 401, foreign and unknown the same 404", async () => {
    expect((await get(null, `/v1/workspaces/${wsA}/sources`)).statusCode).toBe(401);
    const foreign = await get(bob, `/v1/workspaces/${wsA}/sources`);
    const unknown = await get(bob, `/v1/workspaces/${randomUUID()}/sources`);
    expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
  });
});

describe("GET /v1/runs/:id budget usage", () => {
  it("reports total, spent (charges) and open reservations from the ledger", async () => {
    const run = await seedRun(wsA, { state: "EXECUTING", budget: [60000, 16, 1] });
    await ledger(run.runId, run.budgetId, "reserve", 12000, 6, 0.5);
    await ledger(run.runId, run.budgetId, "charge", 4000, 2, 0.1);
    await ledger(run.runId, run.budgetId, "release", 2000, 1, 0.1);
    const r = await get(vic, `/v1/runs/${run.runId}`);
    expect(r.statusCode).toBe(200);
    const u = RunBudgetUsage.parse((r.json() as { budget: unknown }).budget);
    expect(u.total).toEqual({ tokens: 60000, toolCalls: 16, usd: 1 });
    expect(u.spent).toEqual({ tokens: 4000, toolCalls: 2, usd: 0.1 });
    expect(u.reserved).toEqual({ tokens: 10000, toolCalls: 5, usd: 0.4 });
  });
  it("is zero spend with no ledger rows, and unchanged 404 for a foreign run", async () => {
    const run = await seedRun(wsA, { state: "REQUESTED" });
    const u = RunBudgetUsage.parse(
      ((await get(alice, `/v1/runs/${run.runId}`)).json() as { budget: unknown }).budget,
    );
    expect(u.spent).toEqual({ tokens: 0, toolCalls: 0, usd: 0 });
    expect((await get(bob, `/v1/runs/${run.runId}`)).statusCode).toBe(404);
  });
});
