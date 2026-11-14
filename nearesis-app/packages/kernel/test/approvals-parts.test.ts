import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@nearesis/plugin-sdk";
import { PanelSpec } from "@nearesis/contracts";
import type { CanvasPatch } from "@nearesis/contracts";
import { KernelError, partOperationId } from "../src/index.ts";
import type { Kernel, Session } from "../src/index.ts";
import { createTestDb, createWs, loginSession, seedOrg, testKernel } from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";

/** One approved action split into single-use derived approvals (progressive composition): exactly-once still holds. */
let db: TestDb;
let k: Kernel;
let human: Session;
let orgId: string;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  const a = await seedOrg(db.admin, "parts", { alice: "owner" });
  orgId = a.orgId;
  human = await loginSession(k, a.users.alice!.subject);
});
afterAll(async () => db?.drop());

const agentOf = (run: string): Session =>
  ({
    principal: { kind: "agent", actorId: randomUUID(), orgId, parentRunId: run },
    role: human.role,
    userId: human.userId,
  }) as Session;
const panel = (i: number) => ({
  op: "addPanel" as const,
  panel: PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: `P${i}`,
    queryRef: { hash: "c".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["ts", "v"], units: { v: "USD" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "ts", y: ["v"] },
    layout: { x: (i % 2) * 6, y: Math.floor(i / 2) * 4, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
  }),
});
const part = (operationId: string, revision: number, i: number): CanvasPatch =>
  ({
    schemaVersion: 1,
    type: "workspace.patch",
    operationId,
    expectedRevision: revision,
    operations: [panel(i)],
  }) as CanvasPatch;
const run = async (s: Session, workspaceId: string, patch: CanvasPatch) => {
  const ws = await k.workspaces.get(s, workspaceId);
  return k.commands.execute(s, workspaceId, {
    apiVersion: "v1",
    commandId: randomUUID(),
    commandType: "canvas.apply_patch",
    payload: patch,
    expectedVersion: ws.version,
  });
};
const approve = (workspaceId: string, runId: string, hash: string) =>
  k.db.tx({ orgId, userId: human.userId }, (tx) =>
    k.approvals.grant(tx, { orgId, workspaceId, runId, actionHash: hash, approvedBy: human.userId }),
  );
const delegate = (s: Session, workspaceId: string, runId: string, hash: string, parts: number) =>
  k.db.tx({ orgId, userId: s.userId, actorKind: "agent" }, (tx) =>
    k.approvals.delegateParts(tx, { workspaceId, runId, actionHash: hash, parts, usedBy: runId }),
  );
const code = async (p: Promise<unknown>) =>
  (
    (await p.then(
      () => undefined,
      (e) => e,
    )) as KernelError | undefined
  )?.reasonCode;

describe("delegateParts", () => {
  it("one approval authorises exactly its parts, each once; a retried delegation is idempotent", async () => {
    const w = await createWs(k, human);
    const runId = randomUUID();
    const hash = sha256Hex("progressive-1");
    await approve(w.workspaceId, runId, hash);
    const agent = agentOf(runId);
    const ids = await delegate(agent, w.workspaceId, runId, hash, 3);
    expect(ids).toEqual([0, 1, 2].map((i) => partOperationId(hash, i)));
    expect(await delegate(agent, w.workspaceId, runId, hash, 3)).toEqual(ids); // resume: no second consumption
    // each part applies once, in order, as its own command
    for (let i = 0; i < 3; i++) {
      const doc = await k.canvas.get(agent, w.workspaceId);
      await run(agent, w.workspaceId, part(ids[i]!, doc.documentRevision, i));
    }
    expect((await k.canvas.get(agent, w.workspaceId)).panels).toHaveLength(3);
    // a fourth command, or a replay of part 0 with a fresh command id and new content, has no approval left
    const doc = await k.canvas.get(agent, w.workspaceId);
    expect(await code(run(agent, w.workspaceId, part(randomUUID(), doc.documentRevision, 9)))).toBe(
      "APPROVAL_HASH_MISMATCH",
    );
    const used = (
      await db.admin.query(
        "SELECT count(*)::int n FROM command_approvals WHERE workspace_id=$1 AND used_at IS NOT NULL",
        [w.workspaceId],
      )
    ).rows[0].n as number;
    expect(used).toBe(4); // the parent and its three parts
  });

  it("no approval, a wrong hash, a revoked, an already used or an other run's approval yields no parts", async () => {
    const w = await createWs(k, human);
    const runId = randomUUID();
    const hash = sha256Hex("progressive-2");
    const agent = agentOf(runId);
    expect(await code(delegate(agent, w.workspaceId, runId, hash, 2))).toBe("APPROVAL_MISSING");
    await approve(w.workspaceId, runId, sha256Hex("something else"));
    expect(await code(delegate(agent, w.workspaceId, runId, hash, 2))).toBe("APPROVAL_HASH_MISMATCH");
    await approve(w.workspaceId, runId, hash);
    const other = randomUUID();
    expect(await code(delegate(agentOf(other), w.workspaceId, other, hash, 2))).toBe("APPROVAL_MISSING");
    await k.db.tx({ orgId, userId: human.userId }, (tx) =>
      k.approvals.revoke(tx, { workspaceId: w.workspaceId, runId, actionHash: hash }),
    );
    expect(await code(delegate(agent, w.workspaceId, runId, hash, 2))).toBe("APPROVAL_REVOKED");
  });

  it("revoking the run after delegation stops the parts that have not run yet; a part's operation id cannot be forged", async () => {
    const w = await createWs(k, human);
    const runId = randomUUID();
    const hash = sha256Hex("progressive-3");
    await approve(w.workspaceId, runId, hash);
    const agent = agentOf(runId);
    const ids = await delegate(agent, w.workspaceId, runId, hash, 2);
    const doc = await k.canvas.get(agent, w.workspaceId);
    await run(agent, w.workspaceId, part(ids[0]!, doc.documentRevision, 0));
    await k.db.tx({ orgId, userId: human.userId }, (tx) =>
      k.approvals.revoke(tx, { workspaceId: w.workspaceId, runId }),
    );
    const d2 = await k.canvas.get(agent, w.workspaceId);
    expect(await code(run(agent, w.workspaceId, part(ids[1]!, d2.documentRevision, 1)))).toBe(
      "APPROVAL_REVOKED",
    );
    expect(
      await code(run(agent, w.workspaceId, part(partOperationId(hash, 7), d2.documentRevision, 2))),
    ).toBe("APPROVAL_HASH_MISMATCH");
    expect((await k.canvas.get(agent, w.workspaceId)).panels).toHaveLength(1);
  });
});
