import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalJson } from "@nearesis/plugin-sdk";
import { observe } from "@nearesis/acceptance";
import { ChFixture, clickhouseUp, qhash } from "../history/ch-executor.ts";
import { addPanel, newWs, panel, rejection, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
let ch: ChFixture;
let up = false;
beforeAll(async () => {
  up = await clickhouseUp();
  w = await world("w10");
  if (up) {
    ch = new ChFixture();
    await ch.setup();
  }
});
afterAll(async () => {
  await ch?.drop();
  await w?.db.drop();
});

const MANIFEST = "d".repeat(64);
const WATERMARK = { fx_dex: "2026-11-09T23:59:59Z", fx_bridge: "2026-11-09T23:59:59Z" };

it("W10: a finalized snapshot pins source watermarks and semantic versions; later changes never alter it", async () => {
  if (!up) {
    observe({
      testId: "W10",
      observed: "ClickHouse is not reachable",
      blocked: "ClickHouse local stack unavailable",
    });
    return;
  }
  const { workspaceId } = await newWs(w);
  const names = ["dex_total", "dex_accounts", "bridge_total", "dex_daily"] as const;
  let rev = 0;
  const panels: Awaited<ReturnType<typeof addPanel>>["panel"][] = [];
  for (const n of names) {
    const added = await addPanel(w, workspaceId, rev++, panel(n, qhash(n)));
    panels.push(added.panel);
  }
  for (const [metricId, v] of [
    ["dex_volume", "1.0.0"],
    ["dex_accounts", "1.0.0"],
    ["bridge_volume", "1.0.0"],
  ] as const)
    await w.h.graphOps.changeSemanticVersion(w.owner, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      metricId,
      toVersion: v,
    });

  // Negative: finalization with a missing watermark is rejected, never filled with now().
  const countSnaps = async () =>
    Number(
      (await w.db.admin.query("SELECT count(*) FROM history_snapshots WHERE workspace_id=$1", [workspaceId]))
        .rows[0].count,
    );
  const noWm = await rejection(
    w.h.snapshots.create(
      w.owner,
      workspaceId,
      {
        expectedVersion: await wsVersion(w, workspaceId),
        label: "bad",
        sourceSnapshot: { manifestHash: MANIFEST, watermark: { fx_dex: WATERMARK.fx_dex } },
      },
      { executor: ch },
    ),
  );
  const noSource = await rejection(
    w.h.snapshots.create(
      w.owner,
      workspaceId,
      { expectedVersion: await wsVersion(w, workspaceId), label: "bad2" },
      { executor: ch },
    ),
  );
  expect([noWm.reasonCode, noSource.reasonCode]).toEqual(["WATERMARK_MISSING", "WATERMARK_MISSING"]);
  expect(JSON.stringify(noWm.opts.details)).toContain("fx_bridge");
  expect(await countSnaps()).toBe(0);

  // Step 1: finalize S1.
  const r1 = await w.h.snapshots.create(
    w.owner,
    workspaceId,
    {
      expectedVersion: await wsVersion(w, workspaceId),
      label: "S1",
      sourceSnapshot: { manifestHash: MANIFEST, watermark: WATERMARK },
    },
    { executor: ch },
  );
  const s1 = r1.result as { snapshotId: string; contentHash: string };
  const row = (
    await w.db.admin.query("SELECT data_vintage, payload, content_hash FROM history_snapshots WHERE id=$1", [
      s1.snapshotId,
    ])
  ).rows[0];
  // (a) one watermark per source, the semantic map, a manifest hash; snapshot.finalized once.
  expect(Object.keys(row.data_vintage.sourceSnapshot.watermark).sort()).toEqual(["fx_bridge", "fx_dex"]);
  expect(row.data_vintage.sourceSnapshot.manifestHash).toBe(MANIFEST);
  expect(row.data_vintage.semanticPins).toEqual({
    bridge_volume: "1.0.0",
    dex_accounts: "1.0.0",
    dex_volume: "1.0.0",
  });
  const fin = await w.db.admin.query(
    "SELECT count(*) FROM workspace_events WHERE workspace_id=$1 AND event_type='snapshot.finalized'",
    [workspaceId],
  );
  expect(Number(fin.rows[0].count)).toBe(1);
  const captured = row.payload.panelResults as Record<
    string,
    { resultHash: string; result: unknown; cacheKey: string }
  >;
  expect(Object.keys(captured).sort()).toEqual(panels.map((p) => p.panelId).sort());

  // Step 2: live data refresh and a semantic version bump.
  await ch.refresh();
  await w.h.graphOps.changeSemanticVersion(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    metricId: "dex_volume",
    toVersion: "2.0.0",
  });

  // Step 3: execute each pinned panel against S1, and the live panels for comparison.
  const pinned = await w.h.snapshots.executePinned(w.owner, workspaceId, s1.snapshotId, ch);
  const live = await w.h.snapshots.executeLive(w.owner, workspaceId, ch);
  expect(pinned.length).toBe(4);
  for (const p of pinned) {
    // (b) byte-equal to the capture, with metadata naming S1 and the pinned versions.
    expect(canonicalJson(p.result)).toBe(canonicalJson(captured[p.panelId]!.result)); // canonical bytes (jsonb reorders keys)
    expect(p.byteEqualToCaptured).toBe(true);
    expect(p.metadata.snapshotId).toBe(s1.snapshotId);
    expect(p.metadata.pinnedSemanticVersions.dex_volume).toBe("1.0.0");
    expect(p.metadata.watermark).toEqual(WATERMARK);
  }
  // (c) live panels reflect the refresh and the new version, with different hashes.
  for (const p of live) {
    const was = pinned.find((x) => x.panelId === p.panelId)!;
    expect(p.resultHash, `live panel ${p.panelId} must differ from pinned`).not.toBe(was.resultHash);
    expect(p.metadata.snapshotId).toBeNull();
    expect(p.metadata.pinnedSemanticVersions.dex_volume).toBe("2.0.0");
    // (e) the cache key of the pinned query differs from the live key.
    expect(p.metadata.cacheKey).not.toBe(was.metadata.cacheKey);
  }
  expect(pinned.map((p) => p.metadata.cacheKey)).toEqual(panels.map((p) => captured[p.panelId]!.cacheKey));

  // (d) mutation of a finalized snapshot is rejected for the application role.
  const tenant = { orgId: w.owner.principal.orgId, userId: w.owner.userId };
  const attempt = (sql: string) =>
    w.db.app
      .tx(tenant, (tx) => tx.query(sql, [s1.snapshotId]))
      .then(
        () => "updated",
        (e: Error) => e.message,
      );
  const mutations = [
    await attempt("UPDATE history_snapshots SET label = 'tampered' WHERE id = $1"),
    await attempt("UPDATE history_snapshots SET content_hash = repeat('0',64) WHERE id = $1"),
    await attempt("UPDATE history_snapshots SET payload = '{}'::jsonb WHERE id = $1"),
    await attempt("DELETE FROM history_snapshots WHERE id = $1"),
  ];
  for (const m of mutations) expect(m).toMatch(/permission denied|immutable/);
  const after = (
    await w.db.admin.query("SELECT content_hash FROM history_snapshots WHERE id=$1", [s1.snapshotId])
  ).rows[0];
  expect(after.content_hash).toBe(s1.contentHash);
  const view = await w.h.snapshots.view(w.owner, workspaceId, s1.snapshotId, "all");
  expect(view.integrityOk).toBe(true);

  // Negative control: executing a pinned panel against live data must FAIL (b).
  const livePin = live.find((p) => p.panelId === panels[0]!.panelId)!;
  expect(livePin.resultHash).not.toBe(captured[panels[0]!.panelId]!.resultHash);

  observe({
    testId: "W10",
    observed: `S1 recorded watermarks for fx_dex and fx_bridge, the 3-metric semantic version map and manifest ${MANIFEST.slice(0, 8)}; snapshot.finalized emitted once; after a ClickHouse refresh and dex_volume 1.0.0 -> 2.0.0 all 4 pinned panels returned results byte-equal to the capture (metadata names S1) while all 4 live panels differ in hash and cache key; finalization with a missing watermark (partial or none) rejected with WATERMARK_MISSING and 0 snapshots stored; label/hash/payload UPDATE and DELETE denied; integrity re-verified`,
    evidence: {
      pinnedHashes: pinned.map((p) => p.resultHash.slice(0, 12)),
      liveHashes: live.map((p) => p.resultHash.slice(0, 12)),
      watermark: WATERMARK,
      mutations: mutations.map((m) => m.slice(0, 40)),
    },
  });
}, 60_000);
