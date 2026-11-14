/**
 * SEC20: revocation. PASS: a revoked session is refused within 5 s (frozen bound), a revoked lease and approval
 * immediately; logs carry no secret. Executed: criteria (a) and (d). Criteria (b) credential rotation without restart and
 * (c) bounded retries with a degraded source run against the ingestion HttpClient (credential rotation pickup, auth
 * circuit breaker) talking over real HTTP to a fault-injecting provider on loopback.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOW_LOOPBACK, HttpClient } from "../../services/ingestion/src/http/client.ts";
import type { AuthDegraded } from "../../services/ingestion/src/http/client.ts";
import { CredentialSource } from "../../services/ingestion/src/http/credentials.ts";
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

it("SEC20: a revoked session, lease and approval stop working at once; provider-credential criteria hold", async () => {
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

    // (b)(c) provider credentials over real HTTP against a fault-injecting provider
    const seen: Array<{ auth: string; status: number }> = [];
    let mode: "reject401" | "reject403" | "ok" = "reject401";
    const srv = createServer((rq, rs) => {
      const auth = String(rq.headers.authorization ?? "");
      const status = auth === "Bearer rotated-credential-v2" ? 200 : mode === "reject403" ? 403 : 401;
      seen.push({ auth, status });
      rs.statusCode = status;
      rs.end("{}");
    });
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    const port = (srv.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "sec20-"));
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "PROVIDER_KEY=original-credential-v1\n");
    const creds = CredentialSource.fromDotenv(envFile, {});
    const degraded: AuthDegraded[] = [];
    let now = Date.parse("2026-11-11T12:00:00Z");
    const clock = { now: () => now, sleep: async () => undefined };
    const CIRCUIT_MS = 60_000;
    const client = new HttpClient({
      allow: [ALLOW_LOOPBACK],
      credentials: creds,
      clock,
      authCircuitMs: CIRCUIT_MS,
      onAuthDegraded: (e) => degraded.push(e),
    });
    const call = () =>
      client
        .request({
          method: "GET",
          url: `http://127.0.0.1:${port}/api/v0/transactions`,
          auth: { credential: "PROVIDER_KEY", header: "authorization" },
        })
        .then(
          (r) => r.status,
          (e) => (e as { code?: string }).code ?? "error",
        );
    let providerTimeline: unknown[] = [];
    let retriesAfter401: number;
    let probesAfterInterval: number;
    try {
      const first = await call(); // 401
      const storm = await Promise.all(Array.from({ length: 20 }, call));
      retriesAfter401 = seen.length - 1;
      mode = "reject403";
      now += CIRCUIT_MS; // interval passes: exactly one probe, now answered 403
      const probe = await call();
      const stormAfter = await Promise.all(Array.from({ length: 20 }, call));
      probesAfterInterval = seen.length - 1 - retriesAfter401;
      const state = client.authState("PROVIDER_KEY", "127.0.0.1");
      expect(first).toBe(401);
      expect(storm.every((x) => x === "AUTH_REJECTED")).toBe(true);
      expect(retriesAfter401).toBe(0);
      expect(probe).toBe(403);
      expect(stormAfter.every((x) => x === "AUTH_REJECTED")).toBe(true);
      expect(probesAfterInterval).toBe(1);
      expect(state.state).toBe("degraded");
      expect(state.humanAction).toMatch(/rotate credential PROVIDER_KEY/);
      expect(degraded).toHaveLength(1);
      expect(degraded[0]!.status).toBe(401);
      // (b) rotation picked up without restart; the old credential is never used again
      const beforeRotate = seen.length;
      writeFileSync(envFile, "PROVIDER_KEY=rotated-credential-v2\n");
      creds.reload();
      mode = "ok";
      const afterRotate = [await call(), await call(), await call()];
      const sentAfterRotate = seen.slice(beforeRotate);
      expect(afterRotate).toEqual([200, 200, 200]);
      expect(sentAfterRotate.every((x) => x.auth === "Bearer rotated-credential-v2")).toBe(true);
      expect(client.authState("PROVIDER_KEY", "127.0.0.1").state).toBe("ok");
      // (d) request log, degraded event and state carry no credential
      const logText = JSON.stringify([client.requestLog, degraded, state]);
      expect(/original-credential|rotated-credential/.test(logText)).toBe(false);
      providerTimeline = seen.map((x, i) => ({ i, status: x.status }));
    } finally {
      srv.close();
      rmSync(dir, { recursive: true, force: true });
    }

    // (d) the recorded events carry no token
    const audit = JSON.stringify((await r.db.admin.query("SELECT * FROM audit_events")).rows);
    expect(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(audit)).toBe(false);
    expect(audit.includes(t1)).toBe(false);

    observe({
      testId: "SEC20",
      observed: `session: two requests ok, token revoked through POST /v1/session/revoke (204), the next read and write were refused 401 SESSION_REVOKED after ${lagMs} ms (bound ${SESSION_BOUND_MS} ms), a second session of the same user stayed valid; lease: revoked, next tool call blocked TOOL_NOT_GRANTED after ${leaseLag} ms; approval: revoked before use then refused (${revokedUse}), unrevoked control consumed once then ${"APPROVAL_REUSED"}; audit rows contain no token. Provider credentials (ingestion HttpClient over real HTTP, loopback fault-injecting provider): first request 401, then 20 concurrent requests made 0 further provider calls (AUTH_REJECTED locally, source degraded with human action "rotate credential"); after the ${CIRCUIT_MS} ms circuit interval exactly ${probesAfterInterval} probe reached the provider (403) and 20 more were refused; the credential file was rotated and reload() picked it up without restart: 3 of 3 later calls 200 and every one carried only the new credential; request log and degraded event contain no credential value.`,
      fixtureHash: createHash("sha256").update("sec20-v1").digest("hex"),
      evidence: { lagMs, leaseLag, revokedUse, retriesAfter401, probesAfterInterval, providerTimeline },
    });
  } finally {
    await r.drop();
  }
}, 300_000);
