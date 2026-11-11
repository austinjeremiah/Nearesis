import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { rejection, addNode, addPanel, newWs, snapshot, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";
import { captureLiveObjects, hashOf } from "../../src/history/snapshots.ts";

let w: World;
beforeAll(async () => (w = await world("w01")));
afterAll(async () => w?.db.drop());

it("W01: a branch experiment never alters the parent; the branch diff is available", async () => {
  const { workspaceId } = await newWs(w);
  await addPanel(w, workspaceId, 0);
  const claim = await addNode(w, workspaceId, "claim", "Intents volume is rising", {
    data: { verdict: "open" },
  });
  const result = await addNode(w, workspaceId, "statistical_result", "OLS slope", {
    semanticPins: { dex_volume: "1.0.0" },
  });
  const snap = await snapshot(w, workspaceId, "baseline");
  const mainBranch = (await w.k.workspaces.get(w.owner, workspaceId)).activeBranchId!;

  const parentBefore = await w.db.admin.connect().then(async (c) => {
    try {
      const objs = await captureLiveObjects(c as never, workspaceId, mainBranch);
      return objs;
    } finally {
      c.release();
    }
  });
  const sv0 = (
    await w.db.admin.query("SELECT count(*)::int AS n FROM semantic_versions WHERE workspace_id=$1", [
      workspaceId,
    ])
  ).rows[0].n;

  const b = await w.h.branches.create(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    fromSnapshotId: snap.snapshotId,
    name: "exclude-bots",
  });
  const branchId = b.result.branchId as string;
  expect(b.result.parentBranchId).toBe(mainBranch);

  // The experiment: change a metric definition and a claim, add a model node. All on the branch overlay.
  await w.h.branches.change(w.owner, workspaceId, branchId, {
    expectedVersion: await wsVersion(w, workspaceId),
    ops: [
      { op: "set", objectId: "metric:dex_volume", value: { version: "2.0.0", exclusions: ["bot_accounts"] } },
      {
        op: "set",
        objectId: `node:${claim}`,
        value: {
          kind: "claim",
          label: "Intents volume is rising (ex-bots)",
          data: { verdict: "weaker" },
          semanticPins: {},
          tombstone: false,
        },
      },
      { op: "delete", objectId: `node:${result}` },
    ],
  });

  const parentAfter = await w.db.admin.connect().then(async (c) => {
    try {
      return await captureLiveObjects(c as never, workspaceId, mainBranch);
    } finally {
      c.release();
    }
  });
  const sv1 = (
    await w.db.admin.query("SELECT count(*)::int AS n FROM semantic_versions WHERE workspace_id=$1", [
      workspaceId,
    ])
  ).rows[0].n;
  const flagsOpen = (
    await w.db.admin.query("SELECT count(*)::int AS n FROM evidence_node_flags WHERE workspace_id=$1", [
      workspaceId,
    ])
  ).rows[0].n;

  // Parent unchanged: identical objects, no metric version recorded, no flags, claim still the original.
  expect(hashOf(parentAfter)).toBe(hashOf(parentBefore));
  expect(sv1).toBe(sv0);
  expect(flagsOpen).toBe(0);
  expect((parentAfter[`node:${claim}`] as { data: { verdict: string } }).data.verdict).toBe("open");
  expect(parentAfter[`node:${result}`]).toBeDefined();

  // Branch diff available: exactly the three experimental changes, relative to the base snapshot.
  const diff = await w.h.branches.diff(w.owner, workspaceId, branchId);
  const kinds = Object.fromEntries(diff.changes.map((c) => [c.objectId, c.change]));
  expect(kinds).toEqual({
    "metric:dex_volume": "added",
    [`node:${claim}`]: "changed",
    [`node:${result}`]: "removed",
  });
  const view = await w.h.branches.view(w.owner, workspaceId, branchId);
  expect((view.objects["metric:dex_volume"] as { version: string }).version).toBe("2.0.0");
  const vs = await w.h.branches.diff(w.owner, workspaceId, branchId, mainBranch);
  expect(vs.changes.length).toBe(3);

  // Negative: unauthorised/foreign access and malformed overlays are rejected; the parent stays untouched.
  const foreign = await rejection(w.h.branches.view(w.outsider, workspaceId, branchId));
  expect(foreign.code).toBe("FORBIDDEN");
  const malformed = await rejection(
    w.h.branches.change(w.owner, workspaceId, branchId, {
      expectedVersion: await wsVersion(w, workspaceId),
      ops: [{ op: "set", objectId: "node:not-a-uuid", value: { kind: "claim", label: "x" } }],
    }),
  );
  expect(malformed.code).toBe("VALIDATION_FAILED");
  const viewerWrite = await rejection(
    w.h.branches.change(w.viewer, workspaceId, branchId, {
      expectedVersion: await wsVersion(w, workspaceId),
      ops: [{ op: "delete", objectId: `node:${claim}` }],
    }),
  );
  expect(viewerWrite.reasonCode).toBe("INSUFFICIENT_ROLE");

  observe({
    testId: "W01",
    observed: `branch ${branchId} from snapshot ${snap.snapshotId} (parent ${mainBranch}); parent objects hash unchanged (${hashOf(parentAfter).slice(0, 12)}), semantic_versions rows ${sv0}->${sv1}, open flags ${flagsOpen}; branch diff = ${JSON.stringify(kinds)}; foreign view ${foreign.code}, malformed overlay ${malformed.code}, viewer write ${viewerWrite.reasonCode}`,
    evidence: { diff: kinds, parentHashUnchanged: true, semanticVersionRows: [sv0, sv1] },
  });
});
