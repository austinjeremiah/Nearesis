import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PanelSpec } from "@nearesis/contracts";
import type { Condition } from "@nearesis/contracts";
import { KernelError, evaluateCondition } from "../src/index.ts";
import type { Kernel, Session } from "../src/index.ts";
import { createTestDb, createWs, loginSession, runCmd, seedOrg, testKernel } from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";

const cmp = (metricId: string, op: "gt" | "lt" | "gte" | "lte" | "eq" | "ne", value: number): Condition => ({
  kind: "compare",
  metricId,
  op,
  value,
});

describe("evaluateCondition (deterministic, three-valued)", () => {
  it("compares, combines and never coerces a missing metric to zero", () => {
    expect(evaluateCondition(cmp("v", "gt", 5), { v: 6 })).toBe(true);
    expect(evaluateCondition(cmp("v", "gt", 5), { v: 5 })).toBe(false);
    expect(evaluateCondition(cmp("v", "lt", 5), {})).toBeNull();
    expect(evaluateCondition(cmp("v", "lt", 5), { v: Number.NaN })).toBeNull();
    expect(evaluateCondition(cmp("toString", "lt", 5), {})).toBeNull();
    expect(evaluateCondition({ kind: "not", term: cmp("v", "lt", 5) }, {})).toBeNull();
    const and: Condition = { kind: "and", terms: [cmp("a", "gt", 1), cmp("b", "gt", 1)] };
    expect(evaluateCondition(and, { a: 2 })).toBeNull();
    expect(evaluateCondition(and, { a: 0 })).toBe(false);
    expect(evaluateCondition(and, { a: 2, b: 2 })).toBe(true);
    const or: Condition = { kind: "or", terms: [cmp("a", "gt", 1), cmp("b", "gt", 1)] };
    expect(evaluateCondition(or, { a: 0 })).toBeNull();
    expect(evaluateCondition(or, { b: 2 })).toBe(true);
  });
});

const panel = () =>
  PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: "Volume",
    queryRef: { hash: "a".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["ts", "vol"], units: { vol: "USD" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "ts", y: ["vol"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
  });

let db: TestDb;
let k: Kernel;
let s: Session;
let other: Session;
let viewer: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  const a = await seedOrg(db.admin, "mon", { alice: "owner", vic: "viewer" });
  const b = await seedOrg(db.admin, "mon2", { bob: "owner" });
  s = await loginSession(k, a.users.alice!.subject);
  viewer = await loginSession(k, a.users.vic!.subject);
  other = await loginSession(k, b.users.bob!.subject);
});
afterAll(async () => db?.drop());

async function workspaceWithPanel() {
  const { workspaceId } = await createWs(k, s);
  const p = panel();
  const v = (await db.admin.query("SELECT version FROM workspaces WHERE id=$1", [workspaceId])).rows[0]
    .version;
  await runCmd(
    k,
    s,
    workspaceId,
    "canvas.apply_patch",
    {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: randomUUID(),
      expectedRevision: 0,
      operations: [{ op: "addPanel", panel: p }],
    },
    v,
  );
  return { workspaceId, panelId: p.panelId };
}
const ver = async (ws: string) =>
  (await db.admin.query("SELECT version FROM workspaces WHERE id=$1", [ws])).rows[0].version as number;
const run = async (
  ws: string,
  type: Parameters<typeof runCmd>[3],
  payload: Record<string, unknown>,
  as = s,
) => runCmd(k, as, ws, type, payload, await ver(ws));
const reject = (p: Promise<unknown>): Promise<KernelError> =>
  p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => e as KernelError,
  );

