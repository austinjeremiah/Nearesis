import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { addEdge, addNode, newWs, rejection, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w02")));
afterAll(async () => w?.db.drop());

it("W02: altering a metric definition flags every dependent claim for revalidation", async () => {
  const { workspaceId } = await newWs(w);
  const result = await addNode(w, workspaceId, "statistical_result", "Volume trend", {
    semanticPins: { dex_volume: "1.0.0" },
  });
  const claim = await addNode(w, workspaceId, "claim", "Volume is rising");
  const summary = await addNode(w, workspaceId, "claim", "Thesis: adoption is rising");
  const unrelated = await addNode(w, workspaceId, "statistical_result", "Fee trend", {
    semanticPins: { fee_rate: "1.0.0" },
  });
  const plain = await addNode(w, workspaceId, "observation", "Unpinned observation");
  await addEdge(w, workspaceId, claim, result, "derived_from");
  await addEdge(w, workspaceId, summary, claim, "derived_from");
  await addEdge(w, workspaceId, unrelated, plain, "derived_from");
  // A cycle must not hang the traversal.
  await addEdge(w, workspaceId, result, summary, "references");
  await addEdge(w, workspaceId, result, claim, "supports");

  const before = await w.h.recheckFlags(w.owner, workspaceId);
  expect(before).toEqual([]);

  const r = await w.h.graphOps.changeSemanticVersion(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    metricId: "dex_volume",
    toVersion: "2.0.0",
  });
  const flagged = new Set(r.result.flaggedNodeIds);
  expect(flagged).toEqual(new Set([result, claim, summary]));
  const flags = await w.h.recheckFlags(w.owner, workspaceId);
  const via = Object.fromEntries(flags.map((f: { nodeId: string; via: string }) => [f.nodeId, f.via]));
  expect(via[result]).toBe("pinned");
  expect(via[claim]).toBe("derived_from");

  const g = await w.k.graph.get(w.owner, workspaceId);
  const rc = Object.fromEntries(g.nodes.filter((n) => n.recheckRequired).map((n) => [n.id, true]));
  expect(Object.keys(rc).sort()).toEqual([result, claim, summary].sort());
  expect(g.nodes.find((n) => n.id === unrelated)!.recheckRequired).toBeUndefined();
  expect(g.nodes.find((n) => n.id === plain)!.recheckRequired).toBeUndefined();

  // Negative: re-applying the same version flags nothing new; a node already at the new version is not flagged.
  const again = await w.h.graphOps.changeSemanticVersion(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    metricId: "dex_volume",
    toVersion: "2.0.0",
  });
  expect(again.result.changed).toBe(false);
  expect(again.result.flaggedNodeIds).toEqual([]);
  const fresh = await addNode(w, workspaceId, "statistical_result", "Recomputed", {
    semanticPins: { dex_volume: "2.0.0" },
  });
  const r3 = await w.h.graphOps.changeSemanticVersion(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    metricId: "dex_volume",
    toVersion: "2.0.0",
  });
  expect(r3.result.flaggedNodeIds).not.toContain(fresh);

  // Resolution clears exactly one flag; viewers cannot resolve.
  const viewer = await rejection(
    w.h.graphOps.resolveRecheck(w.viewer, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      nodeId: claim,
    }),
  );
  expect(viewer.reasonCode).toBe("INSUFFICIENT_ROLE");
  await w.h.graphOps.resolveRecheck(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    nodeId: claim,
    note: "reran",
  });
  const left = (await w.h.recheckFlags(w.owner, workspaceId)).map((f: { nodeId: string }) => f.nodeId).sort();
  expect(left).toEqual([result, summary].sort());

  observe({
    testId: "W02",
    observed: `metric dex_volume 1.0.0 -> 2.0.0 flagged ${flagged.size} nodes (1 pinned result + 2 transitive dependents via derived_from, cycle-safe); unrelated and unpinned nodes untouched; same-version re-apply flagged 0; resolve cleared 1 leaving ${left.length}`,
    evidence: { flagged: [...flagged].length, via, remaining: left.length },
  });
});
