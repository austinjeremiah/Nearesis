import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { canonicalJson } from "@nearesis/plugin-sdk";
import { captureLiveObjects } from "../../src/history/snapshots.ts";
import { stateHashOf, verifyReconstructionFile } from "../../src/history/reconstruct.ts";
import { ChFixture, clickhouseUp, qhash } from "../history/ch-executor.ts";
import { addEdge, addNode, addPanel, newWs, panel, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";
import { randomUUID } from "node:crypto";

let w: World;
let ch: ChFixture;
let up = false;
beforeAll(async () => {
  up = await clickhouseUp();
  w = await world("w11");
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

it("W11: any past revision is reconstructed exactly from the append-only journal, labelled and verifiable", async () => {
  if (!up) {
    observe({
      testId: "W11",
      observed: "ClickHouse is not reachable",
      blocked: "ClickHouse local stack unavailable",
    });
    return;
  }
  const { workspaceId } = await newWs(w);
  const tenant = { orgId: w.owner.principal.orgId, userId: w.owner.userId };
  const branchId = (
    await w.db.admin.query("SELECT active_branch_id FROM workspaces WHERE id=$1", [workspaceId])
  ).rows[0].active_branch_id as string;
  const maxSeq = async () =>
    Number(
      (
        await w.db.admin.query("SELECT max(seq) AS s FROM workspace_events WHERE workspace_id=$1", [
          workspaceId,
        ])
      ).rows[0].s,
    );

  // The oracle: state captured live from the real tables at every step.
  const oracle = new Map<number, string>();
  const capture = async () => {
    const seq = await maxSeq();
    const h = await w.db.app.tx(tenant, async (tx) => {
      const objects = await captureLiveObjects(tx, workspaceId, branchId);
      const doc = await w.k.canvas.load(tx, workspaceId, branchId);
      return stateHashOf(objects, doc?.documentRevision ?? 0, doc?.panels ?? []);
    });
    oracle.set(seq, h);
  };

  const names = ["dex_total", "dex_accounts", "bridge_total"] as const;
  const panels: Awaited<ReturnType<typeof addPanel>>["panel"][] = [];
  let rev = 0;
  await capture();
  for (const n of names) {
    panels.push((await addPanel(w, workspaceId, rev++, panel(n, qhash(n)))).panel);
    await capture();
  }
  for (const m of ["dex_volume", "dex_accounts", "bridge_volume"]) {
    await w.h.graphOps.changeSemanticVersion(w.owner, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      metricId: m,
      toVersion: "1.0.0",
    });
    await capture();
  }
  const snaps: string[] = [];
  const snap = async (label: string) => {
    const r = await w.h.snapshots.create(
      w.owner,
      workspaceId,
      {
        expectedVersion: await wsVersion(w, workspaceId),
        label,
        sourceSnapshot: { manifestHash: "e".repeat(64), watermark: WATERMARK },
      },
      { executor: ch },
    );
    snaps.push((r.result as { snapshotId: string }).snapshotId);
    await capture();
  };
  await snap("S-early"); // journal seq 8

  const nodes: string[] = [];
  let counter = 0;
  const fill = async (target: number) => {
    while ((await maxSeq()) < target) {
      counter++;
      if (counter % 3 === 0 && nodes.length >= 2) {
        const a = nodes[nodes.length - 1]!;
        const b = nodes[nodes.length - 2]!;
        await addEdge(w, workspaceId, a, b, counter % 2 ? "derived_from" : "references");
      } else {
        const kind = ["claim", "observation", "statistical_result"][counter % 3]!;
        nodes.push(
          await addNode(w, workspaceId, kind, `n${counter}`, {
            data: { n: counter },
            semanticPins: counter % 4 ? {} : { dex_volume: "1.0.0" },
          }),
        );
      }
      await capture();
    }
  };
  const claimSeq = await maxSeq();
  await fill(14);
  // A correction (compensating event) referencing the original node-added event.
  const firstClaim = nodes[0]!;
  const originalRow = (
    await w.db.admin.query(
      "SELECT seq, payload_hash FROM workspace_events WHERE workspace_id=$1 AND payload->>'nodeId'=$2",
      [workspaceId, firstClaim],
    )
  ).rows[0];
  await fill(19);
  await w.h.graphOps.correctNode(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    nodeId: firstClaim,
    correctsSeq: originalRow.seq,
    label: "n1 (corrected)",
    data: { n: 111 },
    reason: "typo in original",
  });
  await capture();
  // A superseded claim.
  await w.h.graphOps.addEdge(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    from: nodes[2]!,
    to: nodes[1]!,
    relation: "supersedes",
    reason: "newer analysis",
  });
  await capture();
  await fill(27);
  await snap("S-mid"); // seq 28
  await ch.refresh(); // live data moves on
  await fill(39);
  // A deleted panel.
  const removed = panels[2]!;
  await w.k.commands.execute(w.owner, workspaceId, {
    apiVersion: "v1",
    commandId: randomUUID(),
    commandType: "canvas.apply_patch",
    expectedVersion: await wsVersion(w, workspaceId),
    payload: {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: randomUUID(),
      expectedRevision: rev,
      operations: [{ op: "removePanel", panelId: removed.panelId }],
    },
  });
  await capture();
  await fill(57);
  await snap("S-late"); // seq 58
  await fill(60);
  expect(await maxSeq()).toBe(60);
  void claimSeq;

  const recon = async (n: number) => w.h.reconstruct.reconstruct(w.owner, workspaceId, n);
  const r10 = await recon(10);
  const r30 = await recon(30);
  const r60 = await recon(60);

  // (a) hash-equal to the oracle at each revision.
  for (const [n, r] of [
    [10, r10],
    [30, r30],
    [60, r60],
  ] as const)
    expect(r.stateHash, `revision ${n}`).toBe(oracle.get(n));
  expect(r60.canvas.panels.map((p) => p.panelId).sort()).toEqual(
    panels
      .slice(0, 2)
      .map((p) => p.panelId)
      .sort(),
  ); // deleted panel absent
  expect(r30.canvas.panels.length).toBe(3);
  // (b) panels display the data of the pinned snapshot of that revision, never current data.
  const captured = async (sid: string) =>
    (await w.db.admin.query("SELECT payload FROM history_snapshots WHERE id=$1", [sid])).rows[0].payload
      .panelResults as Record<string, { resultHash: string; result: unknown }>;
  const mid = await captured(snaps[1]!);
  for (const p of r30.panels) {
    expect(p.dataState).toBe("pinned");
    expect(p.snapshotId).toBe(snaps[1]);
    expect(canonicalJson(p.data)).toBe(canonicalJson(mid[p.panelId]!.result));
  }
  const liveNow = await w.h.snapshots.executeLive(w.owner, workspaceId, ch);
  const liveTotal = liveNow.find((p) => p.panelId === panels[0]!.panelId)!.resultHash;
  expect(liveTotal).not.toBe(mid[panels[0]!.panelId]!.resultHash); // current data differs; reconstruction did not use it
  expect(r10.exactReproduction && r30.exactReproduction && r60.exactReproduction).toBe(true);
  // (c) the correction is a compensating event referencing the original, which is intact.
  const corr = (
    await w.db.admin.query(
      "SELECT seq, payload FROM workspace_events WHERE workspace_id=$1 AND payload->>'change'='graph.correction'",
      [workspaceId],
    )
  ).rows[0];
  expect(corr.payload.corrects.seq).toBe(originalRow.seq);
  expect(corr.seq).toBeGreaterThan(originalRow.seq);
  const orig2 = (
    await w.db.admin.query("SELECT payload_hash FROM workspace_events WHERE workspace_id=$1 AND seq=$2", [
      workspaceId,
      originalRow.seq,
    ])
  ).rows[0];
  expect(orig2.payload_hash).toBe(originalRow.payload_hash);
  // (d) the application role cannot update or delete journal rows.
  const jm = async (sql: string) =>
    w.db.app
      .tx(tenant, (tx) => tx.query(sql, [workspaceId]))
      .then(
        () => "ok",
        (e: Error) => e.message,
      );
  const upd = await jm("UPDATE workspace_events SET event_type = 'x' WHERE workspace_id = $1");
  const del = await jm("DELETE FROM workspace_events WHERE workspace_id = $1");
  expect(upd).toMatch(/permission denied/);
  expect(del).toMatch(/permission denied/);
  // (e) export for revision 30 re-verifies.
  const f30 = await w.h.reconstruct.exportFile(w.owner, workspaceId, 30);
  expect(verifyReconstructionFile(f30)).toBe(true);
  expect(f30.exactReproduction).toBe(true);
  expect(f30.snapshotIds).toEqual([snaps[1]]);
  expect(f30.eventsApplied.length).toBe(30);
  expect(verifyReconstructionFile({ ...f30, exactReproduction: false })).toBe(false); // tampering is detected

  // Step 5: purge the snapshot pinned by revision 60; and a revision whose vintage was never recorded.
  await w.h.snapshots.purge(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    snapshotId: snaps[2]!,
    reason: "legal retention",
  });
  const r60p = await recon(60);
  const r4 = await recon(4);
  expect(r60p.stateHash).toBe(oracle.get(60)); // the graph/canvas still replay exactly from the journal
  expect(r60p.panels.length).toBe(2);
  for (const p of r60p.panels) {
    expect(p.dataState).toBe("vintage_unavailable");
    expect(p.data).toBeNull(); // not current data, not an older snapshot's data
  }
  expect(r60p.unavailableSnapshotIds).toEqual([snaps[2]]);
  expect(r60p.exactReproduction).toBe(false);
  expect(r4.panels.length).toBe(3);
  expect(r4.panels.every((p) => p.dataState === "vintage_unavailable" && p.snapshotId === null)).toBe(true);
  expect(r4.exactReproduction).toBe(false);
  const f60p = await w.h.reconstruct.exportFile(w.owner, workspaceId, 60);
  expect(verifyReconstructionFile(f60p)).toBe(true);
  expect(f60p.exactReproduction).toBe(false);
  expect(f60p.unavailableSnapshotIds).toEqual([snaps[2]]);
  expect(f60p.affectedPanels.sort()).toEqual(r60p.panels.map((p) => p.panelId).sort());
  expect(f60p.notice).toMatch(/NOT an exact reproduction/);
  // Negative control: a build claiming exact reproduction for the purged revision fails criterion (b).
  const claimsExactWhereNot = { ...f60p, exactReproduction: true };
  const criterionB = (f: typeof f60p) => !(f.exactReproduction && f.unavailableSnapshotIds.length > 0);
  expect(criterionB(f60p)).toBe(true);
  expect(criterionB(claimsExactWhereNot)).toBe(false);
  expect(verifyReconstructionFile(claimsExactWhereNot)).toBe(false);

  observe({
    testId: "W11",
    observed: `reconstructed revisions 10, 30 and 60 of a 60-event journal (3 panels, a correction, a deleted panel, a superseded claim) hash-equal to the live-captured oracle; revision 30 panels carry the S-mid snapshot data (live data had moved on) and its export re-verifies (exactReproduction true, tamper detected); correction is event ${corr.seq} referencing original ${originalRow.seq} whose hash is intact; app role UPDATE/DELETE on the journal denied; after purging the snapshot pinned by revision 60 its 2 panels show vintage_unavailable (no data, no substitution), exactReproduction false and the export lists ${snaps[2]!.slice(0, 8)}; revision 4 (no recorded vintage) likewise unavailable and not exact`,
    evidence: {
      oracle: {
        10: oracle.get(10)!.slice(0, 12),
        30: oracle.get(30)!.slice(0, 12),
        60: oracle.get(60)!.slice(0, 12),
      },
      reconstructed: [r10.stateHash.slice(0, 12), r30.stateHash.slice(0, 12), r60.stateHash.slice(0, 12)],
      exact: {
        10: r10.exactReproduction,
        30: r30.exactReproduction,
        60: r60.exactReproduction,
        "60-purged": r60p.exactReproduction,
        4: r4.exactReproduction,
      },
      exportHash30: f30.contentHash.slice(0, 12),
      unavailable: f60p.unavailableSnapshotIds,
    },
  });
}, 90_000);
