import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnalyticsPanelData } from "@nearesis/contracts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import type { PanelDataPort, StoredQuery } from "../src/panel-data.ts";
import { emptyPlan, planFromPlanner, testPlanSha } from "../src/agent/test-plan.ts";
import type { TaskTestPlan } from "../src/agent/test-plan.ts";

const day = (i: number): string =>
  new Date(Date.parse("2026-08-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
const wave = (i: number): number => 1000 + i * 10 + Math.round(40 * Math.sin(i / 3));
const H = (c: string) => c.repeat(64);

const body = (hash: string, columns: string[], rows: unknown[][]): AnalyticsPanelData =>
  ({
    chart: {
      queryHash: hash,
      dataRevision: 1,
      columns: columns.map((name) => ({ name, unit: name === "period" ? null : "unit" })),
      rows,
      downsampling: { method: "none", originalPoints: rows.length },
      freshness: "fresh",
      sourceWatermark: "2026-11-12",
    },
    shape: {
      queryHash: hash,
      fields: columns.map((name, i) => ({ name, unit: null, role: i === 0 ? "time" : "measure" })),
    },
    provenance: {
      queryHash: hash,
      sourceLabel: "ANALYTICS",
      certification: "SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC",
      capability: "intents.analyze@1",
      analysis: "trend",
      call: { capability: "intents.analyze@1", input: { analysis: "trend" } },
      resultHash: "c".repeat(64),
      sources: ["nearesis_live.intents_swaps"],
      metricVersion: "intents-1.0.0",
      definition: "d",
      method: "m",
      asOf: "2026-11-12",
      computedAt: "2026-11-13T00:00:00.000Z",
      coverage: {
        state: "complete",
        daysRequested: 70,
        daysWithData: 70,
        missingDays: [],
        incompleteDays: [],
      },
      caveats: [],
    },
    cannotCompute: null,
    truncated: false,
  }) as unknown as AnalyticsPanelData;

const idx = (n: number) => Array.from({ length: n }, (_, i) => i);
const PANELS: Record<string, AnalyticsPanelData> = {
  [H("a")]: body(
    H("a"),
    ["period", "swaps"],
    idx(70).map((i) => [day(i), wave(i)]),
  ),
  [H("b")]: body(
    H("b"),
    ["period", "volumeUsd"],
    idx(70).map((i) => [day(i), 5000 + 3 * wave(i) + (i % 3)]),
  ),
  // the same y with a small revision: same verdict, same window, different numbers
  [H("c")]: body(
    H("c"),
    ["period", "volumeUsd"],
    idx(70).map((i) => [day(i), 5000 + 3 * wave(i) + (i % 3) + (i === 69 ? 7 : 0)]),
  ),
  [H("d")]: body(
    H("d"),
    ["period", "newWallets"],
    idx(70).map((i) => [day(i), 500 + ((i * 37) % 17) * 20]),
  ),
  [H("e")]: body(
    H("e"),
    ["period", "swaps"],
    idx(12).map((i) => [day(i), 100 + i * 3 + (i % 4)]),
  ),
  [H("f")]: body(
    H("f"),
    ["period", "rate"],
    idx(12).map((i) => [day(i), (0.02 + (i % 5) * 0.001).toFixed(3)]),
  ),
  [H("g")]: body(
    H("g"),
    ["period", "swaps"],
    idx(12).map((i) => [day(i), 100 + i]),
  ),
};
// per-test overrides of what the "data service" answers now (a correction, another series, an outage)
const NOW: Record<string, AnalyticsPanelData> = {};
const DOWN = new Set<string>();
const fakePort: PanelDataPort = {
  async stored(hash): Promise<StoredQuery | null> {
    return PANELS[hash] ? { kind: "analytics", ast: { kind: "analytics_call" } } : null;
  },
  async query() {
    throw new Error("not used");
  },
  async estimate() {
    throw new Error("not used");
  },
  registry: () => {
    throw new Error("not used");
  },
  async analytics(hash) {
    if (DOWN.has(hash))
      return { status: 503, body: { reasonCode: "SOURCE_UNAVAILABLE", message: "down" } } as never;
    return { status: 200, body: NOW[hash] ?? PANELS[hash]! };
  },
  async close() {},
};

let f: ApiFixture;
let root: string;
let orgA: string;
let aliceId: string;
let wsA: string;
let wsB: string;
let wsC: string;
let alice: string;
let bob: string;
let runSupported: string;
let runNot: string;
let runOne: string;
const post = (tok: string | null, url: string, payload: unknown = {}) =>
  f.app.inject({ method: "POST", url, headers: tok ? bearer(tok) : {}, payload: payload as object });
const get = (tok: string | null, url: string) => f.app.inject({ url, headers: tok ? bearer(tok) : {} });

async function seedRun(
  orgId: string,
  workspaceId: string,
  hashes: string[],
  o: { state?: string; findings?: boolean } = {},
) {
  const runId = randomUUID();
  const budgetId = randomUUID();
  const q = (s: string, p: unknown[]) => f.db.admin.query(s, p);
  await q(
    "INSERT INTO runtime.budgets(id, tenant_id, workspace_id, tokens_total, tool_calls_total, usd_total) VALUES ($1,$2,$3,1000,10,2)",
    [budgetId, orgId, workspaceId],
  );
  await q(
    `INSERT INTO runtime.runs(id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state, source)
     VALUES ($1,$2,$3,$4,$5,'live',$6,$7,$8,'live')`,
    [runId, orgId, workspaceId, randomUUID(), randomUUID(), budgetId, `wf-${runId}`, o.state ?? "COMPLETE"],
  );
  await q(
    `INSERT INTO runtime.tasks(id, tenant_id, workspace_id, run_id, role, depth, dedup_hash, dedup_key, hypothesis_id, status, objective, result)
     VALUES ($1,$2,$3,$4,'composer',1,$5,'{}'::jsonb,'h1','DONE','Do swaps follow volume?',$6)`,
    [
      randomUUID(),
      orgId,
      workspaceId,
      runId,
      randomUUID(),
      JSON.stringify({
        result: {
          proposal: {
            patch: {
              operations: hashes.map((h, i) => ({
                op: "addPanel",
                panel: {
                  panelId: randomUUID(),
                  title: `Panel ${i}`,
                  queryRef: { hash: h, resultKind: "analytics_result" },
                },
              })),
            },
          },
        },
      }),
    ],
  );
  await q(
    "INSERT INTO runtime.run_interpretation(run_id, tenant_id, workspace_id, state, finding_count) VALUES ($1,$2,$3,$4,$5)",
    [runId, orgId, workspaceId, "ready", 2],
  );
  const fin = (status: string, statement: string, notes: string[]) =>
    JSON.stringify({
      id: randomUUID(),
      workspaceId,
      runId,
      agentRole: "analyst",
      status,
      kind: "change",
      basis: "observation",
      statement,
      facts: [
        {
          value: String(wave(0)),
          unit: "swaps",
          resultRef: {
            column: "swaps",
            rowIds: [day(0)],
            queryHash: hashes[0],
            semanticVersion: "intents-1.0.0",
          },
        },
        {
          value: String(wave(69)),
          unit: "swaps",
          resultRef: {
            column: "swaps",
            rowIds: [day(69)],
            queryHash: hashes[0],
            semanticVersion: "intents-1.0.0",
          },
        },
      ],
      limitations: ["The window was chosen by the planner."],
      panelIds: [],
      skepticNotes: notes,
      skepticDegraded: false,
      createdAt: new Date().toISOString(),
    });
  if (o.findings !== false) {
    await q(
      "INSERT INTO runtime.run_findings(id, tenant_id, workspace_id, run_id, position, finding) VALUES ($1,$2,$3,$4,0,$5)",
      [
        randomUUID(),
        orgId,
        workspaceId,
        runId,
        fin("supported", `Daily swaps rose from ${wave(0)} to ${wave(69)} over the window.`, [
          "The rise could reflect one event.",
        ]),
      ],
    );
    await q(
      "INSERT INTO runtime.run_findings(id, tenant_id, workspace_id, run_id, position, finding) VALUES ($1,$2,$3,$4,1,$5)",
      [
        randomUUID(),
        orgId,
        workspaceId,
        runId,
        fin("mixed", `Swaps peaked at ${wave(69)} on ${day(69)}.`, ["A single peak can be a one-off."]),
      ],
    );
  }
  return runId;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "lock-caps-"));
  process.env.NEARESIS_CAPSULE_DIR = root;
  f = await apiFixture({
    runtime: true,
    appOptions: { frontend: { panelData: fakePort, capsuleRoot: () => root } },
  });
  const a = await seedOrg(f.db.admin, "lk-a", { alice: "owner" });
  const b = await seedOrg(f.db.admin, "lk-b", { bob: "owner" });
  orgA = a.orgId;
  aliceId = a.users.alice!.userId;
  alice = await login(f.app, a.users.alice!.subject);
  bob = await login(f.app, b.users.bob!.subject);
  const mk = async (tok: string, key: string) =>
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(tok), "idempotency-key": key },
        payload: { objective: "o", networkScope: "fixture-only" },
      })
    ).json<{ workspaceId: string }>().workspaceId;
  wsA = await mk(alice, "lk-ws-000000001");
  wsB = await mk(alice, "lk-ws-000000002");
  wsC = await mk(alice, "lk-ws-000000003");
  runSupported = await seedRun(orgA, wsA, [H("a"), H("b")]);
  runNot = await seedRun(orgA, wsB, [H("a"), H("b"), H("e")]);
  runOne = await seedRun(orgA, wsC, [H("a"), H("b")]);
}, 180_000);
afterAll(async () => {
  delete process.env.NEARESIS_CAPSULE_DIR;
  await f?.close();
  rmSync(root, { recursive: true, force: true });
});

