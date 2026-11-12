import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CanvasPreviewResponse,
  CollabTicketResponse,
  DataFrameEnvelope,
  ErrorResponse,
  GlobalApprovalList,
  GlobalMetricList,
  GlobalNotificationList,
  GlobalSourceList,
  MeResponse,
  PanelDataResponse,
  PanelSpec,
  PublicationList,
  QuestionPreviewResponse,
} from "@nearesis/contracts";
import type { AnalyticsPanelData } from "@nearesis/contracts";
import type { AuthoringService } from "@nearesis/semantic-gateway";
import type { Registry } from "@nearesis/analytics";
import {
  buildCapsule,
  writeCapsuleOwnership,
  writeCapsulePublicationState,
} from "../../../packages/capsule/src/index.ts";
import { apiFixture, bearer, login, sansTrace, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import type { PanelDataPort, StoredQuery } from "../src/panel-data.ts";
import { assembleSourceHealth } from "../src/source-health.ts";
import type { InvestigationEngine } from "../src/runs.ts";

const H_SEM = "1".repeat(64);
const H_SEM_BIG = "2".repeat(64);
const H_AN = "3".repeat(64);
const H_CANNOT = "4".repeat(64);
const H_UNKNOWN = "5".repeat(64);

const AST = {
  measures: ["live_tx.count"],
  time: { grain: "day", field: "day", from: "2026-11-01", to: "2026-11-08" },
};
const envelope = DataFrameEnvelope.parse({
  queryHash: H_SEM,
  semanticVersion: "1.0.0",
  semanticModelHash: "a".repeat(64),
  sourceSnapshotId: null,
  columns: [
    { name: "day", type: "time", unit: null },
    { name: "tx", type: "number", unit: "tx" },
  ],
  rows: [
    ["2026-11-01T00:00:00.000Z", 10],
    ["2026-11-02T00:00:00.000Z", 12],
  ],
  rowCoverage: [],
  nullCount: 0,
  partialCount: 1,
  gaps: [{ from: "2026-11-03T00:00:00.000Z", to: "2026-11-03T23:59:59.999Z", reason: "NO_COVERAGE" }],
  sourceWatermarks: { "near-bigquery": "2026-11-02T00:00:00.000Z" },
  sources: ["near-bigquery"],
  certification: "partial",
  cost: { bytesEstimated: 4000, bytesBilled: 0 },
  planFingerprint: "b".repeat(64),
  generatedAt: "2026-11-13T00:00:00.000Z",
  rollupFreshness: {
    state: "fresh",
    rollupBuiltAt: "2026-11-12T00:00:00.000Z",
    sourceChangedAt: "2026-11-11T00:00:00.000Z",
    lagSeconds: 0,
  },
});

const analyticsOk = {
  chart: {
    queryHash: H_AN,
    dataRevision: 1,
    columns: [
      { name: "week", unit: null },
      { name: "swaps", unit: "swaps" },
    ],
    rows: [["2026-11-02", 5]],
    downsampling: { method: "none", originalPoints: 1 },
    freshness: "partial",
    sourceWatermark: "2026-11-12",
  },
  shape: {
    queryHash: H_AN,
    fields: [
      { name: "week", unit: null, role: "time" },
      { name: "swaps", unit: "swaps", role: "measure" },
    ],
  },
  provenance: {
    queryHash: H_AN,
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
      state: "partial",
      daysRequested: 14,
      daysWithData: 13,
      missingDays: ["2026-11-05"],
      incompleteDays: ["2026-11-12"],
    },
    caveats: ["USD unknown for some rows"],
  },
  cannotCompute: null,
  truncated: false,
} as unknown as AnalyticsPanelData;

