import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addEdge, addNode, newWs, rejection, snapshot, world, wsVersion } from "./helpers.ts";
import type { World } from "./helpers.ts";
import { hashOf } from "../../src/history/snapshots.ts";
import { idFor } from "../../src/history/runner.ts";

let w: World;
beforeAll(async () => (w = await world("hx")));
afterAll(async () => w?.db.drop());

describe("command discipline", () => {
  it("idempotent replay returns the same ids and does not re-apply; stale versions are 409", async () => {
    const { workspaceId, version } = await newWs(w);
    const commandId = randomUUID();
    const body = { commandId, expectedVersion: version, kind: "claim", label: "c" };
    const a = await w.h.graphOps.addNode(w.owner, workspaceId, body);
    const b = await w.h.graphOps.addNode(w.owner, workspaceId, body);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.result).toEqual(a.result);
    expect(b.eventSeq).toBe(a.eventSeq);
    const n = (
      await w.db.admin.query("SELECT count(*)::int AS n FROM evidence_nodes WHERE workspace_id=$1", [
        workspaceId,
      ])
    ).rows[0].n;
    expect(n).toBe(1);
    const stale = await rejection(
      w.h.graphOps.addNode(w.owner, workspaceId, { expectedVersion: version, kind: "claim", label: "d" }),
    );
    expect(stale.code).toBe("STALE_VERSION");
    const reuse = await rejection(
      w.h.graphOps.addNode(w.owner, workspaceId, { ...body, label: "different" }),
    );
    expect(reuse.reasonCode).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("each command appends an event and an outbox row in the same transaction", async () => {
    const { workspaceId } = await newWs(w);
    const before = (
      await w.db.admin.query("SELECT count(*)::int AS n FROM outbox WHERE workspace_id=$1", [workspaceId])
    ).rows[0].n;
    await addNode(w, workspaceId, "observation", "o");
    const after = (
      await w.db.admin.query("SELECT count(*)::int AS n FROM outbox WHERE workspace_id=$1", [workspaceId])
    ).rows[0].n;
    expect(after).toBe(before + 1);
  });

  it("deterministic ids", () => {
    const c = randomUUID();
    expect(idFor(c, "x")).toBe(idFor(c, "x"));
    expect(idFor(c, "x")).not.toBe(idFor(c, "y"));
    expect(idFor(c, "x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("a foreign workspace is denied identically to an unknown one for every history command", async () => {
    const { workspaceId } = await newWs(w);
    const foreign = await rejection(
      w.h.snapshots.create(w.outsider, workspaceId, { expectedVersion: 1, label: "x" }),
    );
    const unknown = await rejection(
      w.h.snapshots.create(w.outsider, randomUUID(), { expectedVersion: 1, label: "x" }),
    );
    expect([foreign.code, foreign.reasonCode, foreign.message]).toEqual([
      unknown.code,
      unknown.reasonCode,
      unknown.message,
    ]);
    expect((await rejection(w.h.snapshots.list(w.outsider, workspaceId))).code).toBe("FORBIDDEN");
    expect((await rejection(w.h.branches.list(w.outsider, workspaceId))).code).toBe("FORBIDDEN");
  });
});

describe("evidence graph typing", () => {
  it("the new node kinds appear in the projection and unsupported claims are flagged", async () => {
    const { workspaceId } = await newWs(w);
    const claim = await addNode(w, workspaceId, "claim", "unsupported");
    const art = await addNode(w, workspaceId, "verification_artifact", "attestation");
    const res = await addNode(w, workspaceId, "statistical_result", "r");
    const g = await w.k.graph.get(w.owner, workspaceId);
    expect(new Set(g.nodes.map((n) => n.type))).toEqual(
      new Set(["claim", "verification_artifact", "statistical_result"]),
    );
    expect(g.nodes.find((n) => n.id === claim)!.support).toBe("unsupported");
    await addEdge(w, workspaceId, art, claim, "supports");
    await addEdge(w, workspaceId, res, claim, "contradicts");
    const g2 = await w.k.graph.get(w.owner, workspaceId);
    // verification artifacts are evidence-bearing; a supporting artifact makes the claim supported
    expect(g2.nodes.find((n) => n.id === claim)!.support).toBe("supported");
    expect(g2.nodes.find((n) => n.id === res)!.support).toBeUndefined();
  });

  it("rejects relations outside the Bible's enum and unknown kinds", async () => {
    const { workspaceId } = await newWs(w);
    const a = await addNode(w, workspaceId, "claim", "a");
    const b = await addNode(w, workspaceId, "observation", "b");
    expect((await rejection(addEdge(w, workspaceId, a, b, "causes"))).code).toBe("VALIDATION_FAILED");
    expect(
      (
        await rejection(
          w.h.graphOps.addNode(w.owner, workspaceId, {
            expectedVersion: await wsVersion(w, workspaceId),
            kind: "banana",
            label: "x",
          }),
        )
      ).code,
    ).toBe("VALIDATION_FAILED");
  });
});

describe("time machine", () => {
  it("identical state hashes identically; snapshots are per-workspace", async () => {
    const { workspaceId } = await newWs(w);
    await addNode(w, workspaceId, "claim", "c");
    const s1 = await snapshot(w, workspaceId, "one");
    const s2 = await snapshot(w, workspaceId, "two");
    expect(s1.contentHash).toBe(s2.contentHash);
    const other = await newWs(w);
    expect((await rejection(w.h.snapshots.view(w.owner, other.workspaceId, s1.snapshotId, "all"))).code).toBe(
      "FORBIDDEN",
    );
    const cmp = await w.h.snapshots.compare(w.owner, workspaceId, s1.snapshotId, s2.snapshotId);
    expect(cmp.changes).toEqual([]);
  });

  it("branch overlays that equal the base collapse; merging into another branch composes overlays", async () => {
    const { workspaceId } = await newWs(w);
    const claim = await addNode(w, workspaceId, "claim", "c", { data: { verdict: "open" } });
    const snap = await snapshot(w, workspaceId, "base");
    const mkBranch = async (name: string) =>
      (
        await w.h.branches.create(w.owner, workspaceId, {
          expectedVersion: await wsVersion(w, workspaceId),
          fromSnapshotId: snap.snapshotId,
          name,
        })
      ).result.branchId as string;
    const a = await mkBranch("a");
    const t = await mkBranch("target");
    const base = await w.h.snapshots.view(w.owner, workspaceId, snap.snapshotId, "all");
    const original = (base as { objects: Record<string, unknown> }).objects[`node:${claim}`];
    await w.h.branches.change(w.owner, workspaceId, a, {
      expectedVersion: await wsVersion(w, workspaceId),
      ops: [{ op: "set", objectId: `node:${claim}`, value: { ...(original as object), label: "edited" } }],
    });
    await w.h.branches.change(w.owner, workspaceId, a, {
      expectedVersion: await wsVersion(w, workspaceId),
      ops: [{ op: "set", objectId: `node:${claim}`, value: original }],
    });
    expect((await w.h.branches.view(w.owner, workspaceId, a)).diff).toEqual([]);
    await w.h.branches.change(w.owner, workspaceId, a, {
      expectedVersion: await wsVersion(w, workspaceId),
      ops: [{ op: "set", objectId: "metric:m1", value: { version: "9.0.0" } }],
    });
    const p = await w.h.branches.proposeMerge(w.owner, workspaceId, {
      expectedVersion: await wsVersion(w, workspaceId),
      sourceBranchId: a,
      targetBranchId: t,
    });
    const prop = await w.h.branches.getProposal(w.owner, workspaceId, p.result.proposalId as string);
    expect(prop.conflicts).toEqual([]);
    expect(prop.changes.map((c) => c.objectId)).toEqual(["metric:m1"]);
    await w.h.branches.acceptMerge(w.owner, workspaceId, prop.id, {
      expectedVersion: await wsVersion(w, workspaceId),
    });
    const tv = await w.h.branches.view(w.owner, workspaceId, t);
    expect(hashOf(tv.objects["metric:m1"])).toBe(hashOf({ version: "9.0.0" }));
    // the merged-into branch changed; main did not
    const sv = (
      await w.db.admin.query("SELECT count(*)::int AS n FROM semantic_versions WHERE workspace_id=$1", [
        workspaceId,
      ])
    ).rows[0].n;
    expect(sv).toBe(0);
    // a source branch that has been merged cannot be merged again
    expect(
      (
        await rejection(
          w.h.branches.proposeMerge(w.owner, workspaceId, {
            expectedVersion: await wsVersion(w, workspaceId),
            sourceBranchId: a,
            targetBranchId: t,
          }),
        )
      ).reasonCode,
    ).toBe("BRANCH_NOT_ACTIVE");
  });

  it("a merge into main applies metric changes through impact analysis and reports deferred panel changes", async () => {
    const { workspaceId } = await newWs(w);
    const res = await addNode(w, workspaceId, "statistical_result", "r", { semanticPins: { m: "1.0.0" } });
    const snap = await snapshot(w, workspaceId, "base");
    const b = (
      await w.h.branches.create(w.owner, workspaceId, {
        expectedVersion: await wsVersion(w, workspaceId),
        fromSnapshotId: snap.snapshotId,
        name: "m2",
      })
    ).result.branchId as string;
    await w.h.branches.change(w.owner, workspaceId, b, {
      expectedVersion: await wsVersion(w, workspaceId),
      ops: [{ op: "set", objectId: "metric:m", value: { version: "2.0.0" } }],
    });
    const p = (
      await w.h.branches.proposeMerge(w.owner, workspaceId, {
        expectedVersion: await wsVersion(w, workspaceId),
        sourceBranchId: b,
      })
    ).result.proposalId as string;
    const acc = await w.h.branches.acceptMerge(w.owner, workspaceId, p, {
      expectedVersion: await wsVersion(w, workspaceId),
    });
    expect(acc.result.applied).toBe(1);
    const flags = await w.h.recheckFlags(w.owner, workspaceId);
    expect(flags.map((f: { nodeId: string }) => f.nodeId)).toEqual([res]);
  });

  it("a proposal goes stale when the target moves after it was created", async () => {
    const { workspaceId } = await newWs(w);
    const claim = await addNode(w, workspaceId, "claim", "c");
    const snap = await snapshot(w, workspaceId, "base");
    const b = (
      await w.h.branches.create(w.owner, workspaceId, {
        expectedVersion: await wsVersion(w, workspaceId),
        fromSnapshotId: snap.snapshotId,
        name: "s",
      })
    ).result.branchId as string;
    await w.h.branches.change(w.owner, workspaceId, b, {
      expectedVersion: await wsVersion(w, workspaceId),
      ops: [
        {
          op: "set",
          objectId: `node:${claim}`,
          value: { kind: "claim", label: "branch edit", data: {}, semanticPins: {}, tombstone: false },
        },
      ],
    });
    const p = (
      await w.h.branches.proposeMerge(w.owner, workspaceId, {
        expectedVersion: await wsVersion(w, workspaceId),
        sourceBranchId: b,
      })
    ).result.proposalId as string;
    await w.db.admin.query("UPDATE evidence_nodes SET label = 'main moved' WHERE id = $1", [claim]);
    const e = await rejection(
      w.h.branches.acceptMerge(w.owner, workspaceId, p, { expectedVersion: await wsVersion(w, workspaceId) }),
    );
    expect(e.reasonCode).toBe("MERGE_PROPOSAL_STALE");
    await w.h.branches.rejectMerge(w.owner, workspaceId, p, {
      expectedVersion: await wsVersion(w, workspaceId),
    });
    expect((await w.h.branches.getProposal(w.owner, workspaceId, p)).status).toBe("rejected");
  });
});
