import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { addNode, addPanel, newWs, rejection, snapshot, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w05")));
afterAll(async () => w?.db.drop());

it("W05: a historical view reconstructs the exact prior canvas and graph with a data-vintage label", async () => {
  const { workspaceId } = await newWs(w);
  const first = await addPanel(w, workspaceId, 0);
  const n1 = await addNode(w, workspaceId, "claim", "Original claim");
  const manifest = "a".repeat(64);
  const s1 = await snapshot(w, workspaceId, "before refactor", {
    sourceSnapshot: { manifestHash: manifest, watermark: { bigquery: "2026-11-09" } },
  });

  // The workspace moves on: a second panel (documentRevision 2), a data refresh, a new node and a metric change.
  await addPanel(w, workspaceId, 1);
  await w.k.canvas.bumpDataRevision(w.owner, workspaceId);
  const n2 = await addNode(w, workspaceId, "claim", "Later claim");
  await w.h.graphOps.changeSemanticVersion(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    metricId: "dex_volume",
    toVersion: "3.0.0",
  });
  const s2 = await snapshot(w, workspaceId, "after refactor");

  const hc = await w.h.snapshots.view(w.owner, workspaceId, s1.snapshotId, "canvas");
  expect(hc.historical).toBe(true);
  expect(hc.canvas!.documentRevision).toBe(1);
  expect(hc.canvas!.panels.map((p: { panelId: string }) => p.panelId)).toEqual([first.panel.panelId]);
  expect(hc.dataVintage.documentRevision).toBe(1);
  expect(hc.dataVintage.dataRevision).toBe(0);
  expect(hc.dataVintage.sourceSnapshot).toEqual({
    manifestHash: manifest,
    watermark: { bigquery: "2026-11-09" },
  });
  expect(hc.dataVintage.semanticPins).toEqual({});
  expect(hc.stale).toBe(true);
  expect(hc.currentDocumentRevision).toBe(2);
  expect(hc.integrityOk).toBe(true);

  const hg = await w.h.snapshots.view(w.owner, workspaceId, s1.snapshotId, "graph");
  const ids = hg.graph!.nodes.map((n: { id: string }) => n.id);
  expect(ids).toContain(n1);
  expect(ids).not.toContain(n2);
  const live = await w.k.graph.get(w.owner, workspaceId);
  expect(live.nodes.map((n) => n.id)).toContain(n2);

  // The later snapshot is labelled with its own vintage and pins the new semantic version.
  const h2 = await w.h.snapshots.view(w.owner, workspaceId, s2.snapshotId, "canvas");
  expect(h2.canvas!.documentRevision).toBe(2);
  expect(h2.dataVintage.dataRevision).toBe(1);
  expect(h2.dataVintage.semanticPins).toEqual({ dex_volume: "3.0.0" });

  const cmp = await w.h.snapshots.compare(w.owner, workspaceId, s1.snapshotId, s2.snapshotId);
  expect(cmp.documentRevision).toEqual({ from: 1, to: 2 });
  expect(cmp.semanticPinChanges).toEqual([{ metricId: "dex_volume", from: null, to: "3.0.0" }]);
  expect(cmp.changes.filter((c) => c.change === "added").map((c) => c.objectId)).toEqual(
    expect.arrayContaining([`node:${n2}`, "metric:dex_volume"]),
  );
  expect(cmp.changes.some((c) => c.objectId.startsWith("panel:") && c.change === "added")).toBe(true);

  const timeline = await w.h.snapshots.timeline(w.owner, workspaceId);
  const snaps = timeline.filter((t) => t.kind === "snapshot").map((t) => t.ref);
  expect(snaps).toEqual([s1.snapshotId, s2.snapshotId]);
  expect(timeline.some((t) => t.type === "canvas.patched" && t.documentRevision === 2)).toBe(true);

  // Negatives: snapshots are immutable for the application role, and foreign access is denied.
  const upd = await w.db.app
    .tx({ orgId: w.owner.principal.orgId, userId: w.owner.userId }, (tx) =>
      tx.query("UPDATE history_snapshots SET label = 'tampered' WHERE id = $1", [s1.snapshotId]),
    )
    .then(
      () => "updated",
      (e: Error) => e.message,
    );
  expect(upd).toMatch(/permission denied/);
  expect((await rejection(w.h.snapshots.view(w.outsider, workspaceId, s1.snapshotId, "canvas"))).code).toBe(
    "FORBIDDEN",
  );

  observe({
    testId: "W05",
    observed: `snapshot at documentRevision 1 replayed exactly 1 panel and no later node while live is at revision 2 (stale=true, integrityOk=true); vintage = dataRevision ${hc.dataVintage.dataRevision}, source manifest ${manifest.slice(0, 8)}, semantic pins {} vs later {dex_volume:3.0.0}; compare shows added panel/node/metric; timeline lists both snapshots in order; UPDATE on snapshots denied; foreign view denied`,
    evidence: { documentRevision: [1, 2], stale: true, vintage: hc.dataVintage },
  });
});
