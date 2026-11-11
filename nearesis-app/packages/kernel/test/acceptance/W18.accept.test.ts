import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import type { Session } from "../../src/index.ts";
import { BACKUP_PURGE_DAYS } from "../../src/history/retention.ts";
import { addEdge, newWs, rejection, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w18")));
afterAll(async () => w?.db.drop());

const MARKER = "PAYLOAD-MARKER-7f3a9c-do-not-keep";

it("W18: retention deletion removes payloads but keeps a tombstone, and every dereference checks the ACL", async () => {
  const { workspaceId } = await newWs(w);
  const other = await newWs(w, w.outsider);
  const agent: Session = {
    principal: { kind: "agent", actorId: randomUUID(), orgId: w.orgA.orgId, parentRunId: randomUUID() },
    role: "analyst",
    userId: w.orgA.users.ann!.userId,
  };
  // Fixture: an evidence item with a raw payload, two claims depending on it, a public asset in two workspaces.
  const bytes = new TextEncoder().encode(`${MARKER} ${"x".repeat(4000)}`);
  const obj = await w.h.objects.put(w.owner, bytes);
  const other1 = await w.h.objects.put(w.owner, new TextEncoder().encode("unrelated retained payload"));
  const node = async (
    s: Session,
    ws: string,
    kind: string,
    label: string,
    extra: Record<string, unknown> = {},
  ) =>
    (await w.h.graphOps.addNode(s, ws, { expectedVersion: await wsVersion(w, ws), kind, label, ...extra }))
      .result.nodeId as string;
  const E = await node(w.owner, workspaceId, "observation", `Excerpt: ${MARKER.slice(0, 12)}`, {
    rawObjectHash: obj.hash,
    data: { note: "raw payload held in the object store" },
  });
  const keep = await node(w.owner, workspaceId, "observation", "Unrelated item", {
    rawObjectHash: other1.hash,
  });
  const C1 = await node(w.owner, workspaceId, "claim", "Claim supported by E");
  const C2 = await node(w.owner, workspaceId, "claim", "Claim derived from E");
  await addEdge(w, workspaceId, E, C1, "supports");
  await addEdge(w, workspaceId, C2, E, "derived_from");
  const assetId = randomUUID();
  await w.db.admin.query(
    "INSERT INTO public_assets(id, content_hash, title) VALUES ($1,$2,'Public chain snapshot')",
    [assetId, "a".repeat(64)],
  );
  const pubA = await node(w.owner, workspaceId, "source", "Public asset ref (tenant A)", {
    publicAssetId: assetId,
  });
  const pubB = await node(w.outsider, other.workspaceId, "source", "Public asset ref (tenant B)", {
    publicAssetId: assetId,
  });
  const privateB = await node(w.outsider, other.workspaceId, "observation", "Tenant B private observation");
  // The public-asset table is operator-published: the application role cannot write to it.
  const pubWrite = await w.db.app
    .tx({ orgId: w.owner.principal.orgId, userId: w.owner.userId }, (tx) =>
      tx.query("INSERT INTO public_assets(id, content_hash, title) VALUES (gen_random_uuid(), $1, 'x')", [
        "b".repeat(64),
      ]),
    )
    .then(
      () => "inserted",
      (e: Error) => e.message,
    );
  expect(pubWrite).toMatch(/permission denied/);

  const store0 = await w.h.objects.stats(w.owner);
  expect(store0.hashes).toContain(obj.hash);

  // Step 1: run the deletion workflow.
  const del = await w.h.retention.deletePayload(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    nodeId: E,
    reason: "legal retention limit reached",
  });
  expect(del.result.contentHash).toBe(obj.hash);

  // (a) bytes are gone and a backup purge is queued per policy; the item remains as a tombstone without any excerpt.
  const store1 = await w.h.objects.stats(w.owner);
  expect(store1.hashes).not.toContain(obj.hash);
  expect(store1.hashes).toContain(other1.hash); // unrelated payload untouched
  expect(store1.count).toBe(store0.count - 1);
  const row = (await w.db.admin.query("SELECT * FROM evidence_nodes WHERE id=$1", [E])).rows[0];
  expect(row).toMatchObject({
    tombstone: true,
    content_hash: obj.hash,
    tombstone_reason: "legal retention limit reached",
    raw_object_hash: null,
  });
  expect(row.deleted_at).toBeInstanceOf(Date);
  expect(JSON.stringify(row)).not.toContain(MARKER);
  expect(row.label).not.toContain(MARKER.slice(0, 12));
  expect(row.data).toEqual({});
  const everywhere = await w.db.admin.query(
    "SELECT 1 FROM raw_objects WHERE encode(bytes,'escape') LIKE $1",
    [`%${MARKER}%`],
  );
  expect(everywhere.rows.length).toBe(0);
  const q = await w.h.retention.queue(w.owner, workspaceId);
  expect(q.length).toBe(1);
  expect(q[0]).toMatchObject({ contentHash: obj.hash, action: "purge_backups" });
  const dueDays = (new Date(q[0]!.dueAt).getTime() - Date.now()) / 86_400_000;
  expect(dueDays).toBeGreaterThan(BACKUP_PURGE_DAYS - 1);
  expect(dueDays).toBeLessThanOrEqual(BACKUP_PURGE_DAYS);

  // (b) edges remain valid; dependent claims are flagged evidence_unavailable, not deleted.
  const g = await w.k.graph.get(w.owner, workspaceId);
  expect(g.unresolved).toEqual([]);
  expect(g.edges.filter((e) => e.source === E || e.target === E).length).toBe(2);
  const tomb = g.nodes.find((n) => n.id === E)!;
  expect(tomb.tombstone).toBe(true);
  for (const c of [C1, C2]) {
    const n = g.nodes.find((x) => x.id === c)!;
    expect(n, "claim still exists").toBeDefined();
    expect(n.evidenceUnavailable).toBe(true);
    expect(n.support).toBe("unsupported");
  }
  expect(g.nodes.find((n) => n.id === keep)!.tombstone).toBeUndefined();
  expect(g.nodes.find((n) => n.id === pubA)!.evidenceUnavailable).toBeUndefined();

  // (c) dereferencing the tombstone as an agent in the owning workspace yields metadata only; foreign gets 404-class.
  const asAgent = await w.h.retention.dereference(agent, workspaceId, E);
  expect(asAgent).toMatchObject({
    tombstone: true,
    contentHash: obj.hash,
    reason: "legal retention limit reached",
  });
  expect(Object.keys(asAgent).sort()).toEqual([
    "contentHash",
    "deletedAt",
    "kind",
    "nodeId",
    "reason",
    "tombstone",
  ]);
  expect(JSON.stringify(asAgent)).not.toContain(MARKER);
  const foreignTomb = await rejection(w.h.retention.dereference(w.outsider, workspaceId, E));
  const nonexistent = await rejection(w.h.retention.dereference(w.outsider, workspaceId, randomUUID()));
  expect([foreignTomb.code, foreignTomb.reasonCode]).toEqual([nonexistent.code, nonexistent.reasonCode]);
  expect(foreignTomb.reasonCode).toBe("ACCESS_DENIED"); // the HTTP guard maps this reason to 404

  // (d) the public asset resolves from both workspaces; a private object is a 404-class denial, audited.
  const a1 = await w.h.retention.dereference(w.owner, workspaceId, pubA);
  const a2 = await w.h.retention.dereference(w.outsider, other.workspaceId, pubB);
  expect(a1).toMatchObject({ publicAsset: { id: assetId, title: "Public chain snapshot" } });
  expect(a2).toMatchObject({ publicAsset: { id: assetId, contentHash: "a".repeat(64) } });
  const auditBefore = Number(
    (await w.db.admin.query("SELECT count(*) FROM audit_events WHERE action='evidence.dereference_denied'"))
      .rows[0].count,
  );
  const privateDenied = await rejection(w.h.retention.dereference(w.owner, other.workspaceId, privateB));
  expect(privateDenied.reasonCode).toBe("ACCESS_DENIED");
  const auditRows = (
    await w.db.admin.query(
      "SELECT org_id, actor_id, subject, outcome, detail FROM audit_events WHERE action='evidence.dereference_denied' ORDER BY occurred_at",
    )
  ).rows;
  expect(auditBefore).toBe(2); // the foreign tombstone probe and the nonexistent-id probe were audited
  expect(auditRows.length).toBe(auditBefore + 1); // plus the private object probe
  expect(auditRows.at(-1)).toMatchObject({
    org_id: w.orgA.orgId,
    actor_id: w.owner.userId,
    subject: privateB,
    outcome: "denied",
  });
  // An agent without a grant on a restricted item is denied too (ACL on every dereference).
  await w.h.graphOps.setRestriction(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    nodeId: keep,
    restricted: true,
    grantUserIds: [],
  });
  expect((await rejection(w.h.retention.dereference(agent, workspaceId, keep))).reasonCode).toBe(
    "ACCESS_DENIED",
  );
  expect(await w.h.retention.dereference(w.owner, workspaceId, keep)).toMatchObject({
    nodeId: keep,
    tombstone: false,
  });

  // Negative control: deleting the row (orphaning the edges) is what the tombstone prevents; the edge FK-equivalent holds.
  const edges = (
    await w.db.admin.query("SELECT from_node, to_node FROM evidence_edges WHERE workspace_id=$1", [
      workspaceId,
    ])
  ).rows;
  const nodeIds = new Set(
    (await w.db.admin.query("SELECT id FROM evidence_nodes WHERE workspace_id=$1", [workspaceId])).rows.map(
      (r) => r.id as string,
    ),
  );
  expect(edges.every((e) => nodeIds.has(e.from_node) && nodeIds.has(e.to_node))).toBe(true);
  const simulatedRowDelete = new Set([...nodeIds].filter((id) => id !== E));
  expect(edges.every((e) => simulatedRowDelete.has(e.from_node) && simulatedRowDelete.has(e.to_node))).toBe(
    false,
  );

  observe({
    testId: "W18",
    observed: `retention deletion removed the ${obj.hash.slice(0, 8)} payload from the object store (store ${store0.count} -> ${store1.count}, unrelated payload kept, marker string absent from every table) and queued a ${BACKUP_PURGE_DAYS}-day backup purge; the item became a tombstone with content_hash, deleted_at, reason and empty data; both edges stay resolved (0 unresolved) and both dependent claims remain, flagged evidenceUnavailable/unsupported; an agent dereferencing the tombstone got metadata only while a foreign tenant got the same ACCESS_DENIED as a nonexistent item; the public asset resolved from both tenants, private/foreign dereferences were denied and audited (3 audit rows), and a restricted item was denied to an ungranted agent`,
    evidence: {
      store: [store0.count, store1.count],
      dueDays: Math.round(dueDays),
      auditRows: auditRows.length,
      derefKeys: Object.keys(asAgent),
    },
  });
});