describe("marker state machine", () => {
  it("follows exactly DRAFT, ACTIVE, INVESTIGATING, REVIEW_REQUIRED, then a terminal state", async () => {
    const { workspaceId, panelId } = await workspaceWithPanel();
    const markerId = randomUUID();
    await run(workspaceId, "marker.create", {
      panelId,
      markerId,
      anchor: { kind: "time_point", at: "2026-01-01T00:00:00Z" },
    });
    const status = async () => (await k.monitoring.listMarkers(s, workspaceId, markerId))[0]!.status;
    expect(await status()).toBe("DRAFT");
    // illegal skips
    for (const to of ["INVESTIGATING", "REVIEW_REQUIRED", "RESOLVED", "DISMISSED", "MONITORING", "DRAFT"]) {
      const e = await reject(run(workspaceId, "marker.transition", { markerId, to }));
      expect(e.reasonCode).toBe("INVALID_MARKER_TRANSITION");
    }
    await run(workspaceId, "marker.transition", { markerId, to: "ACTIVE" });
    await run(workspaceId, "marker.transition", { markerId, to: "INVESTIGATING" });
    expect((await reject(run(workspaceId, "marker.transition", { markerId, to: "ACTIVE" }))).reasonCode).toBe(
      "INVALID_MARKER_TRANSITION",
    );
    await run(workspaceId, "marker.transition", { markerId, to: "REVIEW_REQUIRED" });
    expect(
      (await reject(run(workspaceId, "marker.transition", { markerId, to: "RESOLVED" }))).reasonCode,
    ).toBe("RESOLUTION_REQUIRED");
    expect(
      (await reject(run(workspaceId, "marker.transition", { markerId, to: "MONITORING" }))).reasonCode,
    ).toBe("MONITOR_RULE_REQUIRED");
    await run(workspaceId, "marker.transition", {
      markerId,
      to: "RESOLVED",
      resolution: "explained by a 12h outage",
    });
    expect(await status()).toBe("RESOLVED");
    expect((await reject(run(workspaceId, "marker.transition", { markerId, to: "ACTIVE" }))).reasonCode).toBe(
      "INVALID_MARKER_TRANSITION",
    );
    const m = (await k.monitoring.listMarkers(s, workspaceId, markerId))[0]!;
    expect(m.resolution).toBe("explained by a 12h outage");
    expect(m.version).toBe(5);
  });

  it("a canvas patch cannot skip the state machine", async () => {
    const { workspaceId, panelId } = await workspaceWithPanel();
    const markerId = randomUUID();
    const mk = (status: string) => ({
      markerId,
      panelId,
      anchor: { kind: "time_point", at: "2026-01-01T00:00:00Z" },
      status,
      createdBy: randomUUID(),
      createdAt: "2026-01-01T00:00:00Z",
    });
    const patch = (rev: number, op: unknown) => ({
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: randomUUID(),
      expectedRevision: rev,
      operations: [op],
    });
    expect(
      (
        await reject(
          run(workspaceId, "canvas.apply_patch", patch(1, { op: "addMarker", marker: mk("RESOLVED") })),
        )
      ).reasonCode,
    ).toBe("INVALID_MARKER_TRANSITION");
    await run(workspaceId, "canvas.apply_patch", patch(1, { op: "addMarker", marker: mk("DRAFT") }));
    await run(workspaceId, "marker.transition", { markerId, to: "ACTIVE" });
    expect(
      (await reject(run(workspaceId, "canvas.apply_patch", patch(2, { op: "removeMarker", markerId }))))
        .reasonCode,
    ).toBe("MARKER_NOT_DELETABLE");
  });

  it("unsaved selections and drafts never start agents; assign needs an ACTIVE marker and a bounded budget", async () => {
    const { workspaceId, panelId } = await workspaceWithPanel();
    const markerId = randomUUID();
    await run(workspaceId, "marker.create", {
      panelId,
      markerId,
      anchor: { kind: "time_range", start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" },
      question: "why the dip?",
      selection: {
        queryHash: "b".repeat(64),
        semanticVersion: "1.0.0",
        interval: { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" },
        seriesIds: ["vol"],
        axisUnits: { vol: "USD" },
        sourceWatermark: "2026-01-02T00:00:00Z",
      },
    });
    expect(
      (await db.admin.query("SELECT count(*)::int n FROM marker_tasks WHERE marker_id=$1", [markerId]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (await reject(run(workspaceId, "marker.assign", { markerId, agents: ["quant"] }))).reasonCode,
    ).toBe("MARKER_NOT_ACTIVE");
    await run(workspaceId, "marker.transition", { markerId, to: "ACTIVE" });
    expect(
      (
        await reject(
          run(workspaceId, "marker.assign", {
            markerId,
            agents: ["quant"],
            budget: { tokens: 10_000_000, toolCalls: 5, usd: 1 },
          }),
        )
      ).reasonCode,
    ).toBe("MARKER_BUDGET_CAP");
    await run(workspaceId, "marker.assign", { markerId, agents: ["quant", "skeptic"] });
    const m = (await k.monitoring.listMarkers(s, workspaceId, markerId))[0]!;
    expect(m).toMatchObject({
      // The marker becomes INVESTIGATING only when the dispatcher has durably started the child (M10 d).
      status: "ACTIVE",
      assignedAgents: ["quant", "skeptic"],
      anchorType: "time_range",
    });
    expect(m.selection?.axisUnits).toEqual({ vol: "USD" });
    expect(await k.monitoring.listTasks(s, workspaceId, markerId)).toHaveLength(1);
  });

  it("is tenant-isolated and role-checked", async () => {
    const { workspaceId, panelId } = await workspaceWithPanel();
    const markerId = randomUUID();
    await run(workspaceId, "marker.create", {
      panelId,
      markerId,
      anchor: { kind: "time_point", at: "2026-01-01T00:00:00Z" },
    });
    expect(
      (await reject(run(workspaceId, "marker.transition", { markerId, to: "ACTIVE" }, other))).reasonCode,
    ).toBe("ACCESS_DENIED");
    expect(
      (await reject(run(workspaceId, "marker.transition", { markerId, to: "ACTIVE" }, viewer))).code,
    ).toBe("FORBIDDEN");
    expect((await reject(k.monitoring.listMarkers(other, workspaceId))).reasonCode).toBe("ACCESS_DENIED");
    // a marker id from another workspace in the same org is "not found" too
    const w2 = await createWs(k, s);
    expect(
      (
        await reject(
          runCmd(k, s, w2.workspaceId, "marker.transition", { markerId, to: "ACTIVE" }, w2.version),
        )
      ).reasonCode,
    ).toBe("ACCESS_DENIED");
  });
});

describe("lenses", () => {
  it("CRUD and compatibility resolution", async () => {
    const { workspaceId, panelId } = await workspaceWithPanel();
    const lensId = randomUUID();
    await run(workspaceId, "lens.create", {
      lensId,
      name: "Q4",
      panelIds: [panelId],
      filter: { timeRange: { start: "2026-01-01T00:00:00Z", end: "2026-02-01T00:00:00Z" } },
    });
    expect(
      (await reject(run(workspaceId, "lens.create", { name: "x", panelIds: [randomUUID()], filter: {} })))
        .reasonCode,
    ).toBe("ACCESS_DENIED");
    const res = await k.monitoring.resolveLens(s, workspaceId, lensId);
    expect(res!.panels).toEqual([expect.objectContaining({ panelId, compatible: true })]);
    await run(workspaceId, "lens.update", { lensId, name: "Q4 v2" });
    expect((await k.monitoring.listLenses(s, workspaceId))[0]).toMatchObject({ name: "Q4 v2", version: 2 });
    await run(workspaceId, "lens.delete", { lensId });
    expect(await k.monitoring.listLenses(s, workspaceId)).toHaveLength(0);
  });
});

describe("monitor rules and scheduler", () => {
  async function ruleFixture(over: Record<string, unknown> = {}) {
    const f = await workspaceWithPanel();
    const sourceId = `src-${randomUUID()}`;
    const ruleId = randomUUID();
    await run(f.workspaceId, "monitor.rule_create", {
      ruleId,
      name: "Volume spike",
      sourceId,
      condition: cmp("vol", "gt", 100),
      ...over,
    });
    return { ...f, sourceId, ruleId };
  }
  const ev = (sourceId: string, minute: number, vol: number | null, mode: "live" | "replay" = "live") => ({
    sourceId,
    watermark: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
    mode,
    values: (vol === null ? {} : { vol }) as Record<string, number>,
  });

  it("debounce, cooldown and frequency are watermark-time and deterministic", async () => {
    const f = await ruleFixture({
      debounceSeconds: 120,
      cooldownSeconds: 600,
      frequency: { minIntervalSeconds: 30 },
    });
    const sch = k.monitorScheduler();
    const outcomes: string[] = [];
    for (const e of [
      ev(f.sourceId, 0, 150),
      ev(f.sourceId, 1, 150),
      ev(f.sourceId, 2, 150),
      ev(f.sourceId, 3, 150),
      ev(f.sourceId, 4, 10),
      ev(f.sourceId, 5, null),
      ev(f.sourceId, 6, 150),
      ev(f.sourceId, 8, 150),
      ev(f.sourceId, 20, 150),
      ev(f.sourceId, 22, 150),
    ])
      outcomes.push((await sch.processEvent(e))[0]!.outcome);
    expect(outcomes).toEqual([
      "debounced",
      "debounced",
      "fired",
      "cooldown",
      "condition_false",
      "no_data",
      "debounced",
      "cooldown",
      "fired",
      "cooldown",
    ]);
  });

  it("disabled rules never execute and re-enable restarts cleanly", async () => {
    const f = await ruleFixture();
    const sch = k.monitorScheduler();
    await run(f.workspaceId, "monitor.rule_disable", { ruleId: f.ruleId });
    // A disabled rule never executes; the event is recorded as skipped (never silently dropped).
    expect((await sch.processEvent(ev(f.sourceId, 0, 500))).map((r) => r.evaluationStatus)).toEqual([
      "skipped_disabled",
    ]);
    expect(
      (await db.admin.query("SELECT count(*)::int n FROM monitor_triggers WHERE rule_id=$1", [f.ruleId]))
        .rows[0].n,
    ).toBe(0);
    await run(f.workspaceId, "monitor.rule_enable", { ruleId: f.ruleId });
    expect((await sch.processEvent(ev(f.sourceId, 1, 500)))[0]!.outcome).toBe("fired");
  });

  it("rejects an over-complex condition and an investigate rule without a marker", async () => {
    const f = await workspaceWithPanel();
    let c: Condition = cmp("v", "gt", 1);
    for (let i = 0; i < 4; i++) c = { kind: "not", term: c };
    expect(
      (await reject(run(f.workspaceId, "monitor.rule_create", { name: "deep", sourceId: "x", condition: c })))
        .reasonCode,
    ).toBe("CONDITION_TOO_COMPLEX");
    expect(
      (
        await reject(
          run(f.workspaceId, "monitor.rule_create", {
            name: "inv",
            sourceId: "x",
            condition: cmp("v", "gt", 1),
            action: "investigate",
          }),
        )
      ).reasonCode,
    ).toBe("MARKER_REQUIRED");
  });

  it("only one scheduler holds the lease; expiry hands it over with a higher fence", async () => {
    const a = k.monitorScheduler({ holder: "a", leaseMs: 400 });
    const b = k.monitorScheduler({ holder: "b", leaseMs: 400 });
    await db.admin.query("DELETE FROM monitor_scheduler_lease");
    expect((await a.acquireLease()).held).toBe(true);
    expect((await b.acquireLease()).held).toBe(false);
    expect((await a.acquireLease()).held).toBe(true);
    await a.releaseLease();
    expect((await b.acquireLease()).held).toBe(true);
    const fence = (await db.admin.query("SELECT fence FROM monitor_scheduler_lease")).rows[0].fence;
    expect(Number(fence)).toBeGreaterThan(1);
    await b.releaseLease();
  });

  it("tick consumes the inbox once, in order, as the lease owner", async () => {
    const f = await ruleFixture();
    await db.admin.query("DELETE FROM monitor_scheduler_lease");
    const sch = k.monitorScheduler({ holder: "t1" });
    const other = k.monitorScheduler({ holder: "t2" });
    expect((await sch.enqueue(ev(f.sourceId, 0, 500))).enqueued).toBe(true);
    expect((await sch.enqueue(ev(f.sourceId, 0, 500))).enqueued).toBe(false);
    const t1 = await sch.tick();
    expect(t1.owner).toBe(true);
    expect((await other.tick()).owner).toBe(false);
    const again = await sch.tick();
    expect(again.events).toBe(0);
    expect((await k.monitoring.listTriggers(s, f.workspaceId)).length).toBe(1);
    await sch.releaseLease();
  });

  it("notification read is recorded once and replay notifications are labelled", async () => {
    const f = await ruleFixture();
    const sch = k.monitorScheduler();
    await sch.processEvent(ev(f.sourceId, 0, 500, "replay"));
    const n = (await k.monitoring.listNotifications(s, f.workspaceId))[0]!;
    expect(n).toMatchObject({ mode: "replay", readAt: null });
    expect(n.title.startsWith("[REPLAY]")).toBe(true);
    await run(f.workspaceId, "notification.read", { notificationId: n.notificationId });
    expect(await k.monitoring.listNotifications(s, f.workspaceId, true)).toHaveLength(0);
    expect(
      (await reject(run(f.workspaceId, "notification.read", { notificationId: n.notificationId }, other)))
        .reasonCode,
    ).toBe("ACCESS_DENIED");
  });
});
