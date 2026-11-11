import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import type { Session } from "../../src/index.ts";
import { addNode, newWs, rejection, snapshot, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w14")));
afterAll(async () => w?.db.drop());

const nodeVal = (label: string, data: Record<string, unknown>) => ({
  kind: "claim",
  label,
  data,
  semanticPins: {},
  tombstone: false,
});

it("W14: a merge proposal records what changes and why and appends only items that pass policy", async () => {
  const { workspaceId } = await newWs(w);
  const C1 = await addNode(w, workspaceId, "claim", "Certified verdict claim", {
    data: { verdict: "open", certified: true },
  });
  const C2 = await addNode(w, workspaceId, "claim", "Contested claim", { data: { verdict: "open" } });
  await w.h.graphOps.changeSemanticVersion(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    metricId: "m1",
    toVersion: "1.4.0",
  });
  const S = await snapshot(w, workspaceId, "base");
  const br = await w.h.branches.create(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    fromSnapshotId: S.snapshotId,
    name: "analysis",
  });
  const branchId = br.result.branchId as string;
  const newA = randomUUID();
  const newB = randomUUID();
  await w.h.branches.change(w.owner, workspaceId, branchId, {
    expectedVersion: await wsVersion(w, workspaceId),
    ops: [
      {
        op: "set",
        objectId: `node:${newA}`,
        value: { ...nodeVal("Clean evidence A", {}), kind: "observation" },
      },
      {
        op: "set",
        objectId: `node:${newB}`,
        value: { ...nodeVal("Clean evidence B", {}), kind: "observation" },
      },
      { op: "set", objectId: "metric:m1", value: { version: "2.0.0" } },
      {
        op: "set",
        objectId: `node:${C1}`,
        value: nodeVal("Certified verdict claim", { verdict: "supported", certified: true }),
      },
      {
        op: "set",
        objectId: `node:${C2}`,
        value: nodeVal("Contested claim (branch reading)", { verdict: "open", reading: "branch" }),
      },
    ],
  });
  // The parent changes the contested claim differently after the fork: a true conflict.
  await w.h.graphOps.updateNodeData(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    nodeId: C2,
    data: { reading: "parent" },
  });

  // Steps 1-2: create the proposal and read its content.
  const created = await w.h.branches.proposeMerge(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    sourceBranchId: branchId,
  });
  const pid = created.result.proposalId as string;
  const prop = await w.h.branches.getProposal(w.owner, workspaceId, pid);
  // (a) the proposal lists changed object IDs, upstream revisions, hash differences, conflicts and approvals.
  expect(prop.changes.map((c) => c.objectId).sort()).toEqual(
    [`node:${newA}`, `node:${newB}`, `node:${C1}`].sort(),
  );
  expect(prop.conflicts.map((c) => c.objectId)).toEqual([`node:${C2}`]);
  expect((prop.evidenceHashDiffs as Array<{ objectId: string }>).map((d) => d.objectId).sort()).toEqual(
    [`node:${newA}`, `node:${newB}`, `node:${C1}`, `node:${C2}`, "metric:m1"].sort(),
  );
  for (const d of prop.evidenceHashDiffs as Array<{ before: string; after: string }>)
    expect(d.before).not.toBe(d.after);
  expect(prop.upstreamRevisions).toMatchObject({
    targetOverlayRevision: expect.any(Number),
    targetEventSeq: expect.any(Number),
  });
  expect(prop.requiredApprovals).toEqual(
    expect.arrayContaining([
      "human_acceptance",
      "verdict_change_acknowledgement",
      "certified_verdict_approval",
      "conflict_review",
    ]),
  );
  // (b) the semver-incompatible item is excluded with a reason; nothing else is excluded.
  expect(prop.excluded.length).toBe(1);
  expect(prop.excluded[0]).toMatchObject({
    objectId: "metric:m1",
    reasonCode: "SEMVER_INCOMPATIBLE",
    from: "1.4.0",
    to: "2.0.0",
  });
  expect(prop.excluded[0]!.reason).toMatch(/major version/);

  const parentState = async () =>
    (
      await w.db.admin.query("SELECT id, label, data FROM evidence_nodes WHERE workspace_id=$1 ORDER BY id", [
        workspaceId,
      ])
    ).rows;
  const before = await parentState();
  const accept = async (s: Session, ack = true) =>
    w.h.branches.acceptMerge(s, workspaceId, pid, {
      expectedVersion: await wsVersion(w, workspaceId),
      acknowledgeVerdictChange: ack,
    });

  // Step 3 / (c): acceptance without approval authority is refused (403-class), as is a non-human, a viewer, and
  // acceptance that skips conflict review or the verdict acknowledgement. Nothing is applied by any refusal.
  const analystTry = await rejection(accept(w.analyst));
  expect([analystTry.code, analystTry.reasonCode]).toEqual(["FORBIDDEN", "APPROVAL_AUTHORITY_REQUIRED"]);
  const viewerTry = await rejection(accept(w.viewer));
  expect(viewerTry.code).toBe("FORBIDDEN");
  const agent: Session = {
    ...w.owner,
    principal: { kind: "agent", actorId: randomUUID(), orgId: w.orgA.orgId, parentRunId: randomUUID() },
  };
  expect((await rejection(accept(agent))).reasonCode).toBe("HUMAN_ACCEPTANCE_REQUIRED");
  expect((await rejection(accept(w.owner))).reasonCode).toBe("MERGE_CONFLICTS_UNRESOLVED");
  expect(await parentState()).toEqual(before);
  await w.h.branches.resolveConflict(w.owner, workspaceId, pid, {
    expectedVersion: await wsVersion(w, workspaceId),
    objectId: `node:${C2}`,
    resolution: "keep_both",
  });
  expect((await rejection(accept(w.owner, false))).reasonCode).toBe("VERDICT_CHANGE_NEEDS_ACK");
  expect(await parentState()).toEqual(before);
  const c1Before = before.find((r) => r.id === C1)!;
  expect(c1Before.data.verdict).toBe("open"); // the certified verdict was not auto-applied

  // With authority: accepted once, parent revision increments exactly once.
  const v0 = await wsVersion(w, workspaceId);
  const ok = await accept(w.owner, true);
  expect(ok.workspaceVersion).toBe(v0 + 1);
  expect(await wsVersion(w, workspaceId)).toBe(v0 + 1);
  const accepted = await w.h.branches.getProposal(w.owner, workspaceId, pid);
  expect(accepted.status).toBe("accepted");

  // Step 4 / (b),(d): clean items appended, the incompatible metric is not, both conflicting claims side by side.
  const after = await parentState();
  expect(after.find((r) => r.id === newA)?.label).toBe("Clean evidence A");
  expect(after.find((r) => r.id === newB)?.label).toBe("Clean evidence B");
  const sem = (
    await w.db.admin.query(
      "SELECT version FROM semantic_versions WHERE workspace_id=$1 AND metric_id='m1' ORDER BY seq DESC LIMIT 1",
      [workspaceId],
    )
  ).rows[0];
  expect(sem.version).toBe("1.4.0"); // 2.0.0 was excluded, not appended
  expect(after.find((r) => r.id === C1)!.data.verdict).toBe("supported"); // applied only after authorised acceptance
  const original = after.find((r) => r.id === C2)!;
  expect(original.label).toBe("Contested claim"); // not overwritten
  expect(original.data.reading).toBe("parent");
  const sideBySide = after.filter((r) => r.data.preservesConflictWith === `node:${C2}`);
  expect(sideBySide.length).toBe(1);
  expect(sideBySide[0]!.data.reading).toBe("branch");
  expect(sideBySide[0]!.data.mergedFromBranch).toBe(branchId);
  expect(after.length).toBe(before.length + 3); // newA, newB and the preserved branch reading

  // Negative control: auto-accepting the certified verdict (no authority, no acknowledgement) was refused above, and
  // the stored requirement is what enforces it.
  expect(prop.requiredApprovals).toContain("certified_verdict_approval");

  observe({
    testId: "W14",
    observed: `proposal listed 3 clean changes, 1 conflict, 5 hash diffs, upstream revisions and 4 required approvals; the major-version metric change m1 1.4.0 -> 2.0.0 was excluded with reason SEMVER_INCOMPATIBLE and the 2 clean items were appended; analyst acceptance returned FORBIDDEN/APPROVAL_AUTHORITY_REQUIRED, agent HUMAN_ACCEPTANCE_REQUIRED, unresolved conflict and missing acknowledgement blocked with the parent byte-identical each time; after owner acceptance the certified verdict applied, the contested claim kept its parent reading and the branch reading sits beside it with lineage, parent workspace version rose by exactly 1 (${v0} -> ${v0 + 1})`,
    evidence: {
      excluded: prop.excluded,
      required: prop.requiredApprovals,
      nodesBefore: before.length,
      nodesAfter: after.length,
    },
  });
}, 60_000);