const STATEMENT = "Days with higher swaps have higher volume usd.";
const test = (statement = STATEMENT) => ({
  x: { panelHash: H("a"), column: "swaps" },
  y: { panelHash: H("b"), column: "volumeUsd" },
  lagDays: 0,
  expectedSign: "positive",
  statement,
  why: "The planner named the two series in the test plan before the investigation ran, and they were matched by name.",
  chosenBy: "planner",
});
const plan = (extra: Partial<TaskTestPlan> = {}): TaskTestPlan => {
  const base = {
    ...planFromPlanner({
      statement: STATEMENT,
      xLabel: "daily swaps",
      yLabel: "volume usd",
      relation: "moves_with",
      lagDays: 0,
      expectedSign: "positive",
      windowDays: 90,
      wouldCountAsWrong: "No relation, or a lower volume on days with more swaps.",
    }),
    ...extra,
  };
  return base.statement && !("sha256" in extra) ? { ...base, sha256: testPlanSha(base) } : base;
};
/** An agent task row of the user (admin insert: the locked plan as Start would have written it). */
async function task(
  userId: string,
  workspaceId: string,
  runId: string | null,
  p: TaskTestPlan,
  tok = alice,
): Promise<string> {
  const th = await f.app.inject({
    method: "POST",
    url: "/v1/agent/threads",
    headers: bearer(tok),
    payload: {},
  });
  const threadId = th.json<{ id: string }>().id;
  const org = (
    await f.db.admin.query<{ org_id: string }>("SELECT org_id FROM agent_threads WHERE id = $1", [threadId])
  ).rows[0]!.org_id;
  return (
    await f.db.admin.query<{ id: string }>(
      `INSERT INTO agent_tasks(thread_id, org_id, user_id, workspace_id, title, state, consent_required, estimate, ctx, test_plan)
       VALUES ($1,$2,$3,$4,'t','completed','[]'::jsonb,'{"modelUsdMax":"0"}'::jsonb,$5::jsonb,$6::jsonb) RETURNING id`,
      [threadId, org, userId, workspaceId, JSON.stringify(runId ? { runId } : {}), JSON.stringify(p)],
    )
  ).rows[0]!.id;
}
const LOCKED = "2026-11-14T09:30:00.000Z";
const part = (s: { parts: Array<{ key: string; points: number; max: number }> }, key: string) =>
  s.parts.find((x) => x.key === key)!;

