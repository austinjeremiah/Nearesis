import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanvasDocument, PanelSpec } from "@nearesis/contracts";
import type { CanvasPatch } from "@nearesis/contracts";
import { KernelError } from "../src/index.ts";
import type { Kernel, Session } from "../src/index.ts";
import { createTestDb, createWs, loginSession, runCmd, seedOrg, testKernel } from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";

const panel = (over: Record<string, unknown> = {}) =>
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
    ...over,
  });
const patch = (expectedRevision: number, operations: unknown[]): CanvasPatch =>
  ({
    schemaVersion: 1,
    type: "workspace.patch",
    operationId: randomUUID(),
    expectedRevision,
    operations,
  }) as CanvasPatch;
const marker = (panelId: string) => ({
  markerId: randomUUID(),
  panelId,
  anchor: { kind: "time_point", at: "2026-01-01T00:00:00Z" },
  status: "DRAFT",
  createdBy: randomUUID(),
  createdAt: "2026-01-01T00:00:00Z",
});

const asErr = (p: Promise<unknown>): Promise<KernelError> =>
  p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => e as KernelError,
  );

let db: TestDb;
let k: Kernel;
let s: Session;
let other: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  const a = await seedOrg(db.admin, "cv", { alice: "owner" });
  const b = await seedOrg(db.admin, "cv2", { bob: "owner" });
  s = await loginSession(k, a.users.alice!.subject);
  other = await loginSession(k, b.users.bob!.subject);
});
afterAll(async () => db?.drop());

const counts = async (ws: string) => ({
  events: (await db.admin.query("SELECT count(*)::int n FROM workspace_events WHERE workspace_id=$1", [ws]))
    .rows[0].n as number,
  panels: (
    await db.admin.query(
      "SELECT count(*)::int n FROM panel_specs WHERE workspace_id=$1 AND removed_at IS NULL",
      [ws],
    )
  ).rows[0].n as number,
  version: (await db.admin.query("SELECT version FROM workspaces WHERE id=$1", [ws])).rows[0]
    .version as number,
});

