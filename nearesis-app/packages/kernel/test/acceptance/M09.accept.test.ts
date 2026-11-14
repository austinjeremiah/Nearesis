import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { Marker } from "@nearesis/contracts";
import { createTestDb, loginSession, runCmd, seedOrg } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";
import { toErrorResponse } from "../../src/index.ts";
import type { Kernel, Session } from "../../src/index.ts";
import { cmd, monitoringKernel, rejected, sha256, workspaceWithPanel, wsVersion } from "./m-helpers.ts";

let db: TestDb;
let k: Kernel;
let owner: Session;
let analyst: Session;
let foreign: Session;
let analystUserId: string;
beforeAll(async () => {
  db = await createTestDb();
  k = monitoringKernel(db);
  const a = await seedOrg(db.admin, "m09", { alice: "owner", eve: "analyst" });
  const b = await seedOrg(db.admin, "m09b", { bob: "owner" });
  owner = await loginSession(k, a.users.alice!.subject);
  analyst = await loginSession(k, a.users.eve!.subject);
  analystUserId = a.users.eve!.userId;
  foreign = await loginSession(k, b.users.bob!.subject);
});
afterAll(async () => db?.drop());

const FIELDS = [
  "anchorType",
  "anchor",
  "sourcePanelId",
  "sourceVersion",
  "createdBy",
  "question",
  "assignedAgents",
  "linkedEvidenceIds",
  "monitorRuleId",
  "resolution",
  "timestamp",
] as const;

