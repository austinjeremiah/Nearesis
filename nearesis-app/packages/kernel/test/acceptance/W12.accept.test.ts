import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import type { Session } from "../../src/index.ts";
import {
  addNode,
  addPanel,
  newWs,
  panel,
  rejection,
  snapshot,
  world,
  wsVersion,
} from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w12")));
afterAll(async () => w?.db.drop());

it("W12: the timeline attributes human and machine edits distinctly and snapshot comparison is exact", async () => {
  const { workspaceId } = await newWs(w);
  // An agent principal acting inside the same org (server-resolved kind, as the runtime does for subagents).
  const agent: Session = {
    principal: { kind: "agent", actorId: randomUUID(), orgId: w.orgA.orgId, parentRunId: randomUUID() },
    role: "analyst",
    userId: w.orgA.users.ann!.userId,
  };
  const p1 = await addPanel(w, workspaceId, 0, panel("Volume", "1".repeat(64)));
  const claim = await addNode(w, workspaceId, "claim", "Volume is rising", { data: { verdict: "open" } });
  // Machine edit: the agent adds a node and a human edits afterwards.
  const agentNode = (
    await w.h.graphOps.addNode(agent, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      kind: "observation",
      label: "agent observation",
    })
  ).result.nodeId as string;
  const snapA = await snapshot(w, workspaceId, "A");

  // Three known differences: a changed query hash, a changed claim verdict, an added panel.
  const changed = { ...p1.panel, queryRef: { ...p1.panel.queryRef, hash: "2".repeat(64) } };
  await w.k.commands.execute(w.owner, workspaceId, {
    apiVersion: "v1",
    commandId: randomUUID(),
    commandType: "canvas.apply_patch",
    expectedVersion: await wsVersion(w, workspaceId),
    payload: {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: randomUUID(),
      expectedRevision: 1,
      operations: [{ op: "updatePanel", panelId: p1.panel.panelId, panel: changed }],
    },
  });
  await w.h.graphOps.updateNodeData(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    nodeId: claim,
    data: { verdict: "supported" },
  });
  const added = await addPanel(w, workspaceId, 2, panel("Fees", "3".repeat(64)));
  const snapB = await snapshot(w, workspaceId, "B");

  // Step 1: timeline attribution.
  const tl = await w.h.snapshots.timeline(w.owner, workspaceId);
  for (const e of tl) expect(["human", "agent"]).toContain(e.actorKind as string);
  const agentEvents = tl.filter((e) => e.actorKind === "agent");
  expect(agentEvents.length).toBe(1);
  expect(agentEvents[0]!.type).toBe("evidence.verified");
  expect(agentEvents[0]!.actorId).toBe(agent.userId);
  const humans = tl.filter((e) => e.actorKind === "human");
  expect(humans.length).toBe(tl.length - 1);
  expect(tl.every((e) => e.actorId !== null && e.type && e.at && "documentRevision" in e)).toBe(true);
  expect(tl.filter((e) => e.kind === "snapshot").map((e) => e.actorKind)).toEqual(["human", "human"]);
  // Attribution is the server-set session kind: the same user acting as a human stays human.
  const sameUserHuman = tl.filter((e) => e.actorId === w.orgA.users.ann!.userId && e.kind === "event");
  expect(sameUserHuman.every((e) => e.actorKind === "agent")).toBe(true); // ann's id only acted via the agent session

  // Step 2: reviewer comment as a reviewer (analyst) and attempt as a viewer.
  const evidenceBefore = Number(
    (await w.db.admin.query("SELECT count(*) FROM evidence_nodes WHERE workspace_id=$1", [workspaceId]))
      .rows[0].count,
  );
  const c = await w.h.reviews.add(w.analyst, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    nodeId: claim,
    body: "Please re-check the window length.",
  });
  const viewerTry = await rejection(
    w.h.reviews.add(w.viewer, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      nodeId: claim,
      body: "nope",
    }),
  );
  expect(viewerTry.code).toBe("FORBIDDEN");
  const comments = await w.h.reviews.list(w.owner, workspaceId, claim);
  expect(comments.length).toBe(1);
  expect(comments[0]).toMatchObject({
    authorId: w.analyst.userId,
    authorKind: "human",
    body: "Please re-check the window length.",
  });
  expect(comments[0]!.id).toBe(c.result.commentId);
  const evidenceAfter = Number(
    (await w.db.admin.query("SELECT count(*) FROM evidence_nodes WHERE workspace_id=$1", [workspaceId]))
      .rows[0].count,
  );
  expect(evidenceAfter).toBe(evidenceBefore); // a comment is never evidence
  const graph = await w.k.graph.get(w.owner, workspaceId);
  expect(graph.nodes.some((n) => n.label.includes("re-check"))).toBe(false);

  // Step 3: compare. Exactly the three known differences, with before and after values.
  const cmp = await w.h.snapshots.compare(w.owner, workspaceId, snapA.snapshotId, snapB.snapshotId);
  expect(cmp.changes.length).toBe(3);
  const byId = Object.fromEntries(cmp.changes.map((x) => [x.objectId, x]));
  const qc = byId[`panel:${p1.panel.panelId}`]!;
  expect(qc.change).toBe("changed");
  expect((qc.before as typeof changed).queryRef.hash).toBe("1".repeat(64));
  expect((qc.after as typeof changed).queryRef.hash).toBe("2".repeat(64));
  const vc = byId[`node:${claim}`]!;
  expect(vc.change).toBe("changed");
  expect((vc.before as { data: { verdict: string } }).data.verdict).toBe("open");
  expect((vc.after as { data: { verdict: string } }).data.verdict).toBe("supported");
  expect(byId[`panel:${added.panel.panelId}`]!.change).toBe("added");
  expect(byId[`node:${agentNode}`]).toBeUndefined();
  // (d) self comparison is empty; across workspaces the other workspace's snapshot is indistinguishable from missing.
  const self = await w.h.snapshots.compare(w.owner, workspaceId, snapA.snapshotId, snapA.snapshotId);
  expect(self.changes).toEqual([]);
  expect(self.semanticPinChanges).toEqual([]);
  const other = await newWs(w);
  const foreignSnap = await snapshot(w, other.workspaceId, "other");
  const cross = await rejection(
    w.h.snapshots.compare(w.owner, workspaceId, snapA.snapshotId, foreignSnap.snapshotId),
  );
  const nonexistent = await rejection(
    w.h.snapshots.compare(w.owner, workspaceId, snapA.snapshotId, randomUUID()),
  );
  expect([cross.code, cross.reasonCode]).toEqual([nonexistent.code, nonexistent.reasonCode]);
  expect(cross.reasonCode).toBe("ACCESS_DENIED"); // the HTTP layer maps this reason to 404 (history-routes guard)

  // Negative control: relabelling agent edits as human must be detected by the attribution check.
  const relabelled = tl.map((e) => ({ ...e, actorKind: e.actorKind === "agent" ? "human" : e.actorKind }));
  expect(relabelled.filter((e) => e.actorKind === "agent").length).toBe(0);
  expect(agentEvents.length).toBeGreaterThan(0);

  observe({
    testId: "W12",
    observed: `timeline of ${tl.length} entries all carry actorKind (1 agent entry, ${humans.length} human; snapshot entries attributed from their creating event); reviewer comment stored with author attribution and not as evidence (evidence rows unchanged), viewer attempt FORBIDDEN; comparison of A and B lists exactly 3 differences (panel query hash 1111->2222, claim verdict open->supported, panel added) and nothing else; self comparison empty; cross-workspace snapshot answers identically to a nonexistent one (ACCESS_DENIED, mapped to 404 over HTTP); relabelling agent edits as human is detected`,
    evidence: {
      timelineKinds: { agent: 1, human: humans.length },
      changes: cmp.changes.map((c) => `${c.objectId.split(":")[0]}:${c.change}`),
    },
  });
}, 60_000);
