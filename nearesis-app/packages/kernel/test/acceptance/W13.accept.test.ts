import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import { captureLiveObjects, hashOf } from "../../src/history/snapshots.ts";
import { ChFixture, clickhouseUp, qhash } from "../history/ch-executor.ts";
import { addNode, addPanel, newWs, panel, rejection, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
let ch: ChFixture;
let up = false;
beforeAll(async () => {
  up = await clickhouseUp();
  w = await world("w13");
  if (up) {
    ch = new ChFixture();
    await ch.setup();
  }
});
afterAll(async () => {
  await ch?.drop();
  await w?.db.drop();
});

const WATERMARK = { fx_dex: "2026-11-09T23:59:59Z", fx_bridge: "2026-11-09T23:59:59Z" };

it("W13: a branch starts from an exact snapshot with lineage and a frozen input map, sharing raw data by hash", async () => {
  if (!up) {
    observe({
      testId: "W13",
      observed: "ClickHouse is not reachable",
      blocked: "ClickHouse local stack unavailable",
    });
    return;
  }
  const { workspaceId } = await newWs(w);
  const tenant = { orgId: w.owner.principal.orgId, userId: w.owner.userId };
  const mainBranch = (
    await w.db.admin.query("SELECT active_branch_id FROM workspaces WHERE id=$1", [workspaceId])
  ).rows[0].active_branch_id as string;

  // Parent state: 2 panels over real ClickHouse data, raw objects in the content-addressed store, summaries.
  const rawA = new TextEncoder().encode("raw payload A ".repeat(500));
  const rawB = new TextEncoder().encode("raw payload B ".repeat(700));
  const ra = await w.h.objects.put(w.owner, rawA);
  const rb = await w.h.objects.put(w.owner, rawB);
  const dexPanel = (await addPanel(w, workspaceId, 0, panel("dex_total", qhash("dex_total")))).panel;
  const acctPanel = (await addPanel(w, workspaceId, 1, panel("dex_accounts", qhash("dex_accounts")))).panel;
  const evA = (
    await w.h.graphOps.addNode(w.owner, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      kind: "observation",
      label: "raw A",
      rawObjectHash: ra.hash,
    })
  ).result.nodeId as string;
  await w.h.graphOps.addNode(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    kind: "observation",
    label: "raw B",
    rawObjectHash: rb.hash,
  });
  for (const [m, v] of [
    ["dex_volume", "1.0.0"],
    ["dex_accounts", "1.0.0"],
  ] as const)
    await w.h.graphOps.changeSemanticVersion(w.owner, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      metricId: m,
      toVersion: v,
    });
  await w.h.summaries.create(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    body: "Early summary 1",
    sourceRefs: [evA],
  });
  await w.h.summaries.create(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    body: "Early summary 2",
    sourceRefs: [evA],
  });
  const snapRes = await w.h.snapshots.create(
    w.owner,
    workspaceId,
    {
      expectedVersion: await wsVersion(w, workspaceId),
      label: "S",
      sourceSnapshot: { manifestHash: "f".repeat(64), watermark: WATERMARK },
    },
    { executor: ch },
  );
  const S = (snapRes.result as { snapshotId: string }).snapshotId;
  const snapRow = (
    await w.db.admin.query("SELECT event_seq, data_vintage FROM history_snapshots WHERE id=$1", [S])
  ).rows[0];
  const N = snapRow.event_seq as number;

  const store0 = await w.h.objects.stats(w.owner);
  const catalogHash = async () =>
    w.db.app.tx(tenant, async (tx) => {
      const o = await captureLiveObjects(tx, workspaceId, mainBranch);
      return hashOf(Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith("metric:"))));
    });
  const parentResults0 = await w.h.snapshots.executePinned(w.owner, workspaceId, S, ch);

  // Step 1: create the branch from S at base_event_seq N.
  const b = await w.h.branches.create(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    fromSnapshotId: S,
    name: "exclude-top-1pct",
  });
  const branchId = b.result.branchId as string;

  // Step 2: the parent moves on after N: a new panel, new data, a new node, a new summary, a version bump.
  const latePanel = (await addPanel(w, workspaceId, 2, panel("bridge_total", qhash("bridge_total")))).panel;
  await ch.refresh();
  const lateNode = await addNode(w, workspaceId, "claim", "late claim");
  await w.h.summaries.create(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    body: "Late summary",
    sourceRefs: [lateNode],
  });
  await w.h.graphOps.changeSemanticVersion(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    metricId: "dex_volume",
    toVersion: "2.0.0",
  });

  // Step 3: the branch's panels, input map and storage footprint.
  const view = await w.h.branches.view(w.owner, workspaceId, branchId);
  const brRow = (
    await w.db.admin.query("SELECT parent_branch_id, base_event_seq FROM branches WHERE id=$1", [branchId])
  ).rows[0];
  // (a) lineage, base_event_seq = N, frozen input map equal to S's, no post-N changes.
  expect(brRow.parent_branch_id).toBe(mainBranch);
  expect(brRow.base_event_seq).toBe(N);
  expect(view.baseEventSeq).toBe(N);
  expect(view.parentBranchId).toBe(mainBranch);
  expect(view.inputVersionMap).toEqual({
    semanticPins: snapRow.data_vintage.semanticPins,
    sourceSnapshot: snapRow.data_vintage.sourceSnapshot,
  });
  const panelIds = Object.keys(view.objects)
    .filter((k) => k.startsWith("panel:"))
    .sort();
  expect(panelIds).toEqual([`panel:${dexPanel.panelId}`, `panel:${acctPanel.panelId}`].sort());
  expect(view.objects[`panel:${latePanel.panelId}`]).toBeUndefined();
  expect(view.objects[`node:${lateNode}`]).toBeUndefined();
  expect((view.objects["metric:dex_volume"] as { version: string }).version).toBe("1.0.0"); // not the parent's later 2.0.0
  const live = await w.db.app.tx(tenant, (tx) => captureLiveObjects(tx, workspaceId, mainBranch));
  expect(live[`panel:${latePanel.panelId}`]).toBeDefined(); // the parent really did change
  const mem = await w.h.branches.memory(w.owner, workspaceId, branchId);
  expect(mem.map((m) => m.body).sort()).toEqual(["Early summary 1", "Early summary 2"]); // snapshot copy, not "Late summary"
  const parentMem = await w.h.summaries.recall(w.owner, workspaceId);
  for (const m of mem) expect(parentMem.some((p) => p.summaryId === m.id)).toBe(false); // distinct ids, no live link

  // (b) raw data is referenced by hash; the store is untouched by branching and by branch work.
  const store1 = await w.h.objects.stats(w.owner);
  expect(store1).toEqual(store0);
  expect(store1.hashes).toEqual([ra.hash, rb.hash].sort());
  expect((view.objects[`node:${evA}`] as { rawObjectHash: string }).rawObjectHash).toBe(ra.hash);
  expect(sha256Hex(canonicalJson(Array.from(rawA)))).not.toBe(ra.hash); // (sanity: hash is of the bytes, not a JSON copy)
  const overlayBytes = (
    await w.db.admin.query("SELECT length(overlay::text) AS n FROM history_branches WHERE branch_id=$1", [
      branchId,
    ])
  ).rows[0].n;
  expect(overlayBytes).toBeLessThan(100);

  // Step 4: apply the exclusion filter in the branch; parent catalog and results stay byte-equal.
  const catalogBeforeBranchWork = await catalogHash();
  const liveResultsBefore = await w.h.snapshots.executeLive(w.owner, workspaceId, ch);
  await w.h.branches.change(w.owner, workspaceId, branchId, {
    expectedVersion: await wsVersion(w, workspaceId),
    ops: [
      {
        op: "set",
        objectId: "metric:dex_volume",
        value: { version: "1.0.0", exclusions: { topAccountsPercent: 1 } },
      },
    ],
  });
  const branchResults = await w.h.branches.executePanels(w.owner, workspaceId, branchId, ch);
  const parentResults1 = await w.h.snapshots.executePinned(w.owner, workspaceId, S, ch);
  // (c) the filter changes branch results and leaves the parent's catalog hash and results byte-equal.
  const baseline = Object.fromEntries(parentResults0.map((r) => [r.panelId, r.resultHash]));
  const brByPanel = Object.fromEntries(branchResults.map((r) => [r.panelId, r.resultHash]));
  expect(brByPanel[dexPanel.panelId]).not.toBe(baseline[dexPanel.panelId]);
  expect(brByPanel[acctPanel.panelId]).not.toBe(baseline[acctPanel.panelId]); // accounts panel is filtered too
  expect(Object.keys(brByPanel).sort()).toEqual([dexPanel.panelId, acctPanel.panelId].sort());
  expect(parentResults1.map((r) => r.resultHash)).toEqual(parentResults0.map((r) => r.resultHash));
  expect(parentResults1.every((r) => r.byteEqualToCaptured)).toBe(true);
  // The parent's catalog and live results are byte-equal before and after the branch work.
  const parentCatalog1 = await catalogHash();
  expect(parentCatalog1).toBe(catalogBeforeBranchWork);
  const liveResultsAfter = await w.h.snapshots.executeLive(w.owner, workspaceId, ch);
  expect(liveResultsAfter.map((r) => r.resultHash)).toEqual(liveResultsBefore.map((r) => r.resultHash));
  const parentMetric = live["metric:dex_volume"] as { version: string; exclusions?: unknown };
  expect(parentMetric.exclusions).toBeUndefined();
  const liveAfter = await w.db.app.tx(tenant, (tx) => captureLiveObjects(tx, workspaceId, mainBranch));
  expect(hashOf(liveAfter["metric:dex_volume"])).toBe(hashOf(live["metric:dex_volume"]));
  expect(store1.count).toBe((await w.h.objects.stats(w.owner)).count);

  // Step 5: copy a panel to another workspace: a new item with lineage, no live link to the original.
  const other = await newWs(w);
  const copied = await w.h.copy.copyPanel(w.owner, workspaceId, dexPanel.panelId, other.workspaceId);
  expect(copied.panelId).not.toBe(dexPanel.panelId);
  const lin = await w.h.copy.lineage(w.owner, other.workspaceId, copied.panelId);
  expect(lin).toMatchObject({ sourceWorkspaceId: workspaceId, sourceObjectId: dexPanel.panelId });
  const copyRow = (
    await w.db.admin.query("SELECT id, workspace_id, spec FROM panel_specs WHERE id=$1", [copied.panelId])
  ).rows[0];
  expect(copyRow.workspace_id).toBe(other.workspaceId);
  // (d) editing the original afterwards does not change the copy; a foreign tenant cannot copy it at all.
  await w.k.commands.execute(w.owner, workspaceId, {
    apiVersion: "v1",
    commandId: randomUUID(),
    commandType: "canvas.apply_patch",
    expectedVersion: await wsVersion(w, workspaceId),
    payload: {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: randomUUID(),
      expectedRevision: 3,
      operations: [
        { op: "updatePanel", panelId: dexPanel.panelId, panel: { ...dexPanel, title: "renamed in parent" } },
      ],
    },
  });
  const copyAfter = (await w.db.admin.query("SELECT spec FROM panel_specs WHERE id=$1", [copied.panelId]))
    .rows[0];
  expect(copyAfter.spec.title).toBe("dex_total");
  const foreign = await rejection(
    w.h.copy.copyPanel(w.outsider, workspaceId, dexPanel.panelId, other.workspaceId),
  );
  expect(foreign.reasonCode).toBe("ACCESS_DENIED");
  const lineageRows = (
    await w.db.admin.query("SELECT count(*) FROM object_lineage WHERE source_object_id=$1", [
      dexPanel.panelId,
    ])
  ).rows[0].count;
  expect(Number(lineageRows)).toBe(1);

  // Negative control: a branch that read the parent's live overlay would contain the post-N panel and fail (a).
  const liveHasLate = Object.keys(live).includes(`panel:${latePanel.panelId}`);
  const branchHasLate = panelIds.includes(`panel:${latePanel.panelId}`);
  expect(liveHasLate && !branchHasLate).toBe(true);

  observe({
    testId: "W13",
    observed: `branch records parent ${mainBranch.slice(0, 8)}, base_event_seq ${N} and an input map equal to S; after the parent gained a panel, node, summary, data refresh and dex_volume 2.0.0 the branch still shows only the 2 base panels, metric 1.0.0 and a snapshot copy of 2 early summaries (distinct ids); the raw store held ${store0.count} objects / ${store0.bytes} bytes before and after branching and branch work, with evidence referencing raw_object_hash and a ${overlayBytes}-byte overlay; the top-1% exclusion changed both branch panel results while the parent's 2 pinned panels stayed byte-equal and its metric carries no exclusion; a copied panel got a new id and a lineage row, was unaffected by a later parent edit, and a foreign tenant was denied`,
    evidence: {
      N,
      store: store0,
      branchPanels: panelIds.length,
      branchHashes: Object.values(brByPanel).map((h) => h.slice(0, 10)),
      baselineHashes: Object.values(baseline).map((h) => h.slice(0, 10)),
    },
  });
}, 90_000);
