import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { observe } from "@nearesis/acceptance";
import { addEdge, addNode, newWs, rejection, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w03")));
afterAll(async () => w?.db.drop());

const edgeCount = async (id: string) =>
  (await w.db.admin.query("SELECT count(*)::int AS n FROM evidence_edges WHERE workspace_id=$1", [id]))
    .rows[0].n as number;

it("W03: an orphan evidence edge is rejected, or recorded only through an explicit visible tombstone", async () => {
  const { workspaceId } = await newWs(w);
  const other = await newWs(w, w.outsider);
  const claim = await addNode(w, workspaceId, "claim", "Unsupported claim");
  const foreignNode = (
    await w.h.graphOps.addNode(w.outsider, other.workspaceId, {
      expectedVersion: other.version,
      kind: "source",
      label: "foreign",
    })
  ).result.nodeId as string;

  const v0 = await wsVersion(w, workspaceId);
  const missing = randomUUID();
  const e1 = await rejection(addEdge(w, workspaceId, claim, missing, "derived_from"));
  expect(e1.reasonCode).toBe("ORPHAN_EVIDENCE_EDGE");
  // A node that exists in another tenant must be indistinguishable from one that does not exist.
  const e2 = await rejection(addEdge(w, workspaceId, claim, foreignNode, "derived_from"));
  expect(e2.reasonCode).toBe("ORPHAN_EVIDENCE_EDGE");
  expect(e2.message).toBe(e1.message);
  const e3 = await rejection(
    w.h.graphOps.addEdge(w.owner, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      from: claim,
      to: foreignNode,
      relation: "derived_from",
      tombstoneMissing: true,
      tombstoneReason: "probe",
    }),
  );
  expect(e3.reasonCode).toBe("ORPHAN_EVIDENCE_EDGE");
  expect(await edgeCount(workspaceId)).toBe(0);
  expect(await wsVersion(w, workspaceId)).toBe(v0);

  // The claim is visibly unsupported; a tombstone does not make it supported.
  const noReason = await rejection(
    w.h.graphOps.addEdge(w.owner, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      from: claim,
      to: missing,
      relation: "derived_from",
      tombstoneMissing: true,
    }),
  );
  expect(noReason.reasonCode).toBe("TOMBSTONE_REASON_REQUIRED");
  const t = await w.h.graphOps.addEdge(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    from: claim,
    to: missing,
    relation: "derived_from",
    tombstoneMissing: true,
    tombstoneReason: "source payload deleted under retention policy",
    tombstoneKind: "source",
  });
  expect(t.result.tombstoned).toEqual([missing]);
  let g = await w.k.graph.get(w.owner, workspaceId);
  const tomb = g.nodes.find((n) => n.id === missing)!;
  expect(tomb.tombstone).toBe(true);
  expect(g.nodes.find((n) => n.id === claim)!.support).toBe("unsupported");
  expect(g.unresolved).toEqual([]);

  // A real persisted result makes the claim supported.
  const res = await addNode(w, workspaceId, "statistical_result", "OLS");
  await addEdge(w, workspaceId, res, claim, "supports");
  g = await w.k.graph.get(w.owner, workspaceId);
  expect(g.nodes.find((n) => n.id === claim)!.support).toBe("supported");

  // Self edges and duplicates are rejected too.
  expect((await rejection(addEdge(w, workspaceId, claim, claim, "references"))).reasonCode).toBe("SELF_EDGE");
  expect((await rejection(addEdge(w, workspaceId, res, claim, "supports"))).reasonCode).toBe(
    "DUPLICATE_EDGE",
  );

  observe({
    testId: "W03",
    observed: `orphan edge to unknown id rejected (${e1.reasonCode}); edge to another tenant's node rejected with the identical message (no existence leak, also with tombstone requested); 0 edges persisted and workspace version unchanged; tombstone without reason rejected; explicit tombstone created a visible tombstone node and the claim stayed unsupported; a persisted result made it supported`,
    evidence: { rejected: 3, edgesAfterRejections: 0, tombstoneVisible: true },
  });
});
