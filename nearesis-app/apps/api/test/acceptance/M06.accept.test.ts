import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { PanelSpec } from "@nearesis/contracts";
import { apiFixture, bearer, login, seedOrg } from "../helpers.ts";
import type { ApiFixture } from "../helpers.ts";

let f: ApiFixture;
beforeAll(async () => {
  f = await apiFixture({ runtime: true });
});
afterAll(async () => f?.close());

/**
 * Backend half of M06 (the visible `replay` badge is asserted by the web acceptance, jointly with F1): a recorded event
 * replayed through the API is flagged `replay` in the trigger, the notification, the journal event and any task, is never
 * reported as live, and a live event with the same watermark is a separate, live record.
 */
it("M06 (backend): historical replay events are flagged replay end to end and never reported as live", async () => {
  const a = await seedOrg(f.db.admin, "m06", { alice: "owner" });
  const tok = await login(f.app, a.users.alice!.subject);
  const ws = (
    await f.app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...bearer(tok), "idempotency-key": "m06-ws-00001" },
      payload: { objective: "o", networkScope: "fixture-only" },
    })
  ).json<{ workspaceId: string }>().workspaceId;
  const cmd = async (commandType: string, payload: Record<string, unknown>) => {
    const v = (
      await f.app.inject({ method: "GET", url: `/v1/workspaces/${ws}`, headers: bearer(tok) })
    ).json<{ version: number }>().version;
    const r = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/commands`,
      headers: bearer(tok),
      payload: { apiVersion: "v1", commandId: randomUUID(), commandType, payload, expectedVersion: v },
    });
    expect(r.statusCode).toBe(200);
  };
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
  await cmd("canvas.apply_patch", {
    schemaVersion: 1,
    type: "workspace.patch",
    operationId: randomUUID(),
    expectedRevision: 0,
    operations: [{ op: "addPanel", panel }],
  });
  const markerId = randomUUID();
  await cmd("marker.create", {
    panelId: panel.panelId,
    markerId,
    anchor: { kind: "time_point", at: "2026-09-01T00:00:00Z" },
  });
  const sourceId = `bq.swaps.${randomUUID().slice(0, 8)}`;
  const ruleId = randomUUID();
  await cmd("monitor.rule_create", {
    ruleId,
    name: "Volume spike",
    markerId,
    sourceId,
    action: "investigate",
    condition: { kind: "compare", metricId: "vol", op: "gt", value: 100 },
  });

  // Replay a recorded (September) event.
  const historical = "2026-09-01T00:00:00.000Z";
  const rep = await f.app.inject({
    method: "POST",
    url: `/v1/workspaces/${ws}/monitors/replay`,
    headers: bearer(tok),
    payload: { sourceId, events: [{ watermark: historical, values: { vol: 400 } }] },
  });
  expect(rep.statusCode).toBe(200);
  expect(rep.json<{ mode: string }>().mode).toBe("replay");

  const get = async (p: string) =>
    (await f.app.inject({ method: "GET", url: `/v1/workspaces/${ws}${p}`, headers: bearer(tok) })).json<
      Record<string, unknown>
    >();
  const triggers = (await get("/monitors/triggers")).triggers as Array<{
    mode: string;
    outcome: string;
    watermark: string;
  }>;
  const notifs = (await get("/notifications")).notifications as Array<{
    mode: string;
    title: string;
    body: string;
  }>;
  const tasks = (await get("/marker-tasks")).tasks as Array<{ mode: string; origin: string }>;
  const journal = (
    await f.db.admin.query(
      "SELECT event_type, payload FROM workspace_events WHERE workspace_id=$1 AND event_type IN ('monitor.triggered','notification.created')",
      [ws],
    )
  ).rows;
  const liveRows = (
    await f.db.admin.query(
      "SELECT (SELECT count(*) FROM monitor_triggers WHERE mode='live' AND workspace_id=$1)::int t, (SELECT count(*) FROM notifications WHERE mode='live' AND workspace_id=$1)::int n, (SELECT count(*) FROM marker_tasks WHERE mode='live' AND workspace_id=$1)::int k, (SELECT count(*) FROM source_watermark_events WHERE source_id=$2)::int inbox",
      [ws, sourceId],
    )
  ).rows[0];

  expect(triggers).toEqual([
    expect.objectContaining({ mode: "replay", outcome: "fired", watermark: historical }),
  ]);
  expect(notifs).toEqual([expect.objectContaining({ mode: "replay" })]);
  expect(notifs[0]!.title.startsWith("[REPLAY]")).toBe(true);
  expect(notifs[0]!.body).toContain("not live data");
  expect(tasks).toEqual([expect.objectContaining({ mode: "replay", origin: "rule" })]);
  expect(journal).toHaveLength(2);
  expect(journal.every((j) => j.payload.mode === "replay")).toBe(true);
  expect(liveRows).toEqual({ t: 0, n: 0, k: 0, inbox: 0 });

  // Negative: a real live event with the same watermark is its own LIVE record, and does not overwrite the replay one.
  const sch = f.kernel.monitorScheduler();
  const liveRes = await sch.processEvent({
    sourceId,
    watermark: historical,
    mode: "live",
    values: { vol: 400 },
  });
  expect(liveRes[0]!.outcome).toBe("fired");
  const after = (await get("/monitors/triggers")).triggers as Array<{ mode: string }>;
  expect(after.map((t) => t.mode).sort()).toEqual(["live", "replay"]);
  // And a replay can never be sent through the live inbox route: there is none, and the API replay route ignores `mode` input.
  const sneaky = await f.app.inject({
    method: "POST",
    url: `/v1/workspaces/${ws}/monitors/replay`,
    headers: bearer(tok),
    payload: { sourceId, mode: "live", events: [{ watermark: "2026-09-02T00:00:00Z", values: { vol: 1 } }] },
  });
  expect(sneaky.statusCode).toBe(422);

  observe({
    testId: "M06",
    observed: `replayed recorded event ${historical} via POST /monitors/replay: trigger.mode=replay (fired), notification.mode=replay with "[REPLAY]" title and a "not live data" body, journal events monitor.triggered + notification.created carry mode=replay, rule-spawned marker task mode=replay; 0 live triggers/notifications/tasks and 0 inbox rows were created; a live event at the same watermark produced a separate live trigger; a request trying to set mode=live on the replay route was rejected (422). BACKEND HALF ONLY: the visible replay badge assertion belongs to the web acceptance`,
    evidence: {
      triggers,
      notificationModes: notifs.map((n) => n.mode),
      taskModes: tasks.map((t) => t.mode),
      journalModes: journal.map((j) => j.payload.mode),
      liveRows,
      scope: "backend-only; UI badge pending F1",
    },
  });
});
