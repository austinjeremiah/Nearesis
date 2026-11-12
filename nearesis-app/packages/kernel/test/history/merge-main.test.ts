import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addEdge,
  addNode,
  addPanel,
  newWs,
  panel,
  rejection,
  snapshot,
  world,
  wsVersion,
} from "./helpers.ts";
import type { World } from "./helpers.ts";

/**
 * Merge acceptance into main applies every changed object kind: nodes, edges (including deletions), metrics and
 * PANELS (as one canvas patch against the live document). Nothing is reported as deferred, a rejected canvas patch
 * aborts the whole merge, and the event log alone rebuilds the merged state (Time Machine).
 */
let w: World;
beforeAll(async () => {
  w = await world("mm");
}, 120_000);
afterAll(async () => w?.db.drop());

async function branchFrom(workspaceId: string, name: string, base: { snapshotId: string }) {
  return (
    await w.h.branches.create(w.owner, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      fromSnapshotId: base.snapshotId,
      name,
    })
  ).result.branchId as string;
}
async function change(workspaceId: string, b: string, ops: unknown[]) {
  await w.h.branches.change(w.owner, workspaceId, b, {
    expectedVersion: await wsVersion(w, workspaceId),
    ops,
  } as never);
}
async function mergeToMain(workspaceId: string, b: string) {
  const p = (
    await w.h.branches.proposeMerge(w.owner, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      sourceBranchId: b,
    })
  ).result.proposalId as string;
  return w.h.branches.acceptMerge(w.owner, workspaceId, p, {
    expectedVersion: await wsVersion(w, workspaceId),
  });
}
const livePanels = async (workspaceId: string) =>
  (await w.k.canvas.get(w.owner, workspaceId)).panels as Array<{ panelId: string; title: string }>;

describe("merge into main applies panels and edge deletions", () => {
  it("adds, updates and removes panels as one canvas patch with its own revision; deletes an edge; nothing is deferred", async () => {
    const { workspaceId } = await newWs(w);
    const keep = (await addPanel(w, workspaceId, 0, panel("keep"))).panel;
    const drop = (await addPanel(w, workspaceId, 1, panel("drop"))).panel;
    const a = await addNode(w, workspaceId, "claim", "a");
    const b2 = await addNode(w, workspaceId, "observation", "b");
    await addEdge(w, workspaceId, b2, a, "supports");
    const base = await snapshot(w, workspaceId, "base");
    const br = await branchFrom(workspaceId, "panels", base);
    const fresh = panel("fresh");
    await change(workspaceId, br, [
      { op: "set", objectId: `panel:${fresh.panelId}`, value: fresh },
      { op: "set", objectId: `panel:${keep.panelId}`, value: { ...keep, title: "keep (edited)" } },
      { op: "delete", objectId: `panel:${drop.panelId}` },
      { op: "delete", objectId: `edge:${b2}|${a}|supports` },
    ]);
    const revBefore = (await w.k.canvas.get(w.owner, workspaceId)).documentRevision;
    const acc = await mergeToMain(workspaceId, br);
    expect(acc.result.deferredObjects).toEqual([]);
    expect(acc.result.applied).toBe(4);

    const after = await livePanels(workspaceId);
    expect(after.map((p) => p.title).sort()).toEqual(["fresh", "keep (edited)"]);
    expect((await w.k.canvas.get(w.owner, workspaceId)).documentRevision).toBe(revBefore + 1); // one patch
    // the removed edge is gone from every projection but its row (author, removal) is kept
    const g = await w.k.graph.get(w.owner, workspaceId);
    expect(g.edges.some((e: { source: string; target: string }) => e.source === b2 && e.target === a)).toBe(
      false,
    );
    const row = (
      await w.db.admin.query(
        "SELECT removed_at, removed_reason, created_by, removed_by FROM evidence_edges WHERE from_node=$1 AND to_node=$2",
        [b2, a],
      )
    ).rows[0];
    expect(row.removed_at).toBeTruthy();
    expect(row.removed_reason).toBe("removed by merge");
    expect(row.removed_by).toBe(w.owner.userId);
    // a snapshot after the merge no longer contains the edge; the earlier snapshot still does (immutable)
    const post = await snapshot(w, workspaceId, "post");
    const cmp = await w.h.snapshots.compare(w.owner, workspaceId, base.snapshotId, post.snapshotId);
    const edgeChange = cmp.changes.find(
      (c: { objectId: string; change: string }) => c.objectId === `edge:${b2}|${a}|supports`,
    );
    expect(edgeChange?.change).toBe("removed");

    // re-adding the removed relation revives it; an active duplicate is still refused
    await addEdge(w, workspaceId, b2, a, "supports");
    expect((await rejection(addEdge(w, workspaceId, b2, a, "supports"))).reasonCode).toBe("DUPLICATE_EDGE");

    // the event log alone rebuilds the merged state, flagged as an exact reproduction of evidence and canvas
    const seq = (
      await w.db.admin.query(
        "SELECT seq FROM workspace_events WHERE workspace_id=$1 AND payload->>'change'='merge.accepted'",
        [workspaceId],
      )
    ).rows[0].seq as number;
    const rec = await w.h.reconstruct.reconstruct(w.owner, workspaceId, seq);
    expect(rec.unreplayableEvents).toEqual([]);
    expect(rec.canvas.panels.map((p: { title: string }) => p.title).sort()).toEqual([
      "fresh",
      "keep (edited)",
    ]);
    expect(Object.keys(rec.graph.edges)).not.toContain(`edge:${b2}|${a}|supports`);
  });

  it("a merge whose panel change the canvas rejects aborts entirely and the proposal stays open", async () => {
    const { workspaceId } = await newWs(w);
    const base = await snapshot(w, workspaceId, "base");
    const br = await branchFrom(workspaceId, "bad-panel", base);
    const n = await addNode(w, workspaceId, "claim", "late"); // main moves, not touching the panel
    const bad = { ...panel("bad"), encoding: { x: "missing_field", y: ["vol"] } };
    await change(workspaceId, br, [
      { op: "set", objectId: `panel:${bad.panelId}`, value: bad },
      {
        op: "set",
        objectId: "node:11111111-1111-4111-8111-111111111111",
        value: { kind: "claim", label: "should not appear", data: {}, semanticPins: {}, tombstone: false },
      },
    ]);
    const e = await rejection(mergeToMain(workspaceId, br));
    expect(e.reasonCode).toBe("PATCH_REJECTED");
    expect((await livePanels(workspaceId)).length).toBe(0);
    const ghost = await w.db.admin.query("SELECT 1 FROM evidence_nodes WHERE id = $1", [
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(ghost.rowCount).toBe(0); // the node change rolled back with the panel change
    expect(n).toBeTruthy();
    const open = await w.db.admin.query("SELECT status FROM history_merge_proposals WHERE workspace_id=$1", [
      workspaceId,
    ]);
    expect(open.rows.map((r: { status: string }) => r.status)).toEqual(["open"]);
  });
});
