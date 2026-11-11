/**
 * SEC20: revocation. PASS: a revoked session is refused within 5 s (frozen bound), a revoked lease and approval
 * immediately; logs carry no secret. Executed: criteria (a) and (d). Criteria (b) credential rotation without restart and
 * (c) bounded retries with a degraded source need a provider client with an auth circuit breaker, which the ingestion
 * HTTP client does not have; they are recorded as BLOCKED_DEPENDENCY with the exact gap rather than asserted vacuously.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { buildApp } from "../../apps/api/src/app.ts";
import { createTestDb, seedOrg, testKernel } from "../../packages/kernel/test/helpers/index.ts";
import type { TestDb } from "../../packages/kernel/test/helpers/index.ts";
import { HOSTILE_CAP, rig } from "./_plugin-harness.ts";
import type { Rig } from "./_plugin-harness.ts";

const SESSION_BOUND_MS = 5000;
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db?.drop());

it("SEC20: a revoked session, lease and approval stop working at once; provider-credential criteria are blocked", async () => {
  const k = testKernel(db);
  const app = await buildApp({ kernel: k, nodeEnv: "test" });
  const org = await seedOrg(db.admin, "sec20", { alice: "owner" });
  const login = async () =>
    (
      (
        await app.inject({
          method: "POST",
          url: "/v1/dev/login",
          payload: { oidcSubject: org.users.alice!.subject },
        })
      ).json() as { token: string }
    ).token;
  const get = (t: string) =>
    app.inject({ method: "GET", url: "/v1/workspaces", headers: { authorization: `Bearer ${t}` } });

  // sessions: in-flight request sequence, revoke between requests
  const t1 = await login();
  const other = await login();
  const before = [await get(t1), await get(t1)].map((r) => r.statusCode);
  const revoke = await app.inject({
    method: "POST",
    url: "/v1/session/revoke",
    headers: { authorization: `Bearer ${t1}` },
  });
  const t0 = Date.now();
  const after = await get(t1);
  const lagMs = Date.now() - t0;
  const afterBody = after.json() as { reasonCode?: string; message?: string };
  const otherStillValid = (await get(other)).statusCode;
  const again = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { authorization: `Bearer ${t1}`, "idempotency-key": `k-${randomUUID()}` },
    payload: { objective: "x", networkScope: "fixture-only" },
  });
  await app.close();
  expect(before).toEqual([200, 200]);
  expect(revoke.statusCode).toBe(204);
  expect(after.statusCode).toBe(401);
  expect(afterBody.reasonCode).toBe("SESSION_REVOKED");
  expect(lagMs).toBeLessThan(SESSION_BOUND_MS);
  expect(again.statusCode).toBe(401);
  expect(otherStillValid).toBe(200); // control: revocation is per session, not a global lockout

  // leases and approvals through the real kernel
  const r: Rig = await rig({ prefix: "sec20r" });
  try {
    const ok = await r.invoke({ action: "ok" });
    expect(ok.state).toBe("ok");
    const lease = (
      await r.db.admin.query("SELECT id FROM capability_leases WHERE capability = $1", [HOSTILE_CAP])
    ).rows[0].id as string;
    await r.k.leases.revoke(r.human, lease);
    const t2 = Date.now();
    const denied = await r.invoke({ action: "ok" });
    const leaseLag = Date.now() - t2;
    expect(denied.state).toBe("blocked");
    expect(denied.reasonCode).toBe("TOOL_NOT_GRANTED");

    const runId = randomUUID();
    const hash = "a".repeat(64);
    const ctx = { orgId: r.orgId, userId: r.human.userId };
    const grant = () =>
      r.k.db.tx(ctx, (tx) =>
        r.k.approvals.grant(tx, {
          orgId: r.orgId,
          workspaceId: r.workspaceId,
          runId,
          actionHash: hash,
          approvedBy: r.human.userId,
        }),
      );
    const consume = () =>
      r.k.db
        .tx(ctx, (tx) =>
          r.k.approvals.consume(tx, {
            workspaceId: r.workspaceId,
            runId,
            usedBy: "agent",
            matches: (h) => h === hash,
          }),
        )
        .then(
          () => "consumed",
          (e) => (e as { reasonCode: string }).reasonCode,
        );
    await grant();
    await r.k.db.tx(ctx, (tx) => r.k.approvals.revoke(tx, { workspaceId: r.workspaceId, runId }));
    const revokedUse = await consume();
    expect(revokedUse).toBe("APPROVAL_REVOKED");
    // control: an unrevoked approval is consumed exactly once
    const run2 = randomUUID();
    await r.k.db.tx(ctx, (tx) =>
      r.k.approvals.grant(tx, {
        orgId: r.orgId,
        workspaceId: r.workspaceId,
        runId: run2,
        actionHash: hash,
        approvedBy: r.human.userId,
      }),
    );
    const use = () =>
      r.k.db
        .tx(ctx, (tx) =>
          r.k.approvals.consume(tx, {
            workspaceId: r.workspaceId,
            runId: run2,
            usedBy: "a",
            matches: (h) => h === hash,
          }),
        )
        .then(
          () => "consumed",
          (e) => (e as { reasonCode: string }).reasonCode,
        );
    expect([await use(), await use()]).toEqual(["consumed", "APPROVAL_REUSED"]);

    // (d) the recorded events carry no token
    const audit = JSON.stringify((await r.db.admin.query("SELECT * FROM audit_events")).rows);
    expect(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(audit)).toBe(false);
    expect(audit.includes(t1)).toBe(false);

    observe({
      testId: "SEC20",
      observed: `session: two requests ok, token revoked through POST /v1/session/revoke (204), the next read and write were refused 401 SESSION_REVOKED after ${lagMs} ms (bound ${SESSION_BOUND_MS} ms), a second session of the same user stayed valid; lease: revoked, next tool call blocked TOOL_NOT_GRANTED after ${leaseLag} ms; approval: revoked before use then refused (${revokedUse}), unrevoked control consumed once then ${"APPROVAL_REUSED"}; audit rows contain no token. Criteria (b) credential rotation without restart and (c) no retry loop on 401/403 with a degraded source were not executed: the ingestion HTTP client has no credential-rotation pickup or auth circuit breaker to test.`,
      fixtureHash: createHash("sha256").update("sec20-v1").digest("hex"),
      evidence: { lagMs, leaseLag, revokedUse },
      blocked:
        "criteria (b) and (c) need a provider client with credential rotation and an auth circuit breaker (services/ingestion HttpClient has neither); criteria (a) and (d) executed and held",
    });
  } finally {
    await r.drop();
  }
}, 300_000);