describe("canvas.apply_patch", () => {
  it("applies a patch, persists it, and survives a fresh kernel (reload)", async () => {
    const { workspaceId, version } = await createWs(k, s);
    const p1 = panel();
    const r = await runCmd(
      k,
      s,
      workspaceId,
      "canvas.apply_patch",
      patch(0, [
        { op: "addPanel", panel: p1 },
        { op: "addMarker", marker: marker(p1.panelId) },
      ]),
      version,
    );
    expect(r.workspaceVersion).toBe(2);
    const doc = await k.canvas.get(s, workspaceId);
    expect(() => CanvasDocument.parse(doc)).not.toThrow();
    expect(doc).toMatchObject({ documentRevision: 1, dataRevision: 0 });
    expect(doc.panels).toHaveLength(1);
    expect(doc.markers).toHaveLength(1);
    const fresh = testKernel(db);
    expect(await fresh.canvas.get(s, workspaceId)).toEqual(doc);
    const ev = (
      await db.admin.query(
        "SELECT event_type, payload FROM workspace_events WHERE workspace_id=$1 ORDER BY seq",
        [workspaceId],
      )
    ).rows;
    expect(ev.map((e) => e.event_type)).toEqual(["workspace.created", "canvas.patched"]);
    expect(ev[1].payload.documentRevision).toBe(1);
  });

  it("rejects a stale expectedRevision with 409 and no mutation", async () => {
    const { workspaceId, version } = await createWs(k, s);
    await runCmd(
      k,
      s,
      workspaceId,
      "canvas.apply_patch",
      patch(0, [{ op: "addPanel", panel: panel() }]),
      version,
    );
    const before = await counts(workspaceId);
    const err = await asErr(
      runCmd(
        k,
        s,
        workspaceId,
        "canvas.apply_patch",
        patch(0, [{ op: "addPanel", panel: panel() }]),
        version + 1,
      ),
    );
    expect(err).toMatchObject({ code: "STALE_VERSION", reasonCode: "STALE_DOCUMENT_REVISION" });
    expect(err.opts.lastStableRevision).toBe(1);
    expect(await counts(workspaceId)).toEqual(before);
  });

  it("is atomic: one bad operation rejects the whole patch with a per-op report (422)", async () => {
    const { workspaceId, version } = await createWs(k, s);
    const good = panel();
    const before = await counts(workspaceId);
    const err = await asErr(
      runCmd(
        k,
        s,
        workspaceId,
        "canvas.apply_patch",
        patch(0, [
          { op: "addPanel", panel: good },
          { op: "movePanel", panelId: randomUUID(), layout: { x: 0, y: 0, w: 1, h: 1 } },
          { op: "addMarker", marker: marker(randomUUID()) },
        ]),
        version,
      ),
    );
    expect(err).toMatchObject({ code: "VALIDATION_FAILED", reasonCode: "PATCH_REJECTED" });
    expect(err.opts.details?.map((d: { path: string }) => d.path)).toEqual([
      "operations.1.panelId",
      "operations.2.marker.panelId",
    ]);
    expect(await counts(workspaceId)).toEqual(before);
    expect((await k.canvas.get(s, workspaceId)).documentRevision).toBe(0);
    // Schema-invalid payload is also a 422 with details.
    const bad = await asErr(
      runCmd(
        k,
        s,
        workspaceId,
        "canvas.apply_patch",
        { ...patch(0, [{ op: "addPanel", panel: { nope: 1 } }]) },
        version,
      ),
    );
    expect(bad).toMatchObject({ code: "VALIDATION_FAILED", reasonCode: "INVALID_PATCH" });
    expect(bad.opts.details!.length).toBeGreaterThan(0);
  });

  it("replays by operationId without re-applying", async () => {
    const { workspaceId, version } = await createWs(k, s);
    const p = patch(0, [{ op: "addPanel", panel: panel() }]);
    const r1 = await runCmd(k, s, workspaceId, "canvas.apply_patch", p, version);
    const r2 = await runCmd(k, s, workspaceId, "canvas.apply_patch", p, version);
    expect(r2).toEqual(r1);
    expect((await counts(workspaceId)).panels).toBe(1);
  });

  it("update, move, remove and selection ops; removal drops the panel's markers from the document", async () => {
    const { workspaceId, version } = await createWs(k, s);
    const p1 = panel();
    await runCmd(
      k,
      s,
      workspaceId,
      "canvas.apply_patch",
      patch(0, [
        { op: "addPanel", panel: p1 },
        { op: "addMarker", marker: marker(p1.panelId) },
      ]),
      version,
    );
    await runCmd(
      k,
      s,
      workspaceId,
      "canvas.apply_patch",
      patch(1, [
        { op: "movePanel", panelId: p1.panelId, layout: { x: 3, y: 3, w: 3, h: 3 } },
        {
          op: "updatePanel",
          panelId: p1.panelId,
          panel: { ...p1, title: "Renamed", layout: { x: 3, y: 3, w: 3, h: 3 } },
        },
      ]),
      version + 1,
    );
    let doc = await k.canvas.get(s, workspaceId);
    expect(doc.panels[0]).toMatchObject({ title: "Renamed", layout: { x: 3, y: 3, w: 3, h: 3 } });
    expect(doc.documentRevision).toBe(2);
    await runCmd(
      k,
      s,
      workspaceId,
      "canvas.apply_patch",
      patch(2, [{ op: "removePanel", panelId: p1.panelId }]),
      version + 2,
    );
    doc = await k.canvas.get(s, workspaceId);
    expect(doc.panels).toHaveLength(0);
    expect(doc.markers).toHaveLength(0);
    expect(doc.documentRevision).toBe(3);
  });

  it("keeps dataRevision separate from documentRevision", async () => {
    const { workspaceId, version } = await createWs(k, s);
    await runCmd(
      k,
      s,
      workspaceId,
      "canvas.apply_patch",
      patch(0, [{ op: "addPanel", panel: panel() }]),
      version,
    );
    expect(await k.canvas.bumpDataRevision(s, workspaceId)).toBe(1);
    const doc = await k.canvas.get(s, workspaceId);
    expect(doc).toMatchObject({ documentRevision: 1, dataRevision: 1 });
  });

  it("runs the semanticValidator hook inside the transaction and rejects with 422", async () => {
    const kv = testKernel(db);
    const kk = new (
      kv.constructor as new (c: ConstructorParameters<typeof import("../src/index.ts").Kernel>[0]) => Kernel
    )({
      db: db.app,
      plugins: kv.plugins.config,
      sessionSecret: "test-session-secret-0123456789abcdef",
      nodeEnv: "test",
      semanticValidator: (_doc, p) => ({
        ok: false,
        errors: [{ path: "patch.operations.0", message: `blocked ${p.operations.length} op(s)` }],
      }),
    });
    const { workspaceId, version } = await createWs(kk, s);
    const err = await asErr(
      runCmd(
        kk,
        s,
        workspaceId,
        "canvas.apply_patch",
        patch(0, [{ op: "addPanel", panel: panel() }]),
        version,
      ),
    );
    expect(err).toMatchObject({ code: "VALIDATION_FAILED", reasonCode: "PATCH_REJECTED" });
    expect(err.opts.details).toEqual([{ path: "patch.operations.0", issue: "blocked 1 op(s)" }]);
    expect((await counts(workspaceId)).panels).toBe(0);
  });

  it("does not expose another tenant's canvas", async () => {
    const { workspaceId } = await createWs(k, s);
    await expect(k.canvas.get(other, workspaceId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      runCmd(k, other, workspaceId, "canvas.apply_patch", patch(0, [{ op: "addPanel", panel: panel() }]), 1),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await counts(workspaceId)).panels).toBe(0);
  });
});
