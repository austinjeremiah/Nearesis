import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import { PanelSpec } from "@nearesis/contracts";
import type { CanvasPatch } from "@nearesis/contracts";
import { KernelError, operationIdFromActionHash } from "../src/index.ts";
import type { Kernel, Session } from "../src/index.ts";
import {
  cap,
  createTestDb,
  createWs,
  execReq,
  giveLease,
  grant,
  loginSession,
  makeManifest,
  pluginUp,
  seedOrg,
  testKernel,
} from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";

let db: TestDb;
let k: Kernel;
let human: Session;
let orgId: string;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  const a = await seedOrg(db.admin, "ap", { alice: "owner" });
  orgId = a.orgId;
  human = await loginSession(k, a.users.alice!.subject);
});
afterAll(async () => db?.drop());

const runId = () => randomUUID();
const agentOf = (run: string): Session =>
  ({
    principal: { kind: "agent", actorId: randomUUID(), orgId, parentRunId: run },
    role: human.role,
    userId: human.userId,
  }) as Session;

const patchFor = (operationId: string): CanvasPatch =>
  ({
    schemaVersion: 1,
    type: "workspace.patch",
    operationId,
    expectedRevision: 0,
    operations: [
      {
        op: "addPanel",
        panel: PanelSpec.parse({
          panelId: randomUUID(),
          schemaVersion: 1,
          kind: "timeSeries",
          title: "P",
          queryRef: { hash: "c".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
          dataBinding: {
            fields: ["ts", "v"],
            units: { v: "USD" },
            timezone: "UTC",
            completeness: "complete",
          },
          encoding: { x: "ts", y: ["v"] },
          layout: { x: 0, y: 0, w: 6, h: 4 },
          refreshPolicy: { mode: "manual" },
          provenanceRequired: true,
        }),
      },
    ],
  }) as CanvasPatch;

async function ws() {
  return createWs(k, human);
}
const approve = async (workspaceId: string, run: string, hash: string, ttlMs?: number) =>
  k.db.tx({ orgId, userId: human.userId }, (tx) =>
    k.approvals.grant(tx, {
      orgId,
      workspaceId,
      runId: run,
      actionHash: hash,
      approvedBy: human.userId,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    }),
  );
const apply = (s: Session, workspaceId: string, patch: CanvasPatch, version: number) =>
  k.commands.execute(s, workspaceId, {
    apiVersion: "v1",
    commandId: randomUUID(),
    commandType: "canvas.apply_patch",
    payload: patch,
    expectedVersion: version,
  });
const reason = async (p: Promise<unknown>) => {
  const e = (await p.then(
    () => undefined,
    (x) => x,
  )) as KernelError | undefined;
  expect(e).toBeInstanceOf(KernelError);
  expect(e!.code).toBe("APPROVAL_REQUIRED");
  return e!.reasonCode;
};
const state = async (workspaceId: string) => ({
  version: (await db.admin.query("SELECT version FROM workspaces WHERE id=$1", [workspaceId])).rows[0]
    .version as number,
  panels: (
    await db.admin.query("SELECT count(*)::int n FROM panel_specs WHERE workspace_id=$1", [workspaceId])
  ).rows[0].n as number,
});
const denials = async (workspaceId: string, code: string) =>
  (
    await db.admin.query(
      "SELECT count(*)::int n FROM audit_events WHERE action='access.denied' AND reason_code=$1 AND detail->>'requestedWorkspace'=$2",
      [code, workspaceId],
    )
  ).rows[0].n as number;

describe("kernel-verified approvals for agent commands", () => {
  it("match: an approved action hash lets the agent apply the patch it is bound to, once", async () => {
    const w = await ws();
    const run = runId();
    const hash = sha256Hex("action-match");
    await approve(w.workspaceId, run, hash);
    const agent = agentOf(run);
    const patch = patchFor(operationIdFromActionHash(hash));
    const r = await apply(agent, w.workspaceId, patch, w.version);
    expect(r.workspaceVersion).toBe(w.version + 1);
    const row = (
      await db.admin.query("SELECT used_at, used_by FROM command_approvals WHERE workspace_id=$1", [
        w.workspaceId,
      ])
    ).rows[0];
    expect(row.used_at).not.toBeNull();
    expect(row.used_by).toBe(r.commandId);
    // idempotent retry of the same operation replays and does not need (or consume) another approval
    const again = await k.commands.execute(agent, w.workspaceId, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "canvas.apply_patch",
      payload: patch,
      expectedVersion: w.version,
    });
    expect(again.workspaceVersion).toBe(r.workspaceVersion);
  });

  it("exact-command hash also matches (non-canvas privileged commands)", async () => {
    const w = await ws();
    const run = runId();
    const payload = { objective: "agent says" };
    const hash = sha256Hex(canonicalJson({ t: "workspace.update_objective", p: payload }));
    const agent = agentOf(run);
    const cmd = (v: number) => ({
      apiVersion: "v1" as const,
      commandId: randomUUID(),
      commandType: "workspace.update_objective" as const,
      payload,
      expectedVersion: v,
    });
    expect(await reason(k.commands.execute(agent, w.workspaceId, cmd(w.version)))).toBe("APPROVAL_MISSING");
    await approve(w.workspaceId, run, hash);
    expect((await k.commands.execute(agent, w.workspaceId, cmd(w.version))).workspaceVersion).toBe(
      w.version + 1,
    );
  });

  it("mismatch: a different action or a patch not bound to the approval is denied, audited, with no mutation", async () => {
    const w = await ws();
    const run = runId();
    await approve(w.workspaceId, run, sha256Hex("approved-action"));
    const before = await state(w.workspaceId);
    const code = await reason(
      apply(agentOf(run), w.workspaceId, patchFor(operationIdFromActionHash(sha256Hex("other"))), w.version),
    );
    expect(code).toBe("APPROVAL_HASH_MISMATCH");
    expect(await state(w.workspaceId)).toEqual(before);
    expect(await denials(w.workspaceId, "APPROVAL_HASH_MISMATCH")).toBe(1);
    // an approval of another run does not help either
    const other = agentOf(runId());
    expect(
      await reason(
        apply(
          other,
          w.workspaceId,
          patchFor(operationIdFromActionHash(sha256Hex("approved-action"))),
          w.version,
        ),
      ),
    ).toBe("APPROVAL_MISSING");
    expect(await state(w.workspaceId)).toEqual(before);
  });

  it("expired: an elapsed approval is denied and audited", async () => {
    const w = await ws();
    const run = runId();
    const hash = sha256Hex("will-expire");
    await approve(w.workspaceId, run, hash);
    await db.admin.query(
      "UPDATE command_approvals SET expires_at = now() - interval '1 second' WHERE workspace_id=$1",
      [w.workspaceId],
    );
    const before = await state(w.workspaceId);
    expect(
      await reason(apply(agentOf(run), w.workspaceId, patchFor(operationIdFromActionHash(hash)), w.version)),
    ).toBe("APPROVAL_EXPIRED");
    expect(await state(w.workspaceId)).toEqual(before);
    expect(await denials(w.workspaceId, "APPROVAL_EXPIRED")).toBe(1);
    // re-approving an unused, expired record refreshes it
    await approve(w.workspaceId, run, hash);
    expect(
      (await apply(agentOf(run), w.workspaceId, patchFor(operationIdFromActionHash(hash)), w.version))
        .workspaceVersion,
    ).toBe(w.version + 1);
  });

  it("reused: re-approving a consumed hash does not revive it; the identical patch only replays", async () => {
    const w = await ws();
    const run = runId();
    const hash = sha256Hex("single-use");
    await approve(w.workspaceId, run, hash);
    const agent = agentOf(run);
    const patch = patchFor(operationIdFromActionHash(hash));
    const first = await apply(agent, w.workspaceId, patch, w.version);
    await approve(w.workspaceId, run, hash);
    const row = (
      await db.admin.query("SELECT used_at FROM command_approvals WHERE workspace_id=$1", [w.workspaceId])
    ).rows[0];
    expect(row.used_at).not.toBeNull();
    const before = await state(w.workspaceId);
    expect((await apply(agent, w.workspaceId, patch, first.workspaceVersion)).workspaceVersion).toBe(
      first.workspaceVersion,
    );
    expect(await state(w.workspaceId)).toEqual(before);
  });

  it("a used approval is reported as reused when a new operation presents the same bound hash", async () => {
    const w = await ws();
    const run = runId();
    const hash = sha256Hex("reuse-direct");
    await db.admin.query(
      "INSERT INTO command_approvals(id, org_id, workspace_id, run_id, action_hash, approved_by, expires_at, used_at, used_by) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '1 hour', now(), 'earlier')",
      [randomUUID(), orgId, w.workspaceId, run, hash, human.userId],
    );
    const before = await state(w.workspaceId);
    expect(
      await reason(apply(agentOf(run), w.workspaceId, patchFor(operationIdFromActionHash(hash)), w.version)),
    ).toBe("APPROVAL_REUSED");
    expect(await state(w.workspaceId)).toEqual(before);
    expect(await denials(w.workspaceId, "APPROVAL_REUSED")).toBe(1);
  });

  it("a failed command rolls the approval use back (consumed only with the mutation)", async () => {
    const w = await ws();
    const run = runId();
    const hash = sha256Hex("rollback");
    await approve(w.workspaceId, run, hash);
    const bad = patchFor(operationIdFromActionHash(hash));
    (bad as { expectedRevision: number }).expectedRevision = 99; // stale document revision
    await expect(apply(agentOf(run), w.workspaceId, bad, w.version)).rejects.toBeInstanceOf(KernelError);
    const row = (
      await db.admin.query("SELECT used_at FROM command_approvals WHERE workspace_id=$1", [w.workspaceId])
    ).rows[0];
    expect(row.used_at).toBeNull();
  });

  it("humans are unaffected, and agents cannot self-approve through another workspace's approval", async () => {
    const w = await ws();
    const r = await k.commands.execute(human, w.workspaceId, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "workspace.update_objective",
      payload: { objective: "human" },
      expectedVersion: w.version,
    });
    expect(r.workspaceVersion).toBe(w.version + 1);
    const w2 = await ws();
    const run = runId();
    const hash = sha256Hex("cross");
    await approve(w.workspaceId, run, hash);
    expect(
      await reason(
        apply(agentOf(run), w2.workspaceId, patchFor(operationIdFromActionHash(hash)), w2.version),
      ),
    ).toBe("APPROVAL_MISSING");
  });
});