it("M09: a marker stores every ch.09 field, the four anchor kinds validate and round-trip exactly, and invalid input creates no row", async () => {
  const A = await workspaceWithPanel(k, db, owner);
  const B = await workspaceWithPanel(k, db, owner); // a second workspace of the same org (panel-ownership fixture)
  const markerCount = async () =>
    (await db.admin.query("SELECT count(*)::int n FROM markers WHERE workspace_id=$1", [A.workspaceId]))
      .rows[0].n as number;

  // a recorded Explorer watermark for the source_event anchor
  const sourceId = "explorer.swaps";
  await k
    .monitorScheduler()
    .enqueue({ sourceId, watermark: "2026-10-28T06:00:00.000Z", mode: "live", values: { swaps: 4200 } });

  const anchors: Record<string, Record<string, unknown>> = {
    time_point: { kind: "time_point", at: "2026-10-27T12:00:00.000Z" },
    time_range: { kind: "time_range", start: "2026-10-20T00:00:00.000Z", end: "2026-10-27T00:00:00.000Z" },
    threshold: { kind: "threshold", metricId: "vol", op: "gt", value: 1234.5 },
    source_event: {
      kind: "source_event",
      sourceId,
      eventId: "swap-batch-42",
      at: "2026-10-28T06:00:00.000Z",
    },
  };
  const created: Record<string, string> = {};
  for (const [kind, anchor] of Object.entries(anchors)) {
    const markerId = randomUUID();
    await cmd(k, db, owner, A.workspaceId, "marker.create", {
      panelId: A.panelId,
      markerId,
      anchor,
      question: `Why ${kind}?`,
      selection: undefined,
    });
    created[kind] = markerId;
  }
  const api = await k.monitoring.listMarkers(owner, A.workspaceId);
  const rows = (await db.admin.query("SELECT * FROM markers WHERE workspace_id=$1", [A.workspaceId])).rows;
  expect(api).toHaveLength(4);
  for (const [kind, markerId] of Object.entries(created)) {
    const m = api.find((x) => x.markerId === markerId)!;
    expect(Marker.parse(m)).toBeTruthy(); // typed
    for (const f of FIELDS) expect(Object.hasOwn(m, f), `field ${f}`).toBe(true); // (a) all 11 fields
    expect(m.anchorType).toBe(kind);
    expect(m.sourcePanelId).toBe(A.panelId);
    expect(m.createdBy).toBeTruthy();
    expect(m.timestamp).toMatch(/Z$/); // UTC instant
    expect(m.assignedAgents).toEqual([]);
    expect(m.linkedEvidenceIds).toEqual([]);
    // (b) the anchor round-trips as the byte-equal canonical AST, through API and database
    const db_ = rows.find((r) => r.id === markerId)!;
    expect(JSON.stringify(sortKeys(m.anchor))).toBe(JSON.stringify(sortKeys(anchors[kind])));
    expect(JSON.stringify(sortKeys(db_.anchor_json))).toBe(JSON.stringify(sortKeys(anchors[kind])));
  }

  // (c) the 8 invalid variants (+ a free-form SQL threshold): rejected, safe error_code, no row created
  const before = await markerCount();
  await k.delegation.set(owner, A.workspaceId, {
    userId: analystUserId,
    agents: ["quant"],
    grants: ["stats.read@1"],
    delegateTo: [randomUUID()],
    maxBudget: { tokens: 50_000, toolCalls: 12, usd: 5 },
  });
  const variants: Array<{
    name: string;
    expectStatus: number;
    expectCode: string;
    run: () => Promise<unknown>;
  }> = [
    {
      name: "end before start",
      expectStatus: 422,
      expectCode: "INVALID_RANGE",
      run: async () =>
        cmd(k, db, owner, A.workspaceId, "marker.create", {
          panelId: A.panelId,
          anchor: { kind: "time_range", start: "2026-10-27T00:00:00Z", end: "2026-10-20T00:00:00Z" },
        }),
    },
    {
      name: "interval outside the accessible range",
      expectStatus: 422,
      expectCode: "OUTSIDE_SOURCE_RANGE",
      run: async () =>
        cmd(k, db, owner, A.workspaceId, "marker.create", {
          panelId: A.panelId,
          anchor: { kind: "time_range", start: "2025-12-01T00:00:00Z", end: "2026-02-01T00:00:00Z" },
        }),
    },
    {
      name: "non-UTC offset timestamp",
      expectStatus: 422,
      expectCode: "NON_UTC_TIMESTAMP",
      run: async () =>
        cmd(k, db, owner, A.workspaceId, "marker.create", {
          panelId: A.panelId,
          anchor: { kind: "time_point", at: "2026-10-27T12:00:00+02:00" },
        }),
    },
    {
      name: "threshold on an unknown metric",
      expectStatus: 422,
      expectCode: "UNKNOWN_METRIC",
      run: async () =>
        cmd(k, db, owner, A.workspaceId, "marker.create", {
          panelId: A.panelId,
          anchor: { kind: "threshold", metricId: "does.not.exist", op: "gt", value: 1 },
        }),
    },
    {
      name: "threshold with mismatched unit",
      expectStatus: 422,
      expectCode: "UNIT_MISMATCH",
      run: async () =>
        cmd(k, db, owner, A.workspaceId, "marker.create", {
          panelId: A.panelId,
          anchor: { kind: "threshold", metricId: "vol", op: "gt", value: 1 },
          selection: {
            queryHash: "a".repeat(64),
            semanticVersion: "1.0.0",
            interval: { start: "2026-10-20T00:00:00Z", end: "2026-10-27T00:00:00Z" },
            seriesIds: ["vol"],
            axisUnits: { vol: "EUR" },
            sourceWatermark: null,
          },
        }),
    },
    {
      name: "panel from another workspace",
      expectStatus: 403,
      expectCode: "ACCESS_DENIED",
      run: async () =>
        cmd(k, db, owner, A.workspaceId, "marker.create", {
          panelId: B.panelId,
          anchor: anchors.time_point,
        }),
    },
    {
      name: "delegateTo outside the actor's delegation scope",
      expectStatus: 403,
      expectCode: "DELEGATION_SCOPE_EXCEEDED",
      run: async () =>
        cmd(k, db, analyst, A.workspaceId, "marker.create", {
          panelId: A.panelId,
          anchor: anchors.time_point,
          delegateTo: randomUUID(),
        }),
    },
    {
      name: "source_event referencing a non-existent watermark",
      expectStatus: 422,
      expectCode: "SOURCE_EVENT_NOT_FOUND",
      run: async () =>
        cmd(k, db, owner, A.workspaceId, "marker.create", {
          panelId: A.panelId,
          anchor: { kind: "source_event", sourceId, eventId: "ghost", at: "2026-10-29T00:00:00Z" },
        }),
    },
    {
      name: "free-form SQL smuggled in as a metric id",
      expectStatus: 422,
      expectCode: "UNKNOWN_METRIC",
      run: async () =>
        cmd(k, db, owner, A.workspaceId, "marker.create", {
          panelId: A.panelId,
          anchor: { kind: "threshold", metricId: "vol; DROP TABLE markers", op: "gt", value: 1 },
        }),
    },
  ];
  const rejections: Array<{ name: string; status: number; reasonCode: string }> = [];
  for (const v of variants) {
    const e = await rejected(v.run());
    expect(e.status, v.name).toBe(v.expectStatus);
    expect(e.reasonCode, v.name).toBe(v.expectCode);
    rejections.push({ name: v.name, status: e.status, reasonCode: e.reasonCode });
  }
  expect(await markerCount()).toBe(before); // no row created by any variant
  // the success path of the same scoped analyst: a delegateTo inside the scope is accepted
  const scoped = (
    await db.admin.query("SELECT delegate_to FROM delegation_scopes WHERE user_id=$1", [analystUserId])
  ).rows[0].delegate_to as string[];
  await cmd(k, db, analyst, A.workspaceId, "marker.create", {
    panelId: A.panelId,
    anchor: anchors.time_point,
    delegateTo: scoped[0],
  });
  expect(await markerCount()).toBe(before + 1);

  // (d) foreign-tenant access is indistinguishable from "does not exist" (no existence leak)
  const ghostWs = randomUUID();
  const body = (e: unknown) => {
    const { body } = toErrorResponse(e, "t");
    const { traceId: _t, ...rest } = body;
    return JSON.stringify(rest);
  };
  const probes: Array<[string, () => Promise<unknown>]> = [
    ["list markers", (ws = A.workspaceId) => k.monitoring.listMarkers(foreign, ws)],
    ["list rules", (ws = A.workspaceId) => k.monitoring.listRules(foreign, ws)],
    ["list lenses", (ws = A.workspaceId) => k.monitoring.listLenses(foreign, ws)],
    ["list notifications", (ws = A.workspaceId) => k.monitoring.listNotifications(foreign, ws)],
    ["list triggers", (ws = A.workspaceId) => k.monitoring.listTriggers(foreign, ws)],
    ["list tasks", (ws = A.workspaceId) => k.monitoring.listTasks(foreign, ws)],
    [
      "write marker.create",
      (ws = A.workspaceId) =>
        runCmd(k, foreign, ws, "marker.create", { panelId: A.panelId, anchor: anchors.time_point }, 1),
    ],
    [
      "link evidence",
      (ws = A.workspaceId) =>
        runCmd(
          k,
          foreign,
          ws,
          "marker.link_evidence",
          { markerId: created.time_point!, evidenceIds: [randomUUID()] },
          1,
        ),
    ],
  ];
  const equality: Array<{ probe: string; status: number; identical: boolean }> = [];
  for (const [name, fn] of probes) {
    const exists = await rejected((fn as (ws: string) => Promise<unknown>)(A.workspaceId));
    const ghost = await rejected((fn as (ws: string) => Promise<unknown>)(ghostWs));
    expect([403, 404]).toContain(exists.status);
    expect(exists.status).toBe(ghost.status);
    const same = body(exists) === body(ghost);
    expect(same, name).toBe(true);
    equality.push({ probe: name, status: exists.status, identical: same });
  }

  // (e) linked evidence and the monitor rule may only reference rows of the same workspace
  const orgId = (await db.admin.query("SELECT org_id FROM workspaces WHERE id=$1", [A.workspaceId])).rows[0]
    .org_id;
  const evA = randomUUID();
  const evB = randomUUID();
  for (const [id, ws] of [
    [evA, A.workspaceId],
    [evB, B.workspaceId],
  ] as const)
    await db.admin.query(
      "INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label, data) VALUES ($1,$2,$3,'observation','fixture','{}')",
      [id, orgId, ws],
    );
  const crossEvidence = await rejected(
    cmd(k, db, owner, A.workspaceId, "marker.link_evidence", {
      markerId: created.threshold!,
      evidenceIds: [evB],
    }),
  );
  expect(crossEvidence.reasonCode).toBe("EVIDENCE_NOT_FOUND");
  await cmd(k, db, owner, A.workspaceId, "marker.link_evidence", {
    markerId: created.threshold!,
    evidenceIds: [evA],
  });
  const foreignMarker = randomUUID();
  await cmd(k, db, owner, B.workspaceId, "marker.create", {
    panelId: B.panelId,
    markerId: foreignMarker,
    anchor: anchors.time_point,
  });
  const crossRule = await rejected(
    cmd(k, db, owner, A.workspaceId, "monitor.rule_create", {
      name: "cross",
      markerId: foreignMarker,
      sourceId: "x",
      condition: { kind: "compare", metricId: "vol", op: "gt", value: 1 },
    }),
  );
  expect(crossRule.status).toBe(403);
  const linked = (await k.monitoring.listMarkers(owner, A.workspaceId, created.threshold))[0]!
    .linkedEvidenceIds;
  expect(linked).toEqual([evA]);

  // Negative control: the verdict logic over the rejection table detects a variant that was accepted (e.g. the panel
  // ownership check removed): the "panel from another workspace" row would read status 200 instead of 403.
  const verdict = (rs: typeof rejections) => rs.every((r) => r.status === 422 || r.status === 403);
  expect(verdict(rejections)).toBe(true);
  expect(verdict(rejections.map((r) => (r.name.startsWith("panel from") ? { ...r, status: 200 } : r)))).toBe(
    false,
  );
  void wsVersion;

  observe({
    testId: "M09",
    observed: `4 markers (time_point, time_range, threshold, source_event) created and read back through API and database: all 11 ch.09 fields present and typed (strict schema parse), UTC timestamps, anchors byte-equal to the submitted canonical AST; ${rejections.length} invalid variants all rejected (${rejections.map((r) => r.status).join("/")}) with safe reason codes and 0 rows created; ${equality.length} foreign-tenant probes returned bodies identical to a non-existent workspace (status ${[...new Set(equality.map((e) => e.status))].join("/")}); cross-workspace evidence (422) and cross-workspace rule marker (403) rejected, same-workspace evidence linked`,
    fixtureHash: sha256({ fixture: "fx.snapshot.p02-baseline", catalog: "FIXTURE_CATALOG", anchors }),
    evidence: {
      rejections,
      equality,
      catalog:
        "SYNTHETIC fixture catalog injected through KernelConfig.monitoring (kernel has no built-in catalog)",
      anchorsRoundTrip: Object.keys(created),
    },
  });
});

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k2, x]) => [k2, sortKeys(x)]),
    );
  return v;
}
