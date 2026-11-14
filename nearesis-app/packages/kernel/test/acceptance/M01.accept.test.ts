import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { PanelSpec, SelectionContext } from "@nearesis/contracts";
import { createTestDb, createWs, loginSession, runCmd, seedOrg, testKernel } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";
import type { Kernel, Session } from "../../src/index.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  s = await loginSession(k, (await seedOrg(db.admin, "m01", { alice: "owner" })).users.alice!.subject);
});
afterAll(async () => db?.drop());

it("M01: a chart selection stored as a marker keeps the selected query, interval, series and units exactly", async () => {
  const { workspaceId } = await createWs(k, s);
  const panel = PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: "Swap volume",
    queryRef: { hash: "c".repeat(64), semanticVersion: "1.2.0", snapshotPolicy: "live" },
    dataBinding: {
      fields: ["day", "usd_volume", "swaps"],
      units: { usd_volume: "USD", swaps: "count" },
      timezone: "UTC",
      completeness: "complete",
    },
    encoding: { x: "day", y: ["usd_volume", "swaps"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "on_watermark" },
    provenanceRequired: true,
  });
  const v0 = (await k.workspaces.get(s, workspaceId)).version;
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
      operations: [{ op: "addPanel", panel }],
    },
    v0,
  );

  // What the chart reports for a drag-selected range.
  const selection = SelectionContext.parse({
    queryHash: panel.queryRef.hash,
    semanticVersion: panel.queryRef.semanticVersion,
    interval: { start: "2026-10-20T00:00:00.000Z", end: "2026-10-27T23:59:59.000Z" },
    seriesIds: ["usd_volume", "swaps"],
    axisUnits: { usd_volume: "USD", swaps: "count" },
    sourceWatermark: "2026-10-28T06:00:00.000Z",
  });
  const markerId = randomUUID();
  const anchor = {
    kind: "time_range" as const,
    start: selection.interval.start,
    end: selection.interval.end,
  };
  await runCmd(
    k,
    s,
    workspaceId,
    "marker.create",
    {
      panelId: panel.panelId,
      markerId,
      anchor,
      question: "Why did volume fall after the regime change?",
      selection,
    },
    (await k.workspaces.get(s, workspaceId)).version,
  );

  // Read back through a fresh kernel (nothing cached) and straight from the table.
  const fresh = testKernel(db);
  const [m] = await fresh.monitoring.listMarkers(s, workspaceId, markerId);
  const row = (
    await db.admin.query(
      "SELECT anchor_type, anchor_json, selection_json, source_version, status, created_by FROM markers WHERE id=$1",
      [markerId],
    )
  ).rows[0];

  expect(m!.selection).toEqual(selection);
  expect(m!.selection!.queryHash).toBe(panel.queryRef.hash);
  expect(m!.selection!.semanticVersion).toBe("1.2.0");
  expect(m!.selection!.interval).toEqual(selection.interval);
  expect(m!.selection!.seriesIds).toEqual(["usd_volume", "swaps"]);
  expect(m!.selection!.axisUnits).toEqual({ usd_volume: "USD", swaps: "count" });
  expect(m!.selection!.sourceWatermark).toBe(selection.sourceWatermark);
  expect(m).toMatchObject({
    anchorType: "time_range",
    anchor,
    sourcePanelId: panel.panelId,
    status: "DRAFT",
    sourceVersion: 1,
    createdBy: s.userId,
    question: "Why did volume fall after the regime change?",
    assignedAgents: [],
    linkedEvidenceIds: [],
    monitorRuleId: null,
    resolution: null,
  });
  expect(row.selection_json).toEqual(selection);
  expect(row.anchor_type).toBe("time_range");

  // Negative: a selection that drops its units (or carries stray fields) is rejected and nothing is stored.
  const { axisUnits: _u, ...noUnits } = selection;
  const before = (
    await db.admin.query("SELECT count(*)::int n FROM markers WHERE workspace_id=$1", [workspaceId])
  ).rows[0].n;
  await expect(
    runCmd(
      k,
      s,
      workspaceId,
      "marker.create",
      { panelId: panel.panelId, anchor, selection: noUnits },
      (await k.workspaces.get(s, workspaceId)).version,
    ),
  ).rejects.toMatchObject({ reasonCode: "INVALID_PAYLOAD" });
  expect(
    (await db.admin.query("SELECT count(*)::int n FROM markers WHERE workspace_id=$1", [workspaceId])).rows[0]
      .n,
  ).toBe(before);
  // A selection alone starts no agent work.
  expect(
    (await db.admin.query("SELECT count(*)::int n FROM marker_tasks WHERE workspace_id=$1", [workspaceId]))
      .rows[0].n,
  ).toBe(0);

  observe({
    testId: "M01",
    observed: `marker ${markerId.slice(0, 8)} stored selection query=${selection.queryHash.slice(0, 12)} semantic=1.2.0 interval=${selection.interval.start}..${selection.interval.end} series=[usd_volume,swaps] units={usd_volume:USD,swaps:count} watermark=${selection.sourceWatermark}; identical when read by a fresh kernel and from the row; selection without units rejected (INVALID_PAYLOAD) with 0 rows written; 0 marker tasks created by the selection`,
    fixtureHash: panel.queryRef.hash,
    evidence: { markerId, anchorType: "time_range", status: m!.status, selection: m!.selection },
  });
});