describe("gateway: approvals for paid_call/chain_write and in-flight takeover", () => {
  const PID = "fx-plugin-echo";
  let workspaceId: string;
  beforeAll(async () => {
    const m = makeManifest({
      pluginId: PID,
      version: "1.0.0",
      entrypoint: "echo-1.0.0.ts",
      capabilities: [
        cap("fx_plugin_echo.say@1", { sideEffect: "paid_call", idempotent: false }),
        cap("fx_plugin_echo.slow@1", { sideEffect: "workspace_write", idempotent: false }),
        cap("fx_plugin_echo.leak@1", { sideEffect: "workspace_write", idempotent: true }),
      ],
    });
    await k.plugins.install(human.principal.actorId, m);
    await k.plugins.enable(human.principal.actorId, PID);
    const w = await ws();
    workspaceId = w.workspaceId;
    await pluginUp(k, human, workspaceId, w.version, PID);
  });
  const agentPrincipal = (run: string) =>
    ({ kind: "agent", actorId: randomUUID(), orgId, parentRunId: run }) as const;
  const call = async (capability: string, input: unknown, run: string, key = `k-${randomUUID()}`) => {
    const p = agentPrincipal(run);
    await giveLease(
      k,
      human,
      workspaceId,
      capability,
      [grant({ resource: "fx", action: "run" })],
      undefined,
    ).catch(() => undefined);
    const lease = await k.leases.issue(human, {
      workspaceId,
      holderActorId: p.actorId,
      capability,
      grants: [grant()],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    void lease;
    return k.gateway.invoke(
      p,
      execReq(human, workspaceId, capability, input, {
        actor: { kind: "agent", actorId: p.actorId, parentRunId: run },
        idempotencyKey: key,
      }) as never,
    );
  };

  it("an agent paid_call without an approval is blocked and audited; with a matching one it runs once", async () => {
    const run = runId();
    const input = { text: "pay" };
    const denied = await call("fx_plugin_echo.say@1", input, run);
    expect(denied).toMatchObject({ state: "blocked", reasonCode: "APPROVAL_REQUIRED" });
    const aud = await db.admin.query(
      "SELECT count(*)::int n FROM audit_events WHERE action='tool.invoke.denied' AND reason_code='APPROVAL_MISSING' AND workspace_id=$1",
      [workspaceId],
    );
    expect(aud.rows[0].n).toBeGreaterThanOrEqual(1);
    const hash = sha256Hex(canonicalJson({ capability: "fx_plugin_echo.say@1", input }));
    // an approval for different input does not authorise this call
    await approve(
      workspaceId,
      run,
      sha256Hex(canonicalJson({ capability: "fx_plugin_echo.say@1", input: { text: "other" } })),
    );
    expect(await call("fx_plugin_echo.say@1", input, run)).toMatchObject({
      state: "blocked",
      reasonCode: "APPROVAL_REQUIRED",
    });
    await approve(workspaceId, run, hash);
    expect(await call("fx_plugin_echo.say@1", input, run)).toMatchObject({ state: "ok" });
    // consumed: the same call again (new idempotency key) is blocked
    expect(await call("fx_plugin_echo.say@1", input, run)).toMatchObject({
      state: "blocked",
      reasonCode: "APPROVAL_REQUIRED",
    });
  });

  const seedRunning = async (capability: string, key: string, deadline: string) =>
    db.admin.query(
      `INSERT INTO tool_invocations(id, org_id, workspace_id, request_id, idempotency_key, actor_id, capability, state, deadline_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'running', ${deadline})`,
      [randomUUID(), orgId, workspaceId, randomUUID(), key, human.principal.actorId, capability],
    );

  it("a running invocation inside its deadline is still DUPLICATE_IN_FLIGHT", async () => {
    await seedRunning("fx_plugin_echo.leak@1", "inflight-live-1", "now() + interval '1 minute'");
    const r = await call("fx_plugin_echo.leak@1", {}, runId(), "inflight-live-1");
    expect(r).toMatchObject({ state: "blocked", reasonCode: "DUPLICATE_IN_FLIGHT" });
  });

  it("after the deadline an idempotent capability is taken over and re-executed with one CAS", async () => {
    await seedRunning("fx_plugin_echo.leak@1", "inflight-idem-1", "now() - interval '1 second'");
    const r = await call("fx_plugin_echo.leak@1", {}, runId(), "inflight-idem-1");
    expect(r.state).toBe("ok");
    const row = (
      await db.admin.query(
        "SELECT state, takeover_count FROM tool_invocations WHERE idempotency_key='inflight-idem-1'",
      )
    ).rows;
    expect(row).toEqual([{ state: "ok", takeover_count: 1 }]);
    // and a further replay returns the stored result
    expect((await call("fx_plugin_echo.leak@1", {}, runId(), "inflight-idem-1")).state).toBe("ok");
  });

  it("after the deadline a non-idempotent capability fails IN_FLIGHT_ABANDONED and is not re-executed", async () => {
    await seedRunning("fx_plugin_echo.slow@1", "inflight-abandon-1", "now() - interval '1 second'");
    const calls = () =>
      (globalThis as unknown as { __nearesisFx?: { calls: Record<string, number> } }).__nearesisFx?.calls[
        "fx-plugin-echo@1.0.0"
      ] ?? 0;
    const before = calls();
    const r = await call("fx_plugin_echo.slow@1", {}, runId(), "inflight-abandon-1");
    expect(r).toMatchObject({ state: "failed", reasonCode: "IN_FLIGHT_ABANDONED" });
    expect(calls()).toBe(before);
    const row = (
      await db.admin.query(
        "SELECT state, reason_code, takeover_count FROM tool_invocations WHERE idempotency_key='inflight-abandon-1'",
      )
    ).rows[0];
    expect(row).toEqual({ state: "failed", reason_code: "IN_FLIGHT_ABANDONED", takeover_count: 0 });
    expect((await call("fx_plugin_echo.slow@1", {}, runId(), "inflight-abandon-1")).reasonCode).toBe(
      "IN_FLIGHT_ABANDONED",
    );
  });

  it("concurrent takeovers of an expired idempotent invocation execute at most once", async () => {
    await seedRunning("fx_plugin_echo.leak@1", "inflight-race-1", "now() - interval '1 second'");
    const rs = await Promise.all(
      [1, 2, 3].map(() => call("fx_plugin_echo.leak@1", {}, runId(), "inflight-race-1")),
    );
    expect(rs.filter((r) => r.state === "ok").length).toBeGreaterThanOrEqual(1);
    const row = (
      await db.admin.query(
        "SELECT takeover_count FROM tool_invocations WHERE idempotency_key='inflight-race-1'",
      )
    ).rows[0];
    expect(row.takeover_count).toBe(1);
  });
});