interface Seen {
  queries: Array<{ tenantId: string; workspaceId: string; principalId: string; source: string }>;
}
function fakePort(seen: Seen): PanelDataPort {
  const stored: Record<string, StoredQuery> = {
    [H_SEM]: { kind: "semantic", ast: AST, source: "live" },
    [H_SEM_BIG]: { kind: "semantic", ast: { ...AST, big: true }, source: "live" },
    [H_AN]: { kind: "analytics", ast: { kind: "analytics_call" } },
    [H_CANNOT]: { kind: "analytics", ast: { kind: "analytics_call" } },
  };
  return {
    async stored(hash) {
      return stored[hash] ?? null;
    },
    async query(session, _ast, source) {
      seen.queries.push({ ...session, source });
      return { ok: true, status: 200, queryHash: H_SEM, cache: "miss", cacheKey: "k", envelope };
    },
    async estimate(_s, ast) {
      const big = (ast as { big?: boolean }).big === true;
      return {
        ok: true,
        queryHash: H_SEM,
        estimatedRows: big ? 9_000_000 : 8000,
        bytesEstimated: big ? 1_800_000_000 : 1_600_000,
        maxEstimatedRows: 5_000_000,
        withinCap: !big,
        rollupServed: false,
        cached: false,
      };
    },
    registry: () =>
      ({
        metrics: [{ cubeMember: "live_tx.count", sources: ["near-bigquery:near_daily_tx"] }],
      }) as unknown as Registry,
    async analytics(hash) {
      if (hash === H_CANNOT)
        return {
          status: 200,
          body: {
            ...analyticsOk,
            chart: { ...analyticsOk.chart, queryHash: H_CANNOT, rows: [], freshness: "unavailable" },
            cannotCompute: { missing: ["solver_id"], explanation: "no solver data" },
          },
        };
      return { status: 200, body: analyticsOk };
    },
    async close() {},
  };
}

class FakeEngine implements InvestigationEngine {
  async start(i: { runId: string }) {
    return { runId: i.runId, workflowId: `investigation-${i.runId}` };
  }
  async signal() {}
}

let f: ApiFixture;
const seen: Seen = { queries: [] };
let alice: string;
let vic: string;
let ana: string;
let bob: string;
let orgA: string;
let wsA: string;
let wsA2: string;
let wsB: string;
let capsuleRoot: string;
let panelId: string;
const get = (tok: string | null, url: string) => f.app.inject({ url, headers: tok ? bearer(tok) : {} });
const post = (tok: string | null, url: string, payload?: unknown) =>
  f.app.inject({ method: "POST", url, headers: tok ? bearer(tok) : {}, payload: (payload ?? {}) as never });
const create = async (tok: string, key: string, objective = "o") =>
  (
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(tok), "idempotency-key": key },
        payload: { objective, networkScope: "fixture-only" },
      })
    ).json() as { workspaceId: string }
  ).workspaceId;

const authoringStub = {
  async catalogue(p: { workspaceId: string }) {
    return [
      {
        metricKey: "live.near_tx_count",
        source: "registry",
        status: "CERTIFIED",
        version: "1.0.0",
        displayName: "Tx",
        unit: "tx",
        exploratory: false,
      },
      ...(p.workspaceId === wsA
        ? [
            {
              metricKey: "authored.fee_per_tx",
              source: "authored",
              status: "DRAFT",
              version: 1,
              displayName: "Fee",
              unit: "usd",
              exploratory: true,
            },
          ]
        : []),
    ];
  },
} as unknown as AuthoringService;

const sourcesStub = {
  async read() {
    return assembleSourceHealth(
      [
        {
          provider_id: "p1",
          newest_event_time: "2026-11-12 22:00:00.000",
          gap_count: 2,
          provider_lag_seconds: 30,
          schema_version: null,
          state: "fresh",
        },
      ],
      [
        { provider_id: "p1", dataset: "d1", state: "complete", days: 45, newest: "2026-11-12" },
        { provider_id: "p1", dataset: "d1", state: "partial", days: 5, newest: "2026-11-12" },
      ],
      [
        {
          provider_id: "p1",
          dataset: "d1",
          state: "partial",
          reason_code: "REFUND_SPLIT_IS_PROXY",
          from_utc: "2026-11-09 00:00:00.000",
          to_utc: "2026-11-09 23:59:59.999",
        },
      ],
    );
  },
  async close() {},
};

