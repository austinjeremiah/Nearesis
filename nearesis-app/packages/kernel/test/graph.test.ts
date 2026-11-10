import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PanelSpec } from "@nearesis/contracts";
import type { CanvasPatch } from "@nearesis/contracts";
import { KernelError } from "../src/index.ts";
import type { Kernel, Session } from "../src/index.ts";
import { createTestDb, createWs, loginSession, runCmd, seedOrg, testKernel } from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";

const panel = () =>
  PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: "Volume",
    queryRef: { hash: "b".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["ts", "vol"], units: { vol: "USD" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "ts", y: ["vol"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
  });

let db: TestDb;
let k: Kernel;
let owner: Session;
let viewer: Session;
let outsider: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  const a = await seedOrg(db.admin, "gr", { alice: "owner", vic: "viewer" });
  const b = await seedOrg(db.admin, "gr2", { bob: "owner" });
  owner = await loginSession(k, a.users.alice!.subject);
  viewer = await loginSession(k, a.users.vic!.subject);
  outsider = await loginSession(k, b.users.bob!.subject);
});
afterAll(async () => db?.drop());

async function seeded() {
  const { workspaceId, version } = await createWs(k, owner);
  const p = panel();
  const patch: CanvasPatch = {
    schemaVersion: 1,
    type: "workspace.patch",
    operationId: randomUUID(),
    expectedRevision: 0,
    operations: [{ op: "addPanel", panel: p }],
  } as CanvasPatch;
  const r1 = await runCmd(k, owner, workspaceId, "canvas.apply_patch", patch, version);
  const markerId = randomUUID();
  const r2 = await runCmd(
    k,
    owner,
    workspaceId,
    "marker.create",
    { panelId: p.panelId, markerId, anchor: { kind: "time_point", at: "2026-01-01T00:00:00Z" } },
    r1.workspaceVersion,
  );
  return { workspaceId, panelId: p.panelId, markerId, version: r2.workspaceVersion };
}

async function seedNode(orgId: string, workspaceId: string, kind: string, label: string) {
  const id = randomUUID();
  await db.admin.query(
    "INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label) VALUES ($1,$2,$3,$4,$5)",
    [id, orgId, workspaceId, kind, label],
  );
  return id;
}
async function seedEdge(orgId: string, workspaceId: string, from: string, to: string, relation: string) {
  const id = randomUUID();
  await db.admin.query(
    "INSERT INTO evidence_edges(id, org_id, workspace_id, from_node, to_node, relation) VALUES ($1,$2,$3,$4,$5,$6)",
    [id, orgId, workspaceId, from, to, relation],
  );
  return id;
}

