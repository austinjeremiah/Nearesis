import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import type { Session } from "../../src/index.ts";
import { addNode, newWs, rejection, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w17")));
afterAll(async () => w?.db.drop());

it("W17: summaries stay subordinate to evidence; memory cannot invent a source or raise confidence", async () => {
  const { workspaceId } = await newWs(w);
  const agent: Session = {
    principal: { kind: "agent", actorId: randomUUID(), orgId: w.orgA.orgId, parentRunId: randomUUID() },
    role: "analyst",
    userId: w.orgA.users.ann!.userId,
  };
  const ev = async (label: string, pins: Record<string, string> = {}, data: Record<string, unknown> = {}) =>
    addNode(w, workspaceId, "statistical_result", label, { semanticPins: pins, data });
  const e1 = await ev("result 1", { dex_volume: "1.0.0" });
  const e2 = await ev("result 2", { fee_rate: "1.0.0" });
  const e3 = await ev("result 3");
  const claim = await addNode(w, workspaceId, "claim", "Adoption is rising", {
    data: { evidenceTier: "exploratory" },
  });
  const sum = async (
    s: Session,
    body: string,
    sourceRefs: string[],
    metricPins: Record<string, string> = {},
  ) =>
    (
      await w.h.summaries.create(s, workspaceId, {
        expectedVersion: await wsVersion(w, workspaceId),
        body,
        sourceRefs,
        metricPins,
      })
    ).result.summaryId as string;
  const S1 = await sum(agent, "Agent summary of result 1", [e1], { dex_volume: "1.0.0" });
  const S2 = await sum(w.owner, "Human summary of result 2", [e2], { fee_rate: "1.0.0" });
  const S3 = await sum(agent, "Agent summary of result 3", [e3]);
  const S4 = await sum(agent, "Agent summary with no source at all", []);
  const ghost = randomUUID();
  const S5 = await sum(agent, "Summary whose source does not exist", [ghost]);

  const evidenceRows = async () =>
    (
      await w.db.admin.query(
        "SELECT id, kind, label, data, semantic_pins, tombstone FROM evidence_nodes WHERE workspace_id=$1 ORDER BY id",
        [workspaceId],
      )
    ).rows;
  const linksOf = async (id: string) =>
    (await w.db.admin.query("SELECT source_refs FROM history_summaries WHERE id=$1", [id])).rows[0]
      .source_refs as string[];
  const evidenceBefore = JSON.stringify(await evidenceRows());
  const linksBefore = [await linksOf(S1), await linksOf(S2), await linksOf(S3)];

  // (a) summaries are a distinct kind: never in evidence_nodes, never with a verified level.
  const ids = [S1, S2, S3, S4, S5];
  const inEvidence = await w.db.admin.query(
    "SELECT 1 FROM evidence_nodes WHERE id = ANY($1::uuid[]) OR label LIKE '%summary%' OR label LIKE '%Summary%'",
    [ids],
  );
  expect(inEvidence.rows.length).toBe(0);
  expect((await w.k.graph.get(w.owner, workspaceId)).nodes.some((n) => ids.includes(n.id))).toBe(false);

  // Step 1: trigger the version change.
  const change = await w.h.graphOps.changeSemanticVersion(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    metricId: "dex_volume",
    toVersion: "2.0.0",
  });
  expect(change.result.changed).toBe(true);

  // (b) the affected summary is stale; sources and evidence rows are byte-unchanged; unaffected summaries are not stale.
  const recall = await w.h.summaries.recall(w.owner, workspaceId);
  const by = Object.fromEntries(recall.map((r) => [r.summaryId, r]));
  expect(by[S1]!.stale).toBe(true);
  expect(by[S1]!.staleReason).toMatch(/dex_volume changed to 2.0.0/);
  for (const s of [S2, S3, S4, S5]) expect(by[s]!.stale).toBe(false);
  expect(JSON.stringify(await evidenceRows())).toBe(evidenceBefore);
  expect([await linksOf(S1), await linksOf(S2), await linksOf(S3)]).toEqual(linksBefore);
  expect(by[S1]!.sourceRefs).toEqual([e1]); // stale, but the link is stable

  // (c) each recalled item resolves to authoritative evidence; unresolved items are flagged and not citable.
  for (const s of [S1, S2, S3]) {
    expect(by[s]!.evidenceStatus).toBe("resolved");
    expect(by[s]!.citable).toBe(true);
    expect(by[s]!.sourceRefs.length).toBeGreaterThan(0);
  }
  expect(by[S4]).toMatchObject({
    evidenceStatus: "evidence_unresolved",
    citable: false,
    unresolvedRefs: ["<no source>"],
  });
  expect(by[S5]).toMatchObject({
    evidenceStatus: "evidence_unresolved",
    citable: false,
    unresolvedRefs: [ghost],
  });

  // Step 3: the scripted agent cites a summary with no source and tries to upgrade a claim from memory.
  const auditCount = async (action: string) =>
    Number(
      (
        await w.db.admin.query("SELECT count(*) FROM audit_events WHERE workspace_id=$1 AND action=$2", [
          workspaceId,
          action,
        ])
      ).rows[0].count,
    );
  const citeOk = await w.h.summaries.cite(agent, workspaceId, S1);
  expect(citeOk.citedEvidence).toEqual([e1]);
  const citeBad = await rejection(w.h.summaries.cite(agent, workspaceId, S4));
  const citeGhost = await rejection(w.h.summaries.cite(agent, workspaceId, S5));
  expect([citeBad.reasonCode, citeGhost.reasonCode]).toEqual([
    "SUMMARY_WITHOUT_SOURCE",
    "SUMMARY_WITHOUT_SOURCE",
  ]);
  const tierBefore = (await evidenceRows()).find((r) => r.id === claim)!.data.evidenceTier;
  expect(tierBefore).toBe("exploratory");
  const upgrade = await rejection(
    w.h.summaries.setClaimTier(agent, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      nodeId: claim,
      toTier: "out_of_sample",
      basis: { kind: "memory", summaryId: S1 },
    }),
  );
  expect(upgrade.reasonCode).toBe("MEMORY_CANNOT_UPGRADE_CONFIDENCE");
  // (d) both attempts rejected and audited; the claim is unchanged.
  expect(await auditCount("summary.citation_rejected")).toBe(2);
  expect(await auditCount("claim.tier_change_rejected")).toBe(1);
  expect((await evidenceRows()).find((r) => r.id === claim)!.data.evidenceTier).toBe("exploratory");
  // The rule is not a blanket ban: evidence-based upgrades work, and need out-of-sample evidence.
  const oos = await ev("OOS result", {}, { evaluation: "out_of_sample" });
  expect(
    (
      await rejection(
        w.h.summaries.setClaimTier(w.owner, workspaceId, {
          expectedVersion: await wsVersion(w, workspaceId),
          nodeId: claim,
          toTier: "out_of_sample",
          basis: { kind: "evidence", nodeIds: [e3] },
        }),
      )
    ).reasonCode,
  ).toBe("UPGRADE_NEEDS_OUT_OF_SAMPLE_EVIDENCE");
  await w.h.summaries.setClaimTier(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    nodeId: claim,
    toTier: "out_of_sample",
    basis: { kind: "evidence", nodeIds: [oos] },
  });
  expect((await evidenceRows()).find((r) => r.id === claim)!.data.evidenceTier).toBe("out_of_sample");

  // (e) human and agent authorship is distinct on summaries.
  const kinds = Object.fromEntries(recall.map((r) => [r.summaryId, r.authorKind]));
  expect(kinds[S1]).toBe("agent");
  expect(kinds[S2]).toBe("human");
  expect(kinds[S3]).toBe("agent");

  // Negative control: a recall path that dropped the source links could not mark items citable (criterion (c)).
  const stripped = recall.map((r) => ({ ...r, sourceRefs: [] as string[] }));
  expect(stripped.filter((r) => r.citable && r.sourceRefs.length === 0).length).toBe(3);
  expect(recall.filter((r) => r.citable && r.sourceRefs.length === 0).length).toBe(0);

  observe({
    testId: "W17",
    observed: `5 summaries (agent/human authorship recorded) live outside evidence_nodes; a dex_volume 1.0.0 -> 2.0.0 change marked exactly the 1 dependent summary stale while all evidence rows and source links stayed byte-identical; recall resolved 3 summaries to live evidence and flagged the no-source and ghost-source ones evidence_unresolved/not citable; the scripted agent's 2 uncitable citations and its memory-based exploratory -> out_of_sample upgrade were refused and audited (2 + 1 audit rows) with the claim unchanged, while an evidence-based upgrade with an out-of-sample result succeeded`,
    evidence: { stale: [S1], citable: 3, unresolved: 2, audits: { citation: 2, tier: 1 } },
  });
});