beforeAll(async () => {
  capsuleRoot = mkdtempSync(join(tmpdir(), "fe-capsules-"));
  f = await apiFixture({
    runtime: true,
    engine: new FakeEngine(),
    appOptions: {
      authoring: authoringStub,
      frontend: {
        panelData: fakePort(seen),
        sources: sourcesStub,
        capsuleRoot: () => capsuleRoot,
        collabTicketTtlMs: 30_000,
      },
    },
  });
  const a = await seedOrg(f.db.admin, "fe", { alice: "owner", ana: "analyst", vic: "viewer" });
  const b = await seedOrg(f.db.admin, "fe2", { bob: "owner" });
  orgA = a.orgId;
  alice = await login(f.app, a.users.alice!.subject);
  ana = await login(f.app, a.users.ana!.subject);
  vic = await login(f.app, a.users.vic!.subject);
  bob = await login(f.app, b.users.bob!.subject);
  wsA = await create(alice, "create-fe-a-0001", "Alpha objective");
  wsA2 = await create(alice, "create-fe-a-0002", "Beta objective");
  wsB = await create(bob, "create-fe-b-0001", "Bob objective");
  // a panel in wsA's canvas
  const panel = PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: "Tx",
    queryRef: { hash: H_SEM, semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["day", "tx"], units: { tx: "tx" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "day", y: ["tx"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
  });
  panelId = panel.panelId;
  const w = (await get(alice, `/v1/workspaces/${wsA}`)).json<{ version: number }>();
  const r = await f.app.inject({
    method: "POST",
    url: `/v1/workspaces/${wsA}/commands`,
    headers: bearer(alice),
    payload: {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "canvas.apply_patch",
      payload: {
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: randomUUID(),
        expectedRevision: 0,
        operations: [{ op: "addPanel", panel }],
      },
      expectedVersion: w.version,
    },
  });
  expect(r.statusCode).toBe(200);
});
afterAll(async () => f?.close());

describe("GET /v1/workspaces/:id/panels/:hash/data", () => {
  it("serves a semantic panel with coverage, gaps, provenance, freshness, rollupFreshness and cost; the session is bound server-side", async () => {
    const r = await get(alice, `/v1/workspaces/${wsA}/panels/${H_SEM}/data`);
    expect(r.statusCode).toBe(200);
    const body = PanelDataResponse.parse(r.json());
    expect(body).toMatchObject({
      kind: "semantic",
      workspaceId: wsA,
      state: "partial",
      cost: { bytesEstimated: 4000, bytesBilled: 0 },
      rollupFreshness: { state: "fresh", lagSeconds: 0 },
      freshness: { state: "partial", sourceWatermark: "2026-11-02T00:00:00.000Z" },
      provenance: { sourceLabel: "LIVE", certification: "partial", sources: ["near-bigquery"] },
    });
    expect(body.chart!.rows).toHaveLength(2);
    expect(body.gaps).toEqual([expect.objectContaining({ reason: "NO_COVERAGE" })]);
    expect(body.coverage).toMatchObject({ partialCount: 1, nullCount: 0 });
    const last = seen.queries.at(-1)!;
    expect(last).toMatchObject({
      tenantId: orgA,
      workspaceId: wsA,
      principalId: expect.any(String),
      source: "live",
    });
  });

  it("dispatches an analytics hash on the same route and states an unanswerable call as cannotCompute (HTTP 200, no chart)", async () => {
    const a = PanelDataResponse.parse((await get(ana, `/v1/workspaces/${wsA}/panels/${H_AN}/data`)).json());
    expect(a).toMatchObject({
      kind: "analytics",
      state: "partial",
      provenance: { sourceLabel: "ANALYTICS", certification: "partial" },
      caveats: ["USD unknown for some rows"],
      freshness: { sourceWatermark: "2026-11-12T00:00:00.000Z" },
    });
    expect(a.gaps.map((g) => g.reason).sort()).toEqual(["NO_COVERAGE", "PARTIAL_DAY"]);
    const c = PanelDataResponse.parse(
      (await get(alice, `/v1/workspaces/${wsA}/panels/${H_CANNOT}/data`)).json(),
    );
    expect(c).toMatchObject({
      kind: "analytics",
      state: "insufficient_data",
      chart: null,
      cannotCompute: { missing: ["solver_id"] },
    });
  });

  it("viewers read; anonymous is 401; unknown hash 404 QUERY_UNKNOWN; malformed hash 422", async () => {
    expect((await get(vic, `/v1/workspaces/${wsA}/panels/${H_SEM}/data`)).statusCode).toBe(200);
    expect((await get(null, `/v1/workspaces/${wsA}/panels/${H_SEM}/data`)).statusCode).toBe(401);
    const u = await get(alice, `/v1/workspaces/${wsA}/panels/${H_UNKNOWN}/data`);
    expect(u.statusCode).toBe(404);
    expect(ErrorResponse.parse(u.json())).toMatchObject({ reasonCode: "QUERY_UNKNOWN" });
    expect((await get(alice, `/v1/workspaces/${wsA}/panels/nothex/data`)).statusCode).toBe(422);
    expect((await get(alice, `/v1/workspaces/${wsA}/panels/${H_SEM}/data?source=prod`)).statusCode).toBe(422);
  });

  it("cross-tenant: a foreign workspace is the same 404 as an unknown one, and the gateway is never reached", async () => {
    const before = seen.queries.length;
    const foreign = await get(bob, `/v1/workspaces/${wsA}/panels/${H_SEM}/data`);
    const unknown = await get(bob, `/v1/workspaces/${randomUUID()}/panels/${H_SEM}/data`);
    const notUuid = await get(bob, `/v1/workspaces/not-a-uuid/panels/${H_SEM}/data`);
    expect([foreign.statusCode, unknown.statusCode, notUuid.statusCode]).toEqual([404, 404, 404]);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
    expect(seen.queries.length).toBe(before);
  });
});

describe("POST /v1/workspaces/:id/canvas/preview", () => {
  const panelWith = (hash: string, over: Record<string, unknown> = {}) => ({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: "P",
    queryRef: { hash, semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["day", "tx"], units: { tx: "tx" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "day", y: ["tx"] },
    layout: { x: 6, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
    ...over,
  });
  const patch = (ops: unknown[], rev = 1) => ({
    schemaVersion: 1,
    type: "workspace.patch",
    operationId: randomUUID(),
    expectedRevision: rev,
    operations: ops,
  });

  it("estimates the queries a patch adds without writing anything", async () => {
    const big = panelWith(H_SEM_BIG);
    const ok = panelWith(H_SEM);
    const unknown = panelWith(H_UNKNOWN);
    const before = (await get(alice, `/v1/workspaces/${wsA}/canvas`)).json<{
      documentRevision: number;
      panels: unknown[];
    }>();
    const events = await f.db.admin.query(
      "SELECT count(*)::int AS n FROM workspace_events WHERE workspace_id=$1",
      [wsA],
    );
    const ops = patch(
      [
        { op: "addPanel", panel: ok },
        { op: "addPanel", panel: big },
        { op: "addPanel", panel: unknown },
        { op: "removePanel", panelId },
      ],
      before.documentRevision,
    );
    const r = await post(alice, `/v1/workspaces/${wsA}/canvas/preview`, ops);
    expect(r.statusCode).toBe(200);
    const body = CanvasPreviewResponse.parse(r.json());
    expect(body.baseRevision).toBe(before.documentRevision);
    expect(body.estimate).toMatchObject({ queryCount: 2, estimatedCostUsd: 0, removedPanelIds: [panelId] });
    expect(body.estimate.atRiskPanelIds.sort()).toEqual([big.panelId, unknown.panelId].sort());
    expect(body.estimate.queries.find((q) => q.panelId === big.panelId)).toMatchObject({
      withinCap: false,
      reasonCode: "COST_CAP",
    });
    expect(body.estimate.queries.find((q) => q.panelId === unknown.panelId)).toMatchObject({
      status: "not_estimable",
      reasonCode: "QUERY_UNKNOWN",
    });
    // no side effects
    const after = (await get(alice, `/v1/workspaces/${wsA}/canvas`)).json<{
      documentRevision: number;
      panels: unknown[];
    }>();
    expect(after).toEqual(before);
    const events2 = await f.db.admin.query(
      "SELECT count(*)::int AS n FROM workspace_events WHERE workspace_id=$1",
      [wsA],
    );
    expect(events2.rows[0].n).toBe(events.rows[0].n);
    // the same patch gives the same preview hash
    const again = CanvasPreviewResponse.parse(
      (await post(alice, `/v1/workspaces/${wsA}/canvas/preview`, ops)).json(),
    );
    expect(again.previewHash).toBe(body.previewHash);
  });

  it("rejects an invalid patch with 422 PATCH_REJECTED and the last stable revision", async () => {
    const r = await post(
      alice,
      `/v1/workspaces/${wsA}/canvas/preview`,
      patch([{ op: "removePanel", panelId: randomUUID() }]),
    );
    expect(r.statusCode).toBe(422);
    expect(ErrorResponse.parse(r.json())).toMatchObject({
      reasonCode: "PATCH_REJECTED",
      lastStableRevision: expect.any(Number),
    });
    expect((await post(alice, `/v1/workspaces/${wsA}/canvas/preview`, { nope: true })).statusCode).toBe(422);
  });

  it("viewers may preview; outsiders get the uniform 404; anonymous 401", async () => {
    const p = patch([{ op: "addPanel", panel: panelWith(H_SEM) }]);
    expect((await post(vic, `/v1/workspaces/${wsA}/canvas/preview`, p)).statusCode).toBe(200);
    const foreign = await post(bob, `/v1/workspaces/${wsA}/canvas/preview`, p);
    const unknown = await post(bob, `/v1/workspaces/${randomUUID()}/canvas/preview`, p);
    expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
    expect((await post(null, `/v1/workspaces/${wsA}/canvas/preview`, p)).statusCode).toBe(401);
  });
});

describe("POST /v1/workspaces/:id/questions/preview", () => {
  const ask = { question: "Why did swaps fall last week?", source: "live" };
  it("returns the exact deterministic plan for a live question with zero model calls and zero spend, and starts no run", async () => {
    const runsBefore = await f.db.admin.query(
      "SELECT count(*)::int AS n FROM runtime.runs WHERE workspace_id=$1",
      [wsA],
    );
    const r = await post(ana, `/v1/workspaces/${wsA}/questions/preview`, ask);
    expect(r.statusCode).toBe(200);
    const b = QuestionPreviewResponse.parse(r.json());
    expect(b).toMatchObject({
      planKind: "deterministic_composer",
      deterministic: true,
      modelCalls: 0,
      spendUsd: 0,
      canStart: true,
      blockers: [],
    });
    expect(b.plan!.stages[0]![0]).toMatchObject({ role: "composer", objective: ask.question });
    expect(b.plan!.privilegedAction).toMatchObject({ kind: "canvas.apply_patch", requiresApproval: true });
    const budgets = await f.db.admin.query(
      "SELECT count(*)::int AS n FROM runtime.budgets WHERE workspace_id=$1",
      [wsA],
    );
    const runsAfter = await f.db.admin.query(
      "SELECT count(*)::int AS n FROM runtime.runs WHERE workspace_id=$1",
      [wsA],
    );
    expect(runsAfter.rows[0].n).toBe(runsBefore.rows[0].n);
    expect(budgets.rows[0].n).toBe(0);
  });

  it("does not invent a plan for fixture questions (director model) and says so", async () => {
    const b = QuestionPreviewResponse.parse(
      (await post(ana, `/v1/workspaces/${wsA}/questions/preview`, { question: "Why?" })).json(),
    );
    expect(b).toMatchObject({
      planKind: "director_model",
      deterministic: false,
      plan: null,
      modelCalls: 0,
      spendUsd: 0,
    });
  });

  it("a viewer or a too-small budget is reported as a blocker, not a plan that cannot run", async () => {
    const v = QuestionPreviewResponse.parse(
      (await post(vic, `/v1/workspaces/${wsA}/questions/preview`, ask)).json(),
    );
    expect(v.canStart).toBe(false);
    expect(v.blockers.map((x) => x.reasonCode)).toEqual(["INSUFFICIENT_ROLE"]);
    const s = QuestionPreviewResponse.parse(
      (
        await post(ana, `/v1/workspaces/${wsA}/questions/preview`, {
          ...ask,
          budget: { tokens: 10, toolCalls: 1, usd: 0.1 },
        })
      ).json(),
    );
    expect(s.blockers.map((x) => x.reasonCode)).toEqual(["BUDGET_BELOW_MINIMUM"]);
    expect(s.budget.meetsMinimum).toBe(false);
  });

  it("validates the body; outsiders get the uniform 404", async () => {
    expect((await post(ana, `/v1/workspaces/${wsA}/questions/preview`, { question: "" })).statusCode).toBe(
      422,
    );
    expect(
      (await post(ana, `/v1/workspaces/${wsA}/questions/preview`, { ...ask, extra: 1 })).statusCode,
    ).toBe(422);
    const foreign = await post(bob, `/v1/workspaces/${wsA}/questions/preview`, ask);
    const unknown = await post(bob, `/v1/workspaces/${randomUUID()}/questions/preview`, ask);
    expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
    expect((await post(null, `/v1/workspaces/${wsA}/questions/preview`, ask)).statusCode).toBe(401);
  });
});

describe("GET /v1/me", () => {
  it("returns principal, org, role and only the caller's workspaces", async () => {
    const me = MeResponse.parse((await get(vic, "/v1/me")).json());
    expect(me).toMatchObject({
      role: "viewer",
      roles: ["viewer"],
      org: { id: orgA },
      permissions: { canWrite: false, canAdmin: false },
    });
    expect(me.workspaces.map((w) => w.id).sort()).toEqual([wsA, wsA2].sort());
    const owner = MeResponse.parse((await get(alice, "/v1/me")).json());
    expect(owner.permissions).toEqual({ canWrite: true, canAdmin: true });
    const other = MeResponse.parse((await get(bob, "/v1/me")).json());
    expect(other.workspaces.map((w) => w.id)).toEqual([wsB]);
    expect((await get(null, "/v1/me")).statusCode).toBe(401);
  });
});

describe("global fan-out lists", () => {
  it("/v1/notifications merges all workspaces of the caller's org and never another org's", async () => {
    // a monitor rule in each org's workspace, then one notification per rule (rows written directly: the collector is out of scope)
    const mkRule = async (tok: string, ws: string) => {
      const w = (await get(tok, `/v1/workspaces/${ws}`)).json<{ version: number }>();
      const r = await f.app.inject({
        method: "POST",
        url: `/v1/workspaces/${ws}/commands`,
        headers: bearer(tok),
        payload: {
          apiVersion: "v1",
          commandId: randomUUID(),
          commandType: "monitor.rule_create",
          payload: {
            name: "r",
            sourceId: `src-${randomUUID().slice(0, 8)}`,
            condition: { kind: "compare", metricId: "v", op: "gt", value: 1 },
          },
          expectedVersion: w.version,
        },
      });
      expect(r.statusCode).toBe(200);
      return (await get(tok, `/v1/workspaces/${ws}/monitors`)).json<{ rules: Array<{ ruleId: string }> }>()
        .rules[0]!.ruleId;
    };
    const ruleA = await mkRule(alice, wsA);
    const ruleB = await mkRule(bob, wsB);
    const ins = (org: string, ws: string, rule: string, title: string, at: string, read: boolean) =>
      f.db.admin.query(
        `INSERT INTO notifications(id, org_id, workspace_id, rule_id, trigger_id, mode, title, body, created_at, read_at)
         VALUES ($1,$2,$3,$4,$5,'live',$6,'b',$7,$8)`,
        [randomUUID(), org, ws, rule, randomUUID(), title, at, read ? at : null],
      );
    const orgBId = (await f.db.admin.query("SELECT org_id FROM workspaces WHERE id=$1", [wsB])).rows[0]
      .org_id as string;
    await ins(orgA, wsA, ruleA, "older", "2026-11-10T00:00:00Z", true);
    await ins(orgA, wsA, ruleA, "newer", "2026-11-12T00:00:00Z", false);
    await ins(orgBId, wsB, ruleB, "bobs", "2026-11-12T12:00:00Z", false);
    const a = GlobalNotificationList.parse((await get(vic, "/v1/notifications")).json());
    expect(a.notifications.map((n) => n.title)).toEqual(["newer", "older"]);
    expect(a.notifications[0]).toMatchObject({ workspaceId: wsA, workspaceObjective: "Alpha objective" });
    expect(a).toMatchObject({ unread: 1, workspaceCount: 2, truncated: false });
    expect(
      GlobalNotificationList.parse((await get(vic, "/v1/notifications?unread=1")).json()).notifications.map(
        (n) => n.title,
      ),
    ).toEqual(["newer"]);
    expect(
      GlobalNotificationList.parse((await get(bob, "/v1/notifications")).json()).notifications.map(
        (n) => n.title,
      ),
    ).toEqual(["bobs"]);
    expect((await get(vic, "/v1/notifications?limit=0")).statusCode).toBe(422);
    expect((await get(null, "/v1/notifications")).statusCode).toBe(401);
  });

  it("/v1/approvals lists pending approvals of the org's runs only; status=all adds decided ones", async () => {
    const seed = async (tenant: string, ws: string, state: string, hash: string) => {
      const runId = randomUUID();
      await f.db.admin.query(
        `INSERT INTO runtime.runs(id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state)
         VALUES ($1,$2,$3,$4,$5,'live',$6,$7,$8)`,
        [
          runId,
          tenant,
          ws,
          randomUUID(),
          randomUUID(),
          randomUUID(),
          `investigation-${randomUUID()}-${randomUUID()}`,
          state,
        ],
      );
      await f.db.admin.query(
        "INSERT INTO runtime.run_events(tenant_id, run_id, source, seq, kind, detail) VALUES ($1,$2,'run',1,'approval.requested',$3)",
        [
          tenant,
          runId,
          JSON.stringify({
            actionHash: hash,
            kind: "canvas.apply_patch",
            network: "fixture-only",
            costLimit: 0,
          }),
        ],
      );
      return runId;
    };
    const orgBId = (await f.db.admin.query("SELECT org_id FROM workspaces WHERE id=$1", [wsB])).rows[0]
      .org_id as string;
    const pendingA = await seed(orgA, wsA2, "APPROVAL_NEEDED", "a".repeat(64));
    await seed(orgA, wsA, "COMPLETE", "b".repeat(64));
    const pendingB = await seed(orgBId, wsB, "APPROVAL_NEEDED", "c".repeat(64));
    const a = GlobalApprovalList.parse((await get(vic, "/v1/approvals")).json());
    expect(a.approvals.map((x) => x.runId)).toEqual([pendingA]);
    expect(a.approvals[0]).toMatchObject({
      status: "pending",
      workspaceId: wsA2,
      workspaceObjective: "Beta objective",
      kind: "canvas.apply_patch",
    });
    const all = GlobalApprovalList.parse((await get(vic, "/v1/approvals?status=all")).json());
    expect(all.approvals).toHaveLength(2);
    expect(all.approvals.some((x) => x.runId === pendingB)).toBe(false);
    expect(
      GlobalApprovalList.parse((await get(bob, "/v1/approvals")).json()).approvals.map((x) => x.runId),
    ).toEqual([pendingB]);
    expect((await get(vic, "/v1/approvals?status=bogus")).statusCode).toBe(422);
    expect((await get(null, "/v1/approvals")).statusCode).toBe(401);
  });

  it("/v1/publications lists the org's capsules with publication state, hiding other orgs'", async () => {
    const id = "cap-synthetic-2026-11-10";
    buildCapsule({
      snapshotDir: join(import.meta.dirname, "../../../packages/capsule/fixtures/snapshot-synthetic"),
      outDir: join(capsuleRoot, id),
    });
    const orgBId = (await f.db.admin.query("SELECT org_id FROM workspaces WHERE id=$1", [wsB])).rows[0]
      .org_id as string;
    cpSync(join(capsuleRoot, id), join(capsuleRoot, "cap-foreign-copy"), { recursive: true });
    writeCapsuleOwnership(join(capsuleRoot, "cap-foreign-copy"), { orgId: orgBId, workspaceId: wsB });
    // owned by A but never published
    writeCapsuleOwnership(join(capsuleRoot, id), { orgId: orgA, workspaceId: wsA });
    const never = PublicationList.parse((await get(vic, "/v1/publications")).json()).publications;
    expect(never).toEqual([
      expect.objectContaining({
        capsuleId: id,
        workspaceId: wsA,
        state: "never_published",
        public: false,
        label: "SYNTHETIC",
      }),
    ]);
    // published
    writeCapsulePublicationState(join(capsuleRoot, id), {
      state: "published",
      orgId: orgA,
      workspaceId: wsA,
      actorId: "someone",
      at: "2026-11-12T01:00:00.000Z",
      acknowledged: [],
      badge: "verified",
    });
    const pub = PublicationList.parse((await get(vic, "/v1/publications")).json()).publications;
    expect(pub).toEqual([
      expect.objectContaining({
        state: "published",
        public: true,
        badge: "verified",
        publishedAt: "2026-11-12T01:00:00.000Z",
      }),
    ]);
    // org B sees only its own (the foreign copy), never A's
    const bobs = PublicationList.parse((await get(bob, "/v1/publications")).json()).publications;
    expect(bobs).toEqual([expect.objectContaining({ workspaceId: wsB, state: "never_published" })]);
    expect((await get(null, "/v1/publications")).statusCode).toBe(401);
  });

  it("/v1/metrics merges the registry with authored metrics of every workspace, with status", async () => {
    const m = GlobalMetricList.parse((await get(vic, "/v1/metrics")).json());
    expect(m.metrics.map((x) => x.metricKey)).toEqual(["authored.fee_per_tx", "live.near_tx_count"]);
    expect(m.metrics[0]).toMatchObject({
      source: "authored",
      status: "DRAFT",
      exploratory: true,
      authoredIn: [wsA],
    });
    expect(m.counts).toEqual({ DRAFT: 1, CERTIFIED: 1 });
    const bobs = GlobalMetricList.parse((await get(bob, "/v1/metrics")).json());
    expect(bobs.metrics.map((x) => x.metricKey)).toEqual(["live.near_tx_count"]);
    expect((await get(null, "/v1/metrics")).statusCode).toBe(401);
  });

  it("/v1/sources reports watermark, lag, coverage percentage, recent errors and an honest null rate limit", async () => {
    const s = GlobalSourceList.parse((await get(vic, "/v1/sources")).json());
    expect(s.unavailable).toBeNull();
    expect(s.sources).toHaveLength(1);
    expect(s.sources[0]).toMatchObject({
      sourceId: "p1",
      state: "fresh",
      watermark: "2026-11-12T22:00:00.000Z",
      lagSeconds: 30,
      gapCount: 2,
      coveragePct: 50,
      rateLimit: null,
      recentErrors: [expect.objectContaining({ reasonCode: "REFUND_SPLIT_IS_PROXY" })],
    });
    expect(s.sources[0]!.datasets[0]).toMatchObject({
      completeDays: 45,
      partialDays: 5,
      missingDays: 40,
      coveragePct: 50,
    });
    expect((await get(null, "/v1/sources")).statusCode).toBe(401);
  });
});

describe("collaboration WebSocket ticket", () => {
  let base: string;
  beforeAll(async () => {
    await f.app.listen({ port: 0, host: "127.0.0.1" });
    base = `ws://127.0.0.1:${(f.app.server.address() as AddressInfo).port}`;
  });
  const open = (ws: string, scope: string, proto: string[]) =>
    new Promise<{ ok: boolean; sock?: WebSocket }>((res) => {
      const sock = new WebSocket(`${base}/v1/workspaces/${ws}/collab/${scope}/ws`, proto);
      sock.onopen = () => res({ ok: true, sock });
      sock.onerror = () => res({ ok: false });
    });
  const ticket = async (tok: string, ws: string, body: unknown = {}) =>
    CollabTicketResponse.parse((await post(tok, `/v1/workspaces/${ws}/collab/ticket`, body)).json());

  it("issues a ticket that opens the socket once, without any bearer token", async () => {
    const t = await ticket(vic, wsA, { scope: "layout" });
    expect(t).toMatchObject({ workspaceId: wsA, scope: "layout", ttlSeconds: 30 });
    expect(t.ticket.length).toBeGreaterThanOrEqual(32);
    const first = await open(wsA, "layout", [t.subprotocol]);
    expect(first.ok).toBe(true);
    first.sock?.close();
    const replay = await open(wsA, "layout", [t.subprotocol]);
    expect(replay.ok).toBe(false);
  });

  it("is bound to its workspace and scope, and an unscoped ticket works for any room of that workspace", async () => {
    const t = await ticket(alice, wsA, { scope: "layout" });
    expect((await open(wsA, "notes", [t.subprotocol])).ok).toBe(false); // wrong scope (and burned)
    const t2 = await ticket(alice, wsA);
    expect((await open(wsA2, "layout", [t2.subprotocol])).ok).toBe(false); // wrong workspace
    const t3 = await ticket(alice, wsA);
    const ok = await open(wsA, "notes", [t3.subprotocol]);
    expect(ok.ok).toBe(true);
    ok.sock?.close();
    expect((await open(wsA, "layout", ["nearesis.ticket.forged"])).ok).toBe(false);
  });

  it("refuses to issue for outsiders (uniform 404), anonymous callers and bad scopes", async () => {
    const foreign = await post(bob, `/v1/workspaces/${wsA}/collab/ticket`, {});
    const unknown = await post(bob, `/v1/workspaces/${randomUUID()}/collab/ticket`, {});
    expect([foreign.statusCode, unknown.statusCode]).toEqual([404, 404]);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
    expect((await post(null, `/v1/workspaces/${wsA}/collab/ticket`, {})).statusCode).toBe(401);
    expect((await post(alice, `/v1/workspaces/${wsA}/collab/ticket`, { scope: "evidence" })).statusCode).toBe(
      422,
    );
  });
});