describe("evidence graph projection", () => {
  it("projects panels as query nodes with queryRef, markers, and evidence nodes/edges", async () => {
    const w = await seeded();
    const org = owner.principal.orgId;
    const h = await seedNode(org, w.workspaceId, "hypothesis", "Fees rose");
    const o = await seedNode(org, w.workspaceId, "observation", "Volume up 3x");
    const e1 = await seedEdge(org, w.workspaceId, o, h, "supports");
    await seedEdge(org, w.workspaceId, w.panelId, o, "derived_from");
    const g = await k.graph.get(viewer, w.workspaceId);
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get(w.panelId)).toMatchObject({ type: "query", label: "Volume", queryRef: "b".repeat(64) });
    expect(byId.get(w.markerId)?.type).toBe("marker");
    expect(byId.get(h)?.type).toBe("hypothesis");
    expect(byId.get(o)?.type).toBe("observation");
    expect(g.edges.find((e) => e.id === e1)).toMatchObject({ source: o, target: h, relation: "supports" });
    expect(g.edges.some((e) => e.relation === "references" && e.source === w.markerId)).toBe(true);
    expect(g.unresolved).toEqual([]);
    expect(g.version).toBe(w.version);
  });

  it("omits edges to missing nodes and lists them in unresolved[]", async () => {
    const w = await seeded();
    const org = owner.principal.orgId;
    const h = await seedNode(org, w.workspaceId, "hypothesis", "H");
    const ghost = randomUUID();
    const bad = await seedEdge(org, w.workspaceId, ghost, h, "contradicts");
    const g = await k.graph.get(owner, w.workspaceId);
    expect(g.edges.find((e) => e.id === bad)).toBeUndefined();
    expect(g.unresolved).toEqual([
      expect.objectContaining({ id: bad, source: ghost, target: h, missing: ["source"] }),
    ]);
  });

  it("relation values are confined to the ch.10 enum by the database", async () => {
    const w = await seeded();
    const org = owner.principal.orgId;
    const a = await seedNode(org, w.workspaceId, "source", "S");
    await expect(seedEdge(org, w.workspaceId, a, a, "invented")).rejects.toThrow();
    await expect(seedNode(org, w.workspaceId, "widget", "x")).rejects.toThrow();
  });

  it("outsiders get the same error as for an unknown workspace", async () => {
    const w = await seeded();
    const foreign = await k.graph.get(outsider, w.workspaceId).catch((e) => e as KernelError);
    const unknown = await k.graph.get(outsider, randomUUID()).catch((e) => e as KernelError);
    expect(foreign).toBeInstanceOf(KernelError);
    expect(unknown).toBeInstanceOf(KernelError);
    expect({ code: (foreign as KernelError).code, rc: (foreign as KernelError).reasonCode }).toEqual({
      code: (unknown as KernelError).code,
      rc: (unknown as KernelError).reasonCode,
    });
  });

  it("an outsider sees none of another tenant's evidence rows (RLS)", async () => {
    const w = await seeded();
    await seedNode(owner.principal.orgId, w.workspaceId, "model", "M");
    const rows = await k.db.tx({ orgId: outsider.principal.orgId, userId: outsider.userId }, async (tx) => {
      const out: number[] = [];
      for (const t of ["evidence_nodes", "evidence_edges", "graph_layouts"])
        out.push((await tx.query(`SELECT 1 FROM ${t}`)).rows.length);
      return out;
    });
    expect(rows).toEqual([0, 0, 0]);
  });
});

describe("graph.save_layout", () => {
  it("persists positions through the command bus (version, event, outbox) and applies them to nodes", async () => {
    const w = await seeded();
    const before = (
      await db.admin.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1", [w.workspaceId])
    ).rows[0].n as number;
    const r = await runCmd(
      k,
      owner,
      w.workspaceId,
      "graph.save_layout",
      { positions: { [w.panelId]: { x: 10, y: 20 }, [randomUUID()]: { x: 1, y: 2 } } },
      w.version,
    );
    expect(r.workspaceVersion).toBe(w.version + 1);
    const ev = (
      await db.admin.query(
        "SELECT event_type, payload FROM workspace_events WHERE workspace_id=$1 AND seq=$2",
        [w.workspaceId, r.eventSeq],
      )
    ).rows[0];
    expect(ev.event_type).toBe("workspace.updated");
    expect(ev.payload).toMatchObject({ change: "graph.layout_saved", nodeCount: 2 });
    const after = (
      await db.admin.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1", [w.workspaceId])
    ).rows[0].n as number;
    expect(after).toBe(before + 1);
    const g = await k.graph.get(owner, w.workspaceId);
    expect(g.nodes.find((n) => n.id === w.panelId)?.position).toEqual({ x: 10, y: 20 });
  });

  it("stale expectedVersion is rejected and nothing is written", async () => {
    const w = await seeded();
    await expect(
      runCmd(k, owner, w.workspaceId, "graph.save_layout", { positions: {} }, w.version - 1),
    ).rejects.toMatchObject({ code: "STALE_VERSION" });
    const n = (
      await db.admin.query("SELECT count(*)::int n FROM graph_layouts WHERE workspace_id=$1", [w.workspaceId])
    ).rows[0].n;
    expect(n).toBe(0);
  });

  it("viewers and outsiders cannot save layouts; invalid payloads are 422", async () => {
    const w = await seeded();
    await expect(
      runCmd(k, viewer, w.workspaceId, "graph.save_layout", { positions: {} }, w.version),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      runCmd(k, outsider, w.workspaceId, "graph.save_layout", { positions: {} }, w.version),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const bad of [
      { positions: { a: { x: "1", y: 2 } } },
      { positions: { a: { x: 1, y: 2, z: 3 } } },
      { positions: { a: { x: 1e9, y: 2 } } },
      { positions: [] },
      { extra: 1, positions: {} },
    ])
      await expect(
        runCmd(k, owner, w.workspaceId, "graph.save_layout", bad, w.version),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
  });
});
