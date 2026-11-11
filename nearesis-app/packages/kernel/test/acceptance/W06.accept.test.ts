import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { addNode, newWs, rejection, snapshot, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w06")));
afterAll(async () => w?.db.drop());

const claimValue = (label: string, verdict: string) => ({
  kind: "claim",
  label,
  data: { verdict },
  semanticPins: {},
  tombstone: false,
});

it("W06: a conflicted branch merge requires conflict review and never silently overwrites", async () => {
  const { workspaceId } = await newWs(w);
  const claim = await addNode(w, workspaceId, "claim", "Intents volume is rising", {
    data: { verdict: "open" },
  });
  const snap = await snapshot(w, workspaceId, "base");
  const mk = async (name: string, label: string, verdict: string) => {
    const b = await w.h.branches.create(w.owner, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      fromSnapshotId: snap.snapshotId,
      name,
    });
    const branchId = b.result.branchId as string;
    await w.h.branches.change(w.owner, workspaceId, branchId, {
      expectedVersion: await wsVersion(w, workspaceId),
      ops: [{ op: "set", objectId: `node:${claim}`, value: claimValue(label, verdict) }],
    });
    return branchId;
  };
  const A = await mk("analysis-a", "Rising (A)", "supported");
  const B = await mk("analysis-b", "Rising (B)", "refuted");
  const propose = async (src: string) =>
    (
      await w.h.branches.proposeMerge(w.owner, workspaceId, {
        expectedVersion: await wsVersion(w, workspaceId),
        sourceBranchId: src,
      })
    ).result.proposalId as string;
  const accept = async (pid: string, ack = false, s = w.owner) =>
    w.h.branches.acceptMerge(s, workspaceId, pid, {
      expectedVersion: await wsVersion(w, workspaceId),
      acknowledgeVerdictChange: ack,
    });
  const live = async () =>
    (await w.db.admin.query("SELECT label, data FROM evidence_nodes WHERE id=$1", [claim])).rows[0] as {
      label: string;
      data: { verdict: string };
    };

  // B merges first; it changes a claim verdict, so it needs explicit acknowledgement and a human.
  const pB = await propose(B);
  const propB = await w.h.branches.getProposal(w.owner, workspaceId, pB);
  expect(propB.conflicts).toEqual([]);
  expect(propB.requiredApprovals).toContain("verdict_change_acknowledgement");
  expect((await rejection(accept(pB, false))).reasonCode).toBe("VERDICT_CHANGE_NEEDS_ACK");
  expect((await rejection(accept(pB, true, w.viewer))).reasonCode).toBe("INSUFFICIENT_ROLE");
  await accept(pB, true);
  expect((await live()).label).toBe("Rising (B)");

  // A now conflicts: main changed the same claim differently since the common base.
  const pA = await propose(A);
  const propA = await w.h.branches.getProposal(w.owner, workspaceId, pA);
  expect(propA.conflicts.length).toBe(1);
  expect(propA.conflicts[0]!.resolution).toBe("unresolved");
  expect(propA.requiredApprovals).toContain("conflict_review");
  expect(propA.evidenceHashDiffs.length).toBe(1);
  const blocked = await rejection(accept(pA, true));
  expect(blocked.reasonCode).toBe("MERGE_CONFLICTS_UNRESOLVED");
  const afterBlocked = await live();
  expect(afterBlocked.label).toBe("Rising (B)"); // no silent overwrite
  expect(afterBlocked.data.verdict).toBe("refuted");

  // Conflict review: preserve both claims side by side.
  expect(
    (
      await rejection(
        w.h.branches.resolveConflict(w.viewer, workspaceId, pA, {
          expectedVersion: await wsVersion(w, workspaceId),
          objectId: `node:${claim}`,
          resolution: "keep_both",
        }),
      )
    ).reasonCode,
  ).toBe("INSUFFICIENT_ROLE");
  await w.h.branches.resolveConflict(w.owner, workspaceId, pA, {
    expectedVersion: await wsVersion(w, workspaceId),
    objectId: `node:${claim}`,
    resolution: "keep_both",
  });
  await accept(pA, true);
  const rows = (
    await w.db.admin.query(
      "SELECT id, label, data FROM evidence_nodes WHERE workspace_id=$1 AND kind='claim' ORDER BY label",
      [workspaceId],
    )
  ).rows as Array<{ id: string; label: string; data: Record<string, unknown> }>;
  expect(rows.map((r) => r.label).sort()).toEqual(["Rising (A) [analysis-a]", "Rising (B)"].sort());
  const kept = rows.find((r) => r.id !== claim)!;
  expect(kept.data.preservesConflictWith).toBe(`node:${claim}`);
  expect((await live()).data.verdict).toBe("refuted");

  // Closed proposals and stale ones cannot be replayed; the merged source branch is closed to further merges.
  expect((await rejection(accept(pA, true))).reasonCode).toBe("PROPOSAL_CLOSED");
  const tl = await w.h.snapshots.timeline(w.owner, workspaceId);
  expect(tl.filter((t) => t.type === "merge.accepted").length).toBe(2);

  observe({
    testId: "W06",
    observed: `two branches changed the same claim; first merge (verdict change) needed acknowledgement + writer role; second merge produced 1 unresolved conflict, accept blocked (MERGE_CONFLICTS_UNRESOLVED) and the live claim stayed "Rising (B)"/refuted; after explicit keep_both review both claims exist side by side (preservesConflictWith set) and the original verdict is unchanged; both merges appear in the timeline`,
    evidence: { conflicts: 1, blockedReason: blocked.reasonCode, claimsAfter: rows.length },
  });
}, 60_000);
