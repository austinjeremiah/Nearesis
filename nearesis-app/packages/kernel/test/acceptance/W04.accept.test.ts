import { afterAll, beforeAll, expect, it } from "vitest";
import * as Y from "yjs";
import { observe } from "@nearesis/acceptance";
import { addNode, newWs, rejection, world } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w04")));
afterAll(async () => w?.db.drop());

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const applyB64 = (d: Y.Doc, s: string) => Y.applyUpdate(d, new Uint8Array(Buffer.from(s, "base64")));

/** Make a Yjs edit on a fresh doc seeded with `from` and return just that edit as an update. */
function edit(from: string | null, fn: (d: Y.Doc) => void): string {
  const d = new Y.Doc();
  if (from) applyB64(d, from);
  const sv = Y.encodeStateVector(d);
  fn(d);
  return b64(Y.encodeStateAsUpdate(d, sv));
}

it("W04: collaborators merge layout/notes in one workspace; another tenant gets nothing, can write nothing", async () => {
  const { workspaceId } = await newWs(w);
  const other = await newWs(w, w.outsider);
  const nodeId = await addNode(w, workspaceId, "claim", "Claim");
  const edgesBefore = (
    await w.db.admin.query("SELECT count(*)::int AS n FROM evidence_edges WHERE workspace_id=$1", [
      workspaceId,
    ])
  ).rows[0].n;

  // Two writers edit concurrently from the same (empty) base. Updates are independent and must merge.
  const owner = edit(null, (d) => d.getMap("layout").set(nodeId, { x: 10, y: 20 }));
  const analyst = edit(null, (d) => d.getMap("layout").set("other-node", { x: -5, y: 7 }));
  await w.h.collab.applyUpdate(w.owner, workspaceId, "layout", owner);
  await w.h.collab.applyUpdate(w.analyst, workspaceId, "layout", analyst);
  const noteA = edit(null, (d) => {
    const t = new Y.Text();
    d.getMap("notes").set("n1", t);
    t.insert(0, "hello");
  });
  await w.h.collab.applyUpdate(w.owner, workspaceId, "notes", noteA);
  const s = await w.h.collab.state(w.viewer, workspaceId, "layout"); // viewers can read
  expect(s.decoded).toEqual({ [nodeId]: { x: 10, y: 20 }, "other-node": { x: -5, y: 7 } });
  const replica = new Y.Doc();
  applyB64(replica, s.update);
  expect(replica.getMap("layout").size).toBe(2);
  expect((await w.h.collab.state(w.owner, workspaceId, "notes")).decoded).toEqual({ n1: "hello" });

  // Layout is stored apart from evidence semantics: logical relationships are untouched by layout edits.
  const edgesAfter = (
    await w.db.admin.query("SELECT count(*)::int AS n FROM evidence_edges WHERE workspace_id=$1", [
      workspaceId,
    ])
  ).rows[0].n;
  expect(edgesAfter).toBe(edgesBefore);
  const nodeRow = (await w.db.admin.query("SELECT label, data FROM evidence_nodes WHERE id=$1", [nodeId]))
    .rows[0];
  expect(nodeRow.label).toBe("Claim");

  // Presence is visible to members of this workspace only.
  await w.h.collab.setPresence(w.owner, workspaceId, "layout", "tab1", { cursor: { x: 1, y: 2 } });
  const seen = await w.h.collab.listPresence(w.analyst, workspaceId, "layout");
  expect(seen.peers.map((p) => p.userId)).toEqual([w.owner.userId]);

  // The other tenant: join, write and presence on OUR workspace all look exactly like an unknown workspace.
  const unknown = "00000000-0000-4000-8000-000000000000";
  const probe = async (id: string) => {
    const r = [
      await rejection(w.h.collab.state(w.outsider, id, "layout")),
      await rejection(
        w.h.collab.applyUpdate(
          w.outsider,
          id,
          "layout",
          edit(null, (d) => d.getMap("layout").set("evil", { x: 1, y: 1 })),
        ),
      ),
      await rejection(w.h.collab.listPresence(w.outsider, id, "layout")),
      await rejection(w.h.collab.setPresence(w.outsider, id, "layout", "x", {})),
    ];
    return r.map((e) => `${e.code}/${e.reasonCode}/${e.message}`);
  };
  const foreign = await probe(workspaceId);
  const absent = await probe(unknown);
  expect(foreign).toEqual(absent);
  expect(foreign[0]).toMatch(/^FORBIDDEN\/ACCESS_DENIED/);
  const evil = (
    await w.db.admin.query(
      "SELECT count(*)::int AS n FROM collab_updates WHERE workspace_id=$1 AND actor_id=$2",
      [workspaceId, w.outsider.userId],
    )
  ).rows[0].n;
  expect(evil).toBe(0);
  expect((await w.h.collab.listPresence(w.outsider, other.workspaceId, "layout")).peers).toEqual([]);

  // In-tenant guards: viewers cannot write; updates may only touch their own scope and sane values.
  expect((await rejection(w.h.collab.applyUpdate(w.viewer, workspaceId, "layout", owner))).reasonCode).toBe(
    "INSUFFICIENT_ROLE",
  );
  const foreignRoot = edit(null, (d) => d.getMap("evidence").set("x", 1));
  expect(
    (await rejection(w.h.collab.applyUpdate(w.owner, workspaceId, "layout", foreignRoot))).reasonCode,
  ).toBe("COLLAB_FOREIGN_ROOT");
  const badCoord = edit(null, (d) => d.getMap("layout").set("n", { x: 1e12, y: 0 }));
  expect((await rejection(w.h.collab.applyUpdate(w.owner, workspaceId, "layout", badCoord))).reasonCode).toBe(
    "COLLAB_INVALID_LAYOUT",
  );
  expect(
    (await rejection(w.h.collab.applyUpdate(w.owner, workspaceId, "layout", "bm90LXlqcw=="))).reasonCode,
  ).toMatch(/COLLAB_/);
  const rowsAfter = (
    await w.db.admin.query(
      "SELECT count(*)::int AS n FROM collab_updates WHERE workspace_id=$1 AND scope='layout'",
      [workspaceId],
    )
  ).rows[0].n;
  expect(rowsAfter).toBe(2);

  observe({
    testId: "W04",
    observed: `2 concurrent writers merged to 2 layout entries and a shared note; viewer read ok, viewer write ${"INSUFFICIENT_ROLE"}; other-tenant state/update/presence-read/presence-write on our workspace were byte-identical to an unknown workspace (${foreign[0]}), 0 rows persisted for the outsider, presence peers listed only to members; foreign root, out-of-range coordinates and non-Yjs bytes rejected; evidence edges unchanged by layout edits`,
    evidence: { probes: foreign.length, outsiderRows: evil, layoutRows: rowsAfter },
  });
});