describe("a thesis built from a locked task plan", () => {
  let thesisId = "";
  it("doc.test.plan carries lockedAt, sha256, editedByUser, chosenBy, statement and wouldCountAsWrong; Methods says it was locked before the run", async () => {
    const p = plan({ lockedAt: LOCKED, editedByUser: true });
    const taskId = await task(aliceId, wsA, runSupported, p);
    const r = await post(alice, `/v1/workspaces/${wsA}/theses`, {
      runId: runSupported,
      test: { ...test(), chosenBy: "user" },
      planLock: { taskId },
    });
    expect(r.statusCode, r.body).toBe(201);
    thesisId = r.json().thesisId;
    const d = (await get(alice, `/v1/theses/${thesisId}`)).json();
    expect(d.doc.test.plan).toMatchObject({
      statement: STATEMENT,
      chosenBy: "user",
      lockedAt: LOCKED,
      sha256: p.sha256,
      editedByUser: true,
      wouldCountAsWrong: "No relation, or a lower volume on days with more swaps.",
      expectedSign: "positive",
      relation: "moves_with",
    });
    expect(d.doc.hypothesis).toBe(STATEMENT);
    const methods = d.doc.sections.find((s: { id: string }) => s.id === "methods").markdown as string;
    expect(methods).toContain(`was locked at ${LOCKED} (sha256 ${p.sha256}), before the investigation ran`);
    expect(methods).toContain("the user edited it");
    // the strength score awards both points
    expect(part(d.thesis.strength, "plan_locked")).toMatchObject({ points: 15, max: 15 });
    expect(part(d.thesis.strength, "valid_test")).toMatchObject({ points: 10, max: 10 });
    expect(d.thesis.strength.parts.find((x: { key: string }) => x.key === "plan_locked").detail).toContain(
      LOCKED,
    );
  });

  it("the same thesis verifies, and changing the lock time is detected on the document hash", async () => {
    expect((await post(alice, `/v1/theses/${thesisId}/verify`)).json().outcome).toBe("verified");
    await f.db.admin.query(
      "UPDATE theses SET doc = jsonb_set(doc, '{test,plan,lockedAt}', '\"2020-01-01T00:00:00.000Z\"') WHERE id = $1",
      [thesisId],
    );
    const v = (await post(alice, `/v1/theses/${thesisId}/verify`)).json();
    expect(v.outcome).toBe("mismatch");
    expect(v.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { name: string }) => c.name)).toContain(
      "documentHash",
    );
  });

  it("a planner-chosen, unedited plan says so", async () => {
    const taskId = await task(aliceId, wsC, runOne, plan({ lockedAt: LOCKED }));
    const r = await post(alice, `/v1/workspaces/${wsC}/theses`, {
      runId: runOne,
      test: test(),
      planLock: { taskId },
    });
    expect(r.statusCode, r.body).toBe(201);
    const d = (await get(alice, `/v1/theses/${r.json().thesisId}`)).json();
    expect(d.doc.test.plan).toMatchObject({ chosenBy: "planner", editedByUser: false, lockedAt: LOCKED });
    expect(d.doc.sections.find((s: { id: string }) => s.id === "methods").markdown).toContain(
      "it was written by the planner and not edited",
    );
  });
});

