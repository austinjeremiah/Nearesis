import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PanelSpec } from "@nearesis/contracts";
import { apiFixture, bearer, login, sansTrace, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

let f: ApiFixture;
let tokA: string;
let tokB: string;
let tokViewer: string;
let ws: string;
let panelId: string;
const scoped = (p: string) => `/v1/workspaces/${ws}${p}`;
async function cmd(token: string, commandType: string, payload: Record<string, unknown>, workspace = ws) {
  const w = await f.app.inject({ method: "GET", url: `/v1/workspaces/${workspace}`, headers: bearer(token) });
  const version = (w.json() as { version: number }).version;
  return f.app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspace}/commands`,
    headers: bearer(token),
    payload: { apiVersion: "v1", commandId: randomUUID(), commandType, payload, expectedVersion: version },
  });
}
beforeAll(async () => {
  f = await apiFixture({ runtime: true });
  const a = await seedOrg(f.db.admin, "mon-api", { alice: "owner", vic: "viewer" });
  const b = await seedOrg(f.db.admin, "mon-api-b", { bob: "owner" });
  tokA = await login(f.app, a.users.alice!.subject);
  tokViewer = await login(f.app, a.users.vic!.subject);
  tokB = await login(f.app, b.users.bob!.subject);
  ws = (
    await f.app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...bearer(tokA), "idempotency-key": "mon-api-ws-0001" },
      payload: { objective: "o", networkScope: "fixture-only" },
    })
  ).json<{ workspaceId: string }>().workspaceId;
  const panel = PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: "Vol",
    queryRef: { hash: "a".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["ts", "vol"], units: { vol: "USD" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "ts", y: ["vol"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
  });
  panelId = panel.panelId;
  const r = await cmd(tokA, "canvas.apply_patch", {
    schemaVersion: 1,
    type: "workspace.patch",
    operationId: randomUUID(),
    expectedRevision: 0,
    operations: [{ op: "addPanel", panel }],
  });
  expect(r.statusCode).toBe(200);
});
afterAll(async () => f?.close());

describe("monitoring API", () => {
  it("serves marker, lens, rule, trigger, notification and task reads; outsiders get the same 404 as unknown workspaces", async () => {
    const markerId = randomUUID();
    expect(
      (
        await cmd(tokA, "marker.create", {
          panelId,
          markerId,
          anchor: {
            kind: "source_event",
            sourceId: "explorer.swaps",
            eventId: "tx-1",
            at: "2026-10-28T00:00:00Z",
          },
        })
      ).statusCode,
    ).toBe(200);
    const lensId = randomUUID();
    expect(
      (
        await cmd(tokA, "lens.create", {
          lensId,
          name: "week",
          panelIds: [panelId],
          filter: { timeRange: { start: "2026-10-20T00:00:00Z", end: "2026-10-27T00:00:00Z" } },
        })
      ).statusCode,
    ).toBe(200);
    const sourceId = `src-${randomUUID().slice(0, 8)}`;
    expect(
      (
        await cmd(tokA, "monitor.rule_create", {
          name: "r",
          sourceId,
          condition: { kind: "compare", metricId: "v", op: "gt", value: 1 },
        })
      ).statusCode,
    ).toBe(200);

    const get = (url: string, token = tokA) => f.app.inject({ method: "GET", url, headers: bearer(token) });
    const markers = (await get(scoped("/markers"))).json<{
      markers: Array<{ markerId: string; anchorType: string }>;
    }>();
    expect(markers.markers).toEqual([expect.objectContaining({ markerId, anchorType: "source_event" })]);
    expect((await get(scoped(`/markers/${markerId}`))).json()).toMatchObject({ markerId, status: "DRAFT" });
    expect(
      (await get(scoped(`/lenses/${lensId}/resolution`))).json<{ panels: Array<{ compatible: boolean }> }>()
        .panels[0]!.compatible,
    ).toBe(true);
    expect((await get(scoped("/monitors"))).json<{ rules: unknown[] }>().rules).toHaveLength(1);
    expect((await get(scoped("/monitors/triggers"))).json()).toEqual({ triggers: [] });
    expect((await get(scoped("/notifications"))).json()).toEqual({ notifications: [] });
    expect((await get(scoped("/marker-tasks"))).json()).toEqual({ tasks: [] });

    // A viewer can read, cannot write.
    expect((await get(scoped("/markers"), tokViewer)).statusCode).toBe(200);
    expect((await cmd(tokViewer, "marker.transition", { markerId, to: "ACTIVE" })).statusCode).toBe(403);

    // Foreign tenant, unknown workspace, malformed ids: indistinguishable 404 on every read.
    const unknown = randomUUID();
    for (const p of [
      "/markers",
      `/markers/${markerId}`,
      `/markers/${markerId}/tasks`,
      "/lenses",
      `/lenses/${lensId}/resolution`,
      "/monitors",
      "/monitors/triggers",
      "/notifications",
      "/marker-tasks",
    ]) {
      const foreign = await get(scoped(p), tokB);
      const missing = await get(`/v1/workspaces/${unknown}${p}`, tokB);
      expect(foreign.statusCode, p).toBe(404);
      expect(missing.statusCode, p).toBe(404);
      expect(sansTrace(foreign.json())).toEqual(sansTrace(missing.json()));
    }
    expect((await get(scoped("/markers/not-a-uuid"))).statusCode).toBe(404);
    expect((await get(scoped(`/markers/${randomUUID()}`))).statusCode).toBe(404);
    expect((await f.app.inject({ method: "GET", url: scoped("/markers") })).statusCode).toBe(401);
    // Foreign tenant cannot post markers, dispatch or replay either.
    for (const [method, p, body] of [
      ["POST", "/markers", { panelId, anchor: { kind: "time_point", at: "2026-01-01T00:00:00Z" } }],
      ["POST", "/marker-tasks/dispatch", {}],
      [
        "POST",
        "/monitors/replay",
        { sourceId, events: [{ watermark: "2026-01-01T00:00:00Z", values: { v: 5 } }] },
      ],
    ] as const) {
      const r = await f.app.inject({ method, url: scoped(p), headers: bearer(tokB), payload: body });
      expect(r.statusCode, p).toBe(404);
    }
    // Rejecting bad bodies.
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: scoped("/markers"),
          headers: bearer(tokA),
          payload: { panelId, anchor: { kind: "time_point", at: "2026-01-01T00:00:00Z" }, extra: 1 },
        })
      ).statusCode,
    ).toBe(422);
  });

  it("replay is scoped to the caller's workspace and flagged replay in every record", async () => {
    const sourceId = `replay-${randomUUID().slice(0, 8)}`;
    // Another tenant listening to the same source must never fire from our replay.
    const bws = (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(tokB), "idempotency-key": "mon-api-ws-0002" },
        payload: { objective: "o", networkScope: "fixture-only" },
      })
    ).json<{ workspaceId: string }>().workspaceId;
    expect(
      (
        await cmd(
          tokB,
          "monitor.rule_create",
          { name: "other", sourceId, condition: { kind: "compare", metricId: "v", op: "gt", value: 1 } },
          bws,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await cmd(tokA, "monitor.rule_create", {
          name: "mine",
          sourceId,
          condition: { kind: "compare", metricId: "v", op: "gt", value: 1 },
        })
      ).statusCode,
    ).toBe(200);
    const r = await f.app.inject({
      method: "POST",
      url: scoped("/monitors/replay"),
      headers: bearer(tokA),
      payload: {
        sourceId,
        events: [
          { watermark: "2026-10-28T02:00:00Z", values: { v: 9 } },
          { watermark: "2026-10-28T01:00:00Z", values: { v: 9 } },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ mode: "replay", processed: 2 });
    const notifs = (
      await f.app.inject({ method: "GET", url: scoped("/notifications"), headers: bearer(tokA) })
    ).json<{ notifications: Array<{ mode: string; title: string }> }>().notifications;
    expect(notifs.length).toBeGreaterThan(0);
    expect(notifs.every((n) => n.mode === "replay" && n.title.startsWith("[REPLAY]"))).toBe(true);
    const otherTriggers = await f.db.admin.query(
      "SELECT count(*)::int n FROM monitor_triggers WHERE workspace_id=$1",
      [bws],
    );
    expect(otherTriggers.rows[0].n).toBe(0);
    expect(
      (
        await f.db.admin.query("SELECT count(*)::int n FROM source_watermark_events WHERE source_id=$1", [
          sourceId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });
});
