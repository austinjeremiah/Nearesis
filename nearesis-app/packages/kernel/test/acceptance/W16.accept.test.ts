import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import * as Y from "yjs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import type { Session } from "../../src/index.ts";
import { CollabClient } from "../history/collab-client.ts";
import { addPanel, newWs, panel, rejection, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w16")));
afterAll(async () => w?.db.drop());

const DEADLINE_MS = 15_000;
const workerUrl = new URL("../history/collab-worker.ts", import.meta.url);

class Remote {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, (m: Record<string, unknown>) => void>();
  constructor(session: Session, workspaceId: string) {
    this.worker = new Worker(workerUrl, {
      execArgv: ["--import", "tsx"],
      workerData: { appUrl: w.db.appUrl, session, workspaceId },
    });
    this.worker.on("message", (m: { id: number }) => this.pending.get(m.id)?.(m as Record<string, unknown>));
    this.worker.on("error", (e) => {
      for (const p of this.pending.values()) p({ ok: false, error: String(e) });
    });
  }
  call(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.worker.postMessage({ ...msg, id });
    });
  }
  async stop() {
    await this.call({ cmd: "close" });
    await this.worker.terminate();
  }
}
const canon = (v: unknown) => JSON.stringify(v, Object.keys(v as object).sort());

it("W16: concurrent layout edits converge to the canvas recorded by the event log and nothing crosses tenants", async () => {
  const { workspaceId } = await newWs(w);
  // 12-panel workspace through the real canvas command path.
  const panels: string[] = [];
  for (let i = 0; i < 12; i++)
    panels.push((await addPanel(w, workspaceId, i, panel(`Panel ${i + 1} (tenant A)`))).panel.panelId);
  const [p1, p2, p3, , p5, , p7] = panels as [string, string, string, string, string, string, string];

  // The second tenant has similarly named panels and its own room.
  const other = await newWs(w, w.outsider);

  // Seed the CRDT layout (as a first client would) from the real panel ids.
  const seeder = new CollabClient(await w.h.collab.connect(w.owner, workspaceId, "layout"), "layout");
  await seeder.edit((d) => {
    const m = d.getMap("layout");
    panels.forEach((id, i) => m.set(id, { x: (i % 4) * 10, y: Math.floor(i / 4) * 10 }));
  });
  seeder.conn.close("seeded");

  // The third tenant's client: connected to its own room only, capturing everything it receives.
  const third = new CollabClient(await w.h.collab.connect(w.outsider, other.workspaceId, "layout"), "layout");
  await third.edit((d) => d.getMap("layout").set(randomUUID(), { x: 1, y: 1 }));

  const A = new Remote(w.owner, workspaceId);
  const B = new Remote(w.analyst, workspaceId);
  // Phase 1 (online, truly concurrent): both reorder the same two panels differently.
  const online = {
    A: [
      { op: "set", key: p1, value: { x: 10, y: 0 } },
      { op: "set", key: p2, value: { x: 0, y: 0 } },
    ],
    B: [
      { op: "set", key: p1, value: { x: 20, y: 20 } },
      { op: "set", key: p2, value: { x: 30, y: 20 } },
    ],
  };
  const [o1, o2] = await Promise.all([
    A.call({ cmd: "run", ops: online.A }),
    B.call({ cmd: "run", ops: online.B }),
  ]);
  expect([o1.ok, o2.ok]).toEqual([true, true]);
  // Phase 2: both go offline and make conflicting edits that neither has seen; the canvas deletes p5 through the real
  // command in the meantime. Then both reconnect at the same time.
  const offlineA = [
    { op: "set", key: p3, value: { x: 100, y: 5 } }, // opposite direction to B
    { op: "delete", key: p7 }, // delete versus B's move
    { op: "set", key: p5, value: { x: 77, y: 77 } }, // moved while the canvas deletes the panel
  ];
  const offlineB = [
    { op: "set", key: p3, value: { x: -100, y: 5 } },
    { op: "set", key: p7, value: { x: 55, y: 55 } },
    { op: "set", key: p5, value: { x: 88, y: 88 } },
  ];
  const [l1, l2] = await Promise.all([
    A.call({ cmd: "local", ops: offlineA }),
    B.call({ cmd: "local", ops: offlineB }),
  ]);
  expect([l1.buffered, l2.buffered]).toEqual([3, 3]);
  await w.k.commands.execute(w.owner, workspaceId, {
    apiVersion: "v1",
    commandId: randomUUID(),
    commandType: "canvas.apply_patch",
    expectedVersion: await wsVersion(w, workspaceId),
    payload: {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: randomUUID(),
      expectedRevision: 12,
      operations: [{ op: "removePanel", panelId: p5 }],
    },
  });
  const [ra, rb] = await Promise.all([A.call({ cmd: "reconnect" }), B.call({ cmd: "reconnect" })]);
  expect(ra.ok, String(ra.error)).toBe(true);
  expect(rb.ok, String(rb.error)).toBe(true);

  // (a) both clients reach byte-equal layout state within the declared deadline.
  let la!: Record<string, unknown>;
  let lb!: Record<string, unknown>;
  const end = Date.now() + DEADLINE_MS;
  do {
    la = (await A.call({ cmd: "sync" })).layout as Record<string, unknown>;
    lb = (await B.call({ cmd: "sync" })).layout as Record<string, unknown>;
  } while (canon(la) !== canon(lb) && Date.now() < end);
  expect(canon(la)).toBe(canon(lb));
  const server = (await w.h.collab.state(w.owner, workspaceId, "layout")).decoded;
  expect(canon(server)).toBe(canon(la));
  // Opposite moves of p3 converge on one of the two writes, identically on both clients.
  expect([100, -100]).toContain((la[p3] as { x: number }).x);
  expect(la[p1]).toEqual(lb[p1]);
  expect(la[p2]).toEqual(lb[p2]);

  // (b) reconciliation against the event log: same panel ids and documentRevision; delete-versus-move resolves by the rule.
  const rec = await w.h.collab.reconcileLayout(w.owner, workspaceId);
  const logRev = Math.max(
    ...(
      await w.db.admin.query(
        "SELECT (payload->>'documentRevision')::int AS r FROM workspace_events WHERE workspace_id=$1 AND event_type='canvas.patched'",
        [workspaceId],
      )
    ).rows.map((r) => r.r as number),
  );
  expect(rec.documentRevision).toBe(logRev);
  expect(rec.documentRevision).toBe(13);
  expect(rec.panelIds).toEqual(panels.filter((p) => p !== p5).sort());
  expect(Object.keys(rec.layout).sort()).toEqual(rec.panelIds.filter((p) => server[p] !== undefined).sort());
  expect(rec.dropped).toContain(p5); // canvas delete beats a concurrent layout move, and both sides see that outcome
  expect(rec.layout[p5 as keyof typeof rec.layout]).toBeUndefined();
  // Concurrent layout delete versus move: the move survives (Yjs keeps the later write); documented in `rule`.
  expect((la[p7] as { x: number } | undefined)?.x).toBe(55);
  expect(rec.rule).toMatch(/event log/);
  // (d) the dangling entry was dropped with a recorded notice, not left in the reconciled layout.
  const notice = (
    await w.db.admin.query("SELECT detail FROM collab_notices WHERE workspace_id=$1", [workspaceId])
  ).rows[0];
  expect(notice.detail.dropped).toEqual([p5]);
  expect(notice.detail.documentRevision).toBe(13);

  // (c) the third tenant: 0 frames, 0 presence, 0 panel titles or ids from the first tenant, offline and reconnect included.
  third.drain();
  const captured: string[] = [
    JSON.stringify(third.conn.frames),
    JSON.stringify((await w.h.collab.listPresence(w.outsider, other.workspaceId, "layout")).peers),
  ];
  const probes = [
    () => w.h.collab.state(w.outsider, workspaceId, "layout"),
    () => w.h.collab.listPresence(w.outsider, workspaceId, "layout"),
    () => w.h.collab.connect(w.outsider, workspaceId, "layout"),
    () => w.h.collab.reconcileLayout(w.outsider, workspaceId),
    () =>
      w.h.collab.applyUpdate(
        w.outsider,
        workspaceId,
        "layout",
        Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString("base64"),
      ),
  ];
  const probeCodes: string[] = [];
  for (const p of probes) probeCodes.push((await rejection(p())).reasonCode);
  expect(new Set(probeCodes)).toEqual(new Set(["ACCESS_DENIED"]));
  const everything = captured.join("") + JSON.stringify(third.layout());
  for (const id of panels) expect(everything).not.toContain(id);
  expect(everything).not.toContain("tenant A");
  expect(third.conn.frames.length).toBe(0);
  const mine = await w.h.collab.listPresence(w.outsider, other.workspaceId, "layout");
  expect(mine.peers.every((p) => p.userId === w.outsider.userId)).toBe(true);
  // Negative control: broadcasting presence of all rooms would put tenant-A ids into the third client's capture.
  await w.h.collab.connect(w.owner, workspaceId, "layout").then(async (c) => {
    await c.setPresence({ focus: p1 });
    expect(
      JSON.stringify((await w.h.collab.listPresence(w.outsider, other.workspaceId, "layout")).peers),
    ).not.toContain(p1);
    c.close("done");
  });

  third.conn.close("done");
  await Promise.all([A.stop(), B.stop()]);
  observe({
    testId: "W16",
    observed: `two real worker-thread clients (own Y.Doc and DB pool; concurrent online reorders, then both offline for conflicting edits and reconnecting together) edited a 12-panel layout concurrently while the canvas deleted a panel: both clients and the server reached byte-equal layout state; p3's opposite moves converged on one write; reconciliation listed the ${rec.panelIds.length} canvas panels at documentRevision ${rec.documentRevision} (= event log), dropped the deleted panel with a recorded notice, and kept the concurrently moved p7; the third tenant received 0 frames, 0 foreign presence, 0 tenant-A ids or titles, and all ${probes.length} cross-tenant probes failed with ACCESS_DENIED`,
    evidence: {
      documentRevision: rec.documentRevision,
      dropped: rec.dropped.length,
      probes: probeCodes,
      convergedKeys: Object.keys(la).length,
    },
  });
}, 90_000);