describe("a thesis built outside the agent keeps its behaviour", () => {
  it("the plan is chosen at build and lockedAt is null; no points for a plan locked in advance", async () => {
    const r = await post(alice, `/v1/workspaces/${wsB}/theses`, { runId: runNot });
    expect(r.statusCode, r.body).toBe(201);
    const d = (await get(alice, `/v1/theses/${r.json().thesisId}`)).json();
    expect(d.doc.test.plan.lockedAt).toBeNull();
    expect(d.doc.test.plan.editedByUser).toBe(false);
    expect(d.doc.sections.find((s: { id: string }) => s.id === "methods").markdown).not.toContain(
      "was locked at",
    );
    expect(part(d.thesis.strength, "plan_locked").points).toBe(0);
  });
});

describe("the lock is verified against the stored task, never asserted by the client", () => {
  const build = (tok: string, ws: string, run: string, taskId: string, t = test()) =>
    post(tok, `/v1/workspaces/${ws}/theses`, { runId: run, test: t, planLock: { taskId } });
  const refused = (r: { statusCode: number; json(): { reasonCode: string } }) => {
    expect(r.statusCode).toBe(422);
    expect(r.json().reasonCode).toBe("TEST_PLAN_LOCK_INVALID");
  };

  it("a plan that was never locked", async () => {
    refused(
      await build(alice, wsA, runSupported, await task(aliceId, wsA, runSupported, plan({ lockedAt: null }))),
    );
  });
  it("a plan whose hash does not match its fields", async () => {
    refused(
      await build(
        alice,
        wsA,
        runSupported,
        await task(aliceId, wsA, runSupported, plan({ lockedAt: LOCKED, sha256: "e".repeat(64) })),
      ),
    );
  });
  it("a task that did not start this run, or belongs to another workspace", async () => {
    refused(
      await build(alice, wsA, runSupported, await task(aliceId, wsA, runOne, plan({ lockedAt: LOCKED }))),
    );
    refused(
      await build(
        alice,
        wsA,
        runSupported,
        await task(aliceId, wsC, runSupported, plan({ lockedAt: LOCKED })),
      ),
    );
    refused(
      await build(alice, wsA, runSupported, await task(aliceId, wsA, null, plan({ lockedAt: LOCKED }))),
    );
  });
  it("a test that does not carry the plan's sentence", async () => {
    refused(
      await build(
        alice,
        wsA,
        runSupported,
        await task(aliceId, wsA, runSupported, plan({ lockedAt: LOCKED })),
        test("Days with higher swaps have lower volume usd."),
      ),
    );
  });
  it("a plan with no statement, an unknown task, and another user's task", async () => {
    refused(
      await build(
        alice,
        wsA,
        runSupported,
        await task(aliceId, wsA, runSupported, { ...emptyPlan(), lockedAt: LOCKED, sha256: "a".repeat(64) }),
      ),
    );
    refused(await build(alice, wsA, runSupported, randomUUID()));
    const own = await task(aliceId, wsA, runSupported, plan({ lockedAt: LOCKED }));
    // bob cannot use alice's task (row-level security hides it)
    const bobWs = (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(bob), "idempotency-key": "lk-ws-bob-00001" },
        payload: { objective: "o", networkScope: "fixture-only" },
      })
    ).json<{ workspaceId: string }>().workspaceId;
    const r = await post(bob, `/v1/workspaces/${bobWs}/theses`, {
      runId: runSupported,
      test: test(),
      planLock: { taskId: own },
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });
  it("planLock needs test and runId; an unknown field is refused", async () => {
    const own = await task(aliceId, wsA, runSupported, plan({ lockedAt: LOCKED }));
    const a = await post(alice, `/v1/workspaces/${wsA}/theses`, {
      runId: runSupported,
      planLock: { taskId: own },
    });
    expect(a.statusCode).toBe(422);
    expect(a.json().reasonCode).toBe("INVALID_BODY");
    const b = await post(alice, `/v1/workspaces/${wsA}/theses`, {
      runId: runSupported,
      test: test(),
      planLock: { taskId: own, lockedAt: LOCKED },
    });
    expect(b.statusCode).toBe(422);
  });
});

