import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { CollabService, REVOCATION_CLOSE_MS } from "../../src/history/collab.ts";
import type { Session } from "../../src/index.ts";
import { CollabClient } from "../history/collab-client.ts";
import { loginSession } from "../helpers/index.ts";
import { newWs, rejection, world } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w15")));
afterAll(async () => w?.db.drop());

async function addMember(name: string, role: "analyst" | "viewer"): Promise<Session> {
  const userId = randomUUID();
  const subject = `w15.${name}.${userId.slice(0, 6)}`;
  await w.db.admin.query("INSERT INTO users(id, oidc_subject, display_name) VALUES ($1,$2,$3)", [
    userId,
    subject,
    name,
  ]);
  await w.db.admin.query("INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,$3)", [
    w.orgA.orgId,
    userId,
    role,
  ]);
  return loginSession(w.k, subject);
}
const until = async (cond: () => boolean | Promise<boolean>, ms: number, step = 25) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
};
const canon = (v: unknown) => JSON.stringify(v, Object.keys(v as object).sort());

it("W15: collaborative state is limited to layout, notes and ephemeral presence; durable objects change only through commands", async () => {
  const { workspaceId } = await newWs(w);
  const svc = w.h.collab;
  const rex = await addMember("rex", "analyst");
  const ron = await addMember("ron", "analyst");

  const connect = (s: Session, scope: "layout" | "notes", ms = 200) =>
    svc.connect(s, workspaceId, scope, { revalidateMs: ms });
  const alice = new CollabClient(await connect(w.owner, "layout"), "layout");
  const ann = new CollabClient(await connect(w.analyst, "layout"), "layout");
  const vic = new CollabClient(await connect(w.viewer, "layout"), "layout");
  const rexC = new CollabClient(await connect(rex, "layout"), "layout");
  const ronC = new CollabClient(await connect(ron, "layout"), "layout");
  const aliceN = new CollabClient(await connect(w.owner, "notes"), "notes");
  const annN = new CollabClient(await connect(w.analyst, "notes"), "notes");

  const guardedCounts = async () => {
    const q = async (t: string) =>
      Number((await w.db.admin.query(`SELECT count(*) FROM ${t}`)).rows[0].count);
    const tables = [
      "evidence_nodes",
      "evidence_edges",
      "memberships",
      "command_approvals",
      "evidence_node_grants",
      "capability_leases",
      "graph_layouts",
      "history_branches",
    ];
    return Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await q(t)])));
  };
  const guardedBefore = await guardedCounts();
  let accepted = 0;

  // (a) members' layout and notes edits converge and persist; the viewer's edit is rejected.
  await alice.edit((d) => d.getMap("layout").set("p1", { x: 1, y: 1 }));
  accepted++;
  await ann.edit((d) => d.getMap("layout").set("p2", { x: 5, y: 7 }));
  accepted++;
  await aliceN.edit((d) => {
    const t = new Y.Text();
    d.getMap("notes").set("n1", t);
    t.insert(0, "hello");
  });
  accepted++;
  await until(() => {
    alice.drain();
    ann.drain();
    aliceN.drain();
    annN.drain();
    return (
      Object.keys(alice.layout()).length === 2 &&
      Object.keys(ann.layout()).length === 2 &&
      Object.keys(annN.notes()).length === 1
    );
  }, 3000);
  expect(canon(alice.layout())).toBe(canon(ann.layout()));
  expect(annN.notes()).toEqual({ n1: "hello" });
  const viewerErr = await rejection(vic.edit((d) => d.getMap("layout").set("p9", { x: 0, y: 0 })));
  expect(viewerErr.code).toBe("FORBIDDEN");
  const state = await svc.state(w.owner, workspaceId, "layout");
  expect(state.decoded).toEqual({ p1: { x: 1, y: 1 }, p2: { x: 5, y: 7 } });
  expect(state.decoded).not.toHaveProperty("p9");
  const fm = vic.conn.frames.length; // the viewer may read (receives frames) but never write
  expect(fm).toBeGreaterThan(0);

  // (b) crafted updates: foreign roots, wrong shapes, access-policy keys. Rejected; durable tables unchanged.
  const craft = (fn: (d: Y.Doc) => void) => {
    const d = new Y.Doc();
    fn(d);
    return Buffer.from(Y.encodeStateAsUpdate(d)).toString("base64");
  };
  const attacks: Array<[string, string, string]> = [
    [
      "evidence attachment root",
      craft((d) => d.getMap("evidence_attachments").set("a", { nodeId: randomUUID() })),
      "COLLAB_FOREIGN_ROOT",
    ],
    [
      "agent assignment root",
      craft((d) => d.getMap("agent_assignments").set("m1", { agent: "x" })),
      "COLLAB_FOREIGN_ROOT",
    ],
    [
      "access policy root",
      craft((d) => d.getMap("access_policy").set("role", "admin")),
      "COLLAB_FOREIGN_ROOT",
    ],
    [
      "policy key inside layout",
      craft((d) => d.getMap("layout").set("access_policy", { role: "admin" })),
      "COLLAB_INVALID_LAYOUT",
    ],
  ];
  const refusals: string[] = [];
  for (const [label, update, reason] of attacks) {
    const e = await rejection(alice.conn.send(update));
    expect(e.reasonCode, label).toBe(reason);
    refusals.push(`${label}:${e.reasonCode}`);
  }
  expect(await guardedCounts()).toEqual(guardedBefore);
  const afterAttacks = await svc.state(w.owner, workspaceId, "layout");
  expect(JSON.stringify(afterAttacks.decoded)).not.toMatch(/access_policy|attachment|agent/);

  // (c) an oversize update is rejected without affecting other clients.
  const huge = Buffer.alloc(1_600_000, 7).toString("base64");
  expect((await rejection(alice.conn.send(huge))).reasonCode).toBe("COLLAB_BAD_UPDATE");
  const bigNotes = craft((d) => {
    const t = new Y.Text();
    d.getMap("notes").set("big", t);
    t.insert(0, "x".repeat(250_000));
  });
  expect((await rejection(aliceN.conn.send(bigNotes))).reasonCode).toBe("COLLAB_TOO_LARGE");
  await ann.edit((d) => d.getMap("layout").set("p3", { x: 9, y: 9 }));
  accepted++;
  expect(
    await until(() => {
      alice.drain();
      return alice.layout().p3 !== undefined;
    }, 3000),
  ).toBe(true);

  // (d) a revoked member: update refused and not broadcast; connections closed within the declared interval.
  await w.db.admin.query("DELETE FROM memberships WHERE org_id=$1 AND user_id=$2", [
    w.orgA.orgId,
    rex.userId,
  ]);
  await w.db.admin.query("DELETE FROM memberships WHERE org_id=$1 AND user_id=$2", [
    w.orgA.orgId,
    ron.userId,
  ]);
  const revokedAt = Date.now();
  alice.drain();
  ann.drain();
  const framesBefore = { alice: alice.conn.frames.length, ann: ann.conn.frames.length };
  const revokedErr = await rejection(rexC.edit((d) => d.getMap("layout").set("p4", { x: 666, y: 666 })));
  expect(revokedErr.reasonCode).toBe("ACCESS_DENIED");
  await new Promise((r) => setTimeout(r, 100));
  expect(alice.conn.frames.length).toBe(framesBefore.alice); // nothing was broadcast
  expect(ann.conn.frames.length).toBe(framesBefore.ann);
  expect((await svc.state(w.owner, workspaceId, "layout")).decoded).not.toHaveProperty("p4");
  expect(await until(() => rexC.conn.closed && ronC.conn.closed, REVOCATION_CLOSE_MS)).toBe(true);
  const closeMs = Math.max(rexC.conn.closedAt!, ronC.conn.closedAt!) - revokedAt;
  expect(closeMs).toBeLessThanOrEqual(REVOCATION_CLOSE_MS);
  expect([rexC.conn.closeReason, ronC.conn.closeReason]).toEqual(["revoked", "revoked"]);
  expect(
    (await rejection(rexC.conn.send(craft((d) => d.getMap("layout").set("p5", { x: 1, y: 1 }))))).reasonCode,
  ).toBe("CONNECTION_CLOSED");

  // (e) presence is ephemeral; after a restart presence is empty and layout and notes are restored; storage is distinct.
  await alice.conn.setPresence({ cursor: { x: 3, y: 4 } });
  const livePresence = await svc.listPresence(w.owner, workspaceId, "layout");
  expect(livePresence.peers.length).toBe(1);
  const updatesRows = Number(
    (await w.db.admin.query("SELECT count(*) FROM collab_updates WHERE workspace_id=$1", [workspaceId]))
      .rows[0].count,
  );
  expect(updatesRows).toBe(accepted); // only document updates are durable; presence and refusals are not stored
  for (const c of [alice, ann, vic, aliceN, annN]) c.conn.close("shutdown");
  const restarted = new CollabService(w.db.app);
  expect((await restarted.listPresence(w.owner, workspaceId, "layout")).peers).toEqual([]);
  const restoredLayout = await restarted.state(w.owner, workspaceId, "layout");
  expect(restoredLayout.decoded).toEqual({ p1: { x: 1, y: 1 }, p2: { x: 5, y: 7 }, p3: { x: 9, y: 9 } });
  expect((await restarted.state(w.owner, workspaceId, "notes")).decoded).toEqual({ n1: "hello" });
  // (memberships legitimately lost two rows through the revocations above; every other guarded table is unchanged)
  const { memberships: _m1, ...guardedAfter } = await guardedCounts();
  const { memberships: _m0, ...guardedBeforeRest } = guardedBefore;
  void _m1;
  void _m0;
  expect(guardedAfter).toEqual(guardedBeforeRest); // layout and notes never reached the evidence tables
  const layoutOnlyInCollab = await w.db.admin.query(
    "SELECT 1 FROM evidence_nodes WHERE data::text LIKE '%\"p1\"%' OR label LIKE '%p1%'",
  );
  expect(layoutOnlyInCollab.rows.length).toBe(0);

  // Negative control: a server that persisted the Yjs document into the evidence tables would change these counts.
  await w.db.admin.query(
    "INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label) VALUES ($1,$2,$3,'source','leaked crdt')",
    [randomUUID(), w.orgA.orgId, workspaceId],
  );
  expect((await guardedCounts()).evidence_nodes).not.toEqual(guardedBefore.evidence_nodes);

  observe({
    testId: "W15",
    observed: `layout and notes edits from 2 members converged (alice == ann, notes restored) and persisted; viewer edit FORBIDDEN and absent from state; 4 crafted updates (${refusals.join(", ")}) refused with 7 guarded tables unchanged; a 1.6 MB update (COLLAB_BAD_UPDATE) and 250k-char notes (COLLAB_TOO_LARGE) refused while the other clients kept working; revoked members: update refused (ACCESS_DENIED), 0 frames broadcast, both connections closed ${closeMs} ms after revocation (declared ${REVOCATION_CLOSE_MS} ms); presence held in memory only, ${updatesRows} durable rows = ${accepted} accepted document updates; after restart presence empty and layout/notes restored; evidence tables unchanged`,
    evidence: {
      refusals,
      closeMs,
      declaredMs: REVOCATION_CLOSE_MS,
      durableUpdateRows: updatesRows,
      guardedCounts: guardedBefore,
    },
  });
}, 60_000);
