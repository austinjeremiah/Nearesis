import { randomUUID } from "node:crypto";
import { PanelSpec } from "@nearesis/contracts";
import type { CanvasPatch } from "@nearesis/contracts";
import { historyService } from "../../src/index.ts";
import type { Kernel, Session } from "../../src/index.ts";
import { createTestDb, createWs, loginSession, runCmd, seedOrg, testKernel } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";

export const panel = (title = "Volume") =>
  PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title,
    queryRef: { hash: "b".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["ts", "vol"], units: { vol: "USD" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "ts", y: ["vol"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
  });

export interface World {
  db: TestDb;
  k: Kernel;
  h: ReturnType<typeof historyService>;
  orgA: Awaited<ReturnType<typeof seedOrg>>;
  orgB: Awaited<ReturnType<typeof seedOrg>>;
  owner: Session;
  analyst: Session;
  viewer: Session;
  outsider: Session;
}

export async function world(tag: string): Promise<World> {
  const db = await createTestDb();
  const k = testKernel(db);
  const orgA = await seedOrg(db.admin, `${tag}a`, { alice: "owner", ann: "analyst", vic: "viewer" });
  const orgB = await seedOrg(db.admin, `${tag}b`, { bob: "owner" });
  return {
    db,
    k,
    h: historyService(k),
    orgA,
    orgB,
    owner: await loginSession(k, orgA.users.alice!.subject),
    analyst: await loginSession(k, orgA.users.ann!.subject),
    viewer: await loginSession(k, orgA.users.vic!.subject),
    outsider: await loginSession(k, orgB.users.bob!.subject),
  };
}

export async function newWs(w: World, s: Session = w.owner) {
  const r = await createWs(w.k, s);
  return { workspaceId: r.workspaceId, version: r.version };
}

export const wsVersion = async (w: World, id: string): Promise<number> =>
  (await w.db.admin.query("SELECT version FROM workspaces WHERE id = $1", [id])).rows[0].version;

/** Add a panel through the real canvas command; returns the new workspace version. */
export async function addPanel(w: World, workspaceId: string, expectedRevision: number, p = panel()) {
  const patch = {
    schemaVersion: 1,
    type: "workspace.patch",
    operationId: randomUUID(),
    expectedRevision,
    operations: [{ op: "addPanel", panel: p }],
  } as CanvasPatch;
  const v = await wsVersion(w, workspaceId);
  const r = await runCmd(w.k, w.owner, workspaceId, "canvas.apply_patch", patch, v);
  return { panel: p, version: r.workspaceVersion };
}

export async function addNode(
  w: World,
  workspaceId: string,
  kind: string,
  label: string,
  extra: { data?: Record<string, unknown>; semanticPins?: Record<string, string> } = {},
  s: Session = w.owner,
) {
  const r = await w.h.graphOps.addNode(s, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    kind,
    label,
    ...extra,
  });
  return r.result.nodeId as string;
}

export async function addEdge(w: World, workspaceId: string, from: string, to: string, relation: string) {
  return w.h.graphOps.addEdge(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    from,
    to,
    relation,
  });
}

export async function snapshot(
  w: World,
  workspaceId: string,
  label: string,
  extra: Record<string, unknown> = {},
) {
  const r = await w.h.snapshots.create(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    label,
    ...extra,
  });
  return r.result as { snapshotId: string; contentHash: string; documentRevision: number };
}

export async function rejection(p: Promise<unknown>) {
  const { KernelError } = await import("../../src/index.ts");
  try {
    await p;
  } catch (e) {
    if (!(e instanceof KernelError)) throw e;
    return e;
  }
  throw new Error("expected rejection");
}