describe("POST /v1/workspaces/:id/test-plan/resolve", () => {
  const resolve = (tok: string | null, ws: string, payload: unknown) =>
    post(tok, `/v1/workspaces/${ws}/test-plan/resolve`, payload);
  it("resolved by name when each label matches one series", async () => {
    const r = await resolve(alice, wsC, { runId: runOne, xLabel: "daily swaps", yLabel: "volume usd" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      status: "resolved",
      by: "name",
      x: { panelHash: H("a"), column: "swaps", panelTitle: "Panel 0", days: 70 },
      y: { panelHash: H("b"), column: "volumeUsd", days: 70 },
    });
  });
  it("ambiguous when a label matches two series: the candidates are listed by ids and names", async () => {
    const r = await resolve(alice, wsB, { runId: runNot, xLabel: "swaps", yLabel: "volume usd" });
    const b = r.json();
    expect(b.status).toBe("ambiguous");
    expect(b.matches).toEqual({ x: "many", y: "one" });
    expect(b.candidates.map((c: { column: string }) => c.column).sort()).toEqual([
      "swaps",
      "swaps",
      "volumeUsd",
    ]);
    expect(Object.keys(b.candidates[0]).sort()).toEqual([
      "column",
      "days",
      "panelHash",
      "panelTitle",
      "unit",
    ]);
  });
  it("ambiguous with matches none when a label matches nothing (the caller may still propose by id)", async () => {
    const b = (await resolve(alice, wsC, { runId: runOne, xLabel: "swaps", yLabel: "gas fees" })).json();
    expect(b).toMatchObject({ status: "ambiguous", matches: { x: "one", y: "none" } });
  });
  it("a proposal is validated against the real candidates", async () => {
    const ok = (
      await resolve(alice, wsB, {
        runId: runNot,
        xLabel: "swaps",
        yLabel: "volume usd",
        proposal: {
          x: { panelHash: H("a"), column: "swaps" },
          y: { panelHash: H("b"), column: "volumeUsd" },
        },
      })
    ).json();
    expect(ok).toMatchObject({
      status: "resolved",
      by: "model",
      x: { column: "swaps" },
      y: { column: "volumeUsd" },
    });
    const unknown = (
      await resolve(alice, wsB, {
        runId: runNot,
        xLabel: "swaps",
        yLabel: "volume usd",
        proposal: { x: { panelHash: H("a"), column: "swaps" }, y: { panelHash: H("b"), column: "madeUp" } },
      })
    ).json();
    expect(unknown).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/not among the candidate series/),
    });
    const same = (
      await resolve(alice, wsB, {
        runId: runNot,
        xLabel: "swaps",
        yLabel: "volume usd",
        proposal: { x: { panelHash: H("a"), column: "swaps" }, y: { panelHash: H("a"), column: "swaps" } },
      })
    ).json();
    expect(same.status).toBe("rejected");
  });
  it("needs a session, hides other users' workspaces, and validates its body", async () => {
    const body = { runId: runOne, xLabel: "swaps", yLabel: "volume usd" };
    expect((await resolve(null, wsC, body)).statusCode).toBe(401);
    expect((await resolve(bob, wsC, body)).statusCode).toBe(404);
    expect((await resolve(alice, "not-a-uuid", body)).statusCode).toBe(404);
    expect((await resolve(alice, wsC, { ...body, xLabel: "" })).statusCode).toBe(422);
    expect((await resolve(alice, wsC, { ...body, extra: 1 })).statusCode).toBe(422);
    expect((await resolve(alice, wsC, { ...body, runId: runSupported })).statusCode).toBe(404);
  });
});

describe("GET /v1/workspaces/:id/runs/:runId/query-notes", () => {
  it("a run that recorded no reason per panel answers no notes (nothing is invented)", async () => {
    const r = await get(alice, `/v1/workspaces/${wsC}/runs/${runOne}/query-notes`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ runId: runOne, panels: 2, notes: [], complete: false });
    expect((await get(bob, `/v1/workspaces/${wsC}/runs/${runOne}/query-notes`)).statusCode).toBe(404);
    expect((await get(null, `/v1/workspaces/${wsC}/runs/${runOne}/query-notes`)).statusCode).toBe(401);
  });
  it("lists a reason only for a panel whose plan entry carries one, and is complete only when every panel has one", async () => {
    const setPlan = async (plan: unknown) =>
      f.db.admin.query(
        "UPDATE runtime.tasks SET result = jsonb_set(result, '{result,proposal,plan}', $2::jsonb) WHERE run_id = $1 AND role = 'composer'",
        [runOne, JSON.stringify(plan)],
      );
    await setPlan({ panels: [{ title: "Panel 0", why: "The question asks about swaps." }] });
    let b = (await get(alice, `/v1/workspaces/${wsC}/runs/${runOne}/query-notes`)).json();
    expect(b).toEqual({
      runId: runOne,
      panels: 2,
      notes: [{ panelTitle: "Panel 0", why: "The question asks about swaps." }],
      complete: false,
    });
    await setPlan({
      panels: [{ title: "Panel 0", why: "The question asks about swaps." }],
      analyticsPanels: [{ title: "Panel 1", reason: "The question asks about volume." }],
    });
    b = (await get(alice, `/v1/workspaces/${wsC}/runs/${runOne}/query-notes`)).json();
    expect(b.complete).toBe(true);
    expect(b.notes.map((n: { panelTitle: string }) => n.panelTitle)).toEqual(["Panel 0", "Panel 1"]);
  });
});
