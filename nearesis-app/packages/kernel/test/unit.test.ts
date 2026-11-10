import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  KernelError,
  STATE_TRANSITIONS,
  canTransition,
  deriveLease,
  migrate,
  redact,
  toErrorResponse,
} from "../src/index.ts";
import type { PluginState } from "../src/index.ts";
import {
  cap,
  createTestDb,
  createWs,
  execReq,
  giveLease,
  inHours,
  loginSession,
  makeManifest,
  pluginUp,
  seedOrg,
  testKernel,
} from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";

const g = (action: string, maxCost: number, h: number) => ({
  resource: "r",
  action,
  maxCost,
  expiresAt: inHours(h),
});

describe("deriveLease (intersection table)", () => {
  const parent = { grants: [g("read", 10, 2), g("write", 5, 1)], expiresAt: inHours(2) };
  const cases: Array<[string, { grants: ReturnType<typeof g>[]; expiresAt: string }, boolean]> = [
    ["identical", parent, true],
    ["strict subset", { grants: [g("read", 3, 1)], expiresAt: inHours(1) }, true],
    ["lower cost same expiry", { grants: [g("write", 5, 1)], expiresAt: inHours(1) }, true],
    ["unknown grant", { grants: [g("admin", 1, 1)], expiresAt: inHours(1) }, false],
    [
      "superset",
      { grants: [g("read", 1, 1), g("write", 1, 1), g("admin", 1, 1)], expiresAt: inHours(1) },
      false,
    ],
    ["higher cost", { grants: [g("read", 10.01, 1)], expiresAt: inHours(1) }, false],
    ["grant outlives parent grant", { grants: [g("write", 5, 1.5)], expiresAt: inHours(1) }, false],
    ["lease outlives parent", { grants: [g("read", 1, 1)], expiresAt: inHours(3) }, false],
    ["empty grants", { grants: [], expiresAt: inHours(1) }, false],
  ];
  it.each(cases)("%s", (_n, req, ok) => {
    if (ok) {
      const d = deriveLease(parent, req);
      for (const gr of d.grants) {
        const p = parent.grants.find((x) => x.action === gr.action)!;
        expect(gr.maxCost).toBeLessThanOrEqual(p.maxCost);
        expect(Date.parse(gr.expiresAt)).toBeLessThanOrEqual(Date.parse(p.expiresAt));
      }
    } else {
      expect(() => deriveLease(parent, req)).toThrowError(KernelError);
    }
  });
  it("is never wider than the parent (randomised)", () => {
    for (let i = 0; i < 200; i++) {
      const req = {
        grants: [g(["read", "write", "x"][i % 3]!, (i * 7) % 13, (i % 5) * 0.6)],
        expiresAt: inHours((i % 4) * 0.7),
      };
      try {
        const d = deriveLease(parent, req);
        const p = parent.grants.find((x) => x.action === d.grants[0]!.action)!;
        expect(d.grants[0]!.maxCost).toBeLessThanOrEqual(p.maxCost);
        expect(Date.parse(d.expiresAt)).toBeLessThanOrEqual(Date.parse(parent.expiresAt));
      } catch (e) {
        expect(e).toBeInstanceOf(KernelError);
      }
    }
  });
});

describe("plugin state machine", () => {
  const all = Object.keys(STATE_TRANSITIONS) as PluginState[];
  it("quarantined and disabled cannot jump to degraded", () => {
    expect(canTransition("quarantined", "degraded")).toBe(false);
    expect(canTransition("disabled", "degraded")).toBe(false);
    expect(canTransition("installed", "quarantined")).toBe(false);
  });
  it("enabled -> degraded -> quarantined -> enabled (release)", () => {
    expect(canTransition("enabled", "degraded")).toBe(true);
    expect(canTransition("degraded", "quarantined")).toBe(true);
    expect(canTransition("quarantined", "enabled")).toBe(true);
  });
  it("every state can retire to installed or disabled", () => {
    for (const s of all) expect(canTransition(s, "disabled") || canTransition(s, "installed")).toBe(true);
  });
});

describe("error mapping", () => {
  it("maps KernelError with ErrorResponse + HTTP status", () => {
    const { status, body } = toErrorResponse(
      new KernelError("STALE_VERSION", "STALE_VERSION", "x", { lastStableRevision: 4 }),
      "t-1",
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      traceId: "t-1",
      errorCode: "STALE_VERSION",
      retryable: true,
      lastStableRevision: 4,
    });
  });
  it("maps serialization failures to 409 and hides raw DB errors", () => {
    expect(toErrorResponse({ code: "40001", message: "could not serialize" }, "t").status).toBe(409);
    const r = toErrorResponse(
      Object.assign(new Error('relation "secret_table" does not exist'), { code: "42P01" }),
      "t",
    );
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("secret_table");
  });
  it("scrubs bearer tokens from messages", () => {
    const r = toErrorResponse(new KernelError("INTERNAL", "X", "failed with Bearer abc.def.ghi"), "t");
    expect(r.body.message).not.toContain("abc.def.ghi");
  });
});

describe("redaction", () => {
  it("redacts secret-like keys recursively", () => {
    expect(
      redact({
        a: 1,
        apiKey: "x",
        API_KEY: "x",
        nested: [{ Authorization: "b", ok: 2 }],
        password: "p",
        jwt: "j",
        Token: "t",
        secret_value: "s",
      }),
    ).toEqual({
      a: 1,
      apiKey: "[REDACTED]",
      API_KEY: "[REDACTED]",
      nested: [{ Authorization: "[REDACTED]", ok: 2 }],
      password: "[REDACTED]",
      jwt: "[REDACTED]",
      Token: "[REDACTED]",
      secret_value: "[REDACTED]",
    });
  });
});

describe("database", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => db?.drop());

  it("migrations are idempotent", async () => {
    const again = await migrate(db.adminUrl);
    expect(again).toEqual([]);
    const n = (await db.admin.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it("app role is NOSUPERUSER NOBYPASSRLS and every tenant table forces RLS", async () => {
    const r = (
      await db.admin.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='nearesis_app'")
    ).rows[0];
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
    const missing = (
      await db.admin.query(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> 'schema_migrations'
           AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname IN ('org_id','tenant_id') AND NOT a.attisdropped)
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
      )
    ).rows;
    expect(missing).toEqual([]);
  });

  it("RLS holds with no WHERE clause: user B sees 0 foreign rows in every tenant table", async () => {
    const k = testKernel(db);
    const a = await seedOrg(db.admin, "ua", { alice: "owner" });
    const b = await seedOrg(db.admin, "ub", { bob: "owner" });
    const sa = await loginSession(k, a.users.alice!.subject);
    const sb = await loginSession(k, b.users.bob!.subject);
    const { workspaceId } = await createWs(k, sa);
    await db.admin.query("INSERT INTO panels(id, org_id, workspace_id, kind) VALUES ($1,$2,$3,'c')", [
      randomUUID(),
      a.orgId,
      workspaceId,
    ]);
    const ctxB = { orgId: b.orgId, userId: sb.userId };
    for (const t of [
      "workspaces",
      "branches",
      "workspace_events",
      "outbox",
      "commands",
      "panels",
      "memberships",
      "organizations",
      "audit_events",
      "create_requests",
    ]) {
      const rows = await db.app.tx(ctxB, (tx) => tx.query(`SELECT * FROM ${t}`));
      const foreign = rows.rows.filter(
        (r) => [r.org_id, r.tenant_id, r.id].includes(a.orgId) || r.workspace_id === workspaceId,
      );
      expect(foreign, t).toEqual([]);
    }
    // Writes into a foreign org are refused by the WITH CHECK policy.
    await expect(
      db.app.tx(ctxB, (tx) =>
        tx.query(
          "INSERT INTO workspaces(id, org_id, objective, network_scope, created_by) VALUES ($1,$2,'x','fixture-only',$3)",
          [randomUUID(), a.orgId, sb.userId],
        ),
      ),
    ).rejects.toThrow();
    // No tenant context at all: nothing is visible.
    const none = await db.app.txGlobal((tx) => tx.query("SELECT count(*)::int n FROM workspaces"));
    expect(none.rows[0].n).toBe(0);
    // Same-org non-member (membership removed) loses access too.
    await db.admin.query("DELETE FROM memberships WHERE user_id=$1", [sa.userId]);
    const gone = await db.app.tx({ orgId: a.orgId, userId: sa.userId }, (tx) =>
      tx.query("SELECT count(*)::int n FROM workspaces"),
    );
    expect(gone.rows[0].n).toBe(0);
  });

  it("gateway: validates input, redacts secrets in output, rejects bad output schema, ignores forged principal", async () => {
    const k = testKernel(db);
    const o = await seedOrg(db.admin, "gw", { alice: "owner" });
    const s = await loginSession(k, o.users.alice!.subject);
    const LEAK = "fx_plugin_echo.leak@1";
    const BOOM = "fx_plugin_echo.boom@1";
    const SAY = "fx_plugin_echo.say@1";
    await k.plugins.install(
      null,
      makeManifest({
        pluginId: "fx-plugin-echo",
        version: "1.0.0",
        entrypoint: "echo-1.0.0.ts",
        capabilities: [
          cap(LEAK),
          cap(BOOM),
          cap(SAY, {
            inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
            outputSchema: { type: "object", required: ["nope"] },
          }),
        ],
      }),
    );
    await k.plugins.enable(null, "fx-plugin-echo");
    const { workspaceId, version } = await createWs(k, s);
    await pluginUp(k, s, workspaceId, version, "fx-plugin-echo");
    for (const c of [LEAK, BOOM, SAY]) await giveLease(k, s, workspaceId, c);

    const leak = await k.gateway.invoke(s.principal, execReq(s, workspaceId, LEAK));
    expect(leak.state).toBe("ok");
    expect(JSON.stringify(leak.payload)).not.toContain("sk-live");
    expect(JSON.stringify(leak.payload)).not.toContain("Bearer abc");
    expect(leak.payload).toMatchObject({
      ok: true,
      apiKey: "[REDACTED]",
      nested: { Authorization: "[REDACTED]", fine: 1 },
    });

    const badIn = await k.gateway.invoke(s.principal, execReq(s, workspaceId, SAY, { text: 5 }));
    expect(badIn).toMatchObject({ state: "failed", reasonCode: "INPUT_SCHEMA_INVALID" });
    const badOut = await k.gateway.invoke(s.principal, execReq(s, workspaceId, SAY, { text: "ok" }));
    expect(badOut).toMatchObject({ state: "failed", reasonCode: "OUTPUT_SCHEMA_INVALID" });

    const boom = await k.gateway.invoke(s.principal, execReq(s, workspaceId, BOOM));
    expect(boom).toMatchObject({ state: "failed", reasonCode: "PLUGIN_ERROR" });
    expect(JSON.stringify(boom)).not.toContain("token=abc");

    // Forged tenant / actor in the request are refused.
    const forged = { ...execReq(s, workspaceId, LEAK), tenantId: randomUUID() };
    await expect(k.gateway.invoke(s.principal, forged)).rejects.toMatchObject({
      reasonCode: "PRINCIPAL_MISMATCH",
    });
    const forgedActor = {
      ...execReq(s, workspaceId, LEAK),
      actor: { kind: "human" as const, actorId: randomUUID() },
    };
    await expect(k.gateway.invoke(s.principal, forgedActor)).rejects.toMatchObject({
      reasonCode: "PRINCIPAL_MISMATCH",
    });

    // A client-supplied grantFingerprint never grants authority: no lease for this capability => blocked.
    const other = "fx_plugin_echo.slow@1";
    const noLease = await k.gateway.invoke(
      s.principal,
      execReq(s, workspaceId, other, {}, { grantFingerprint: "a".repeat(64) }),
    );
    expect(noLease.state).toBe("blocked");
    // Idempotent replay of a successful call returns the stored envelope without re-running the tool.
    const req = execReq(s, workspaceId, LEAK);
    const r1 = await k.gateway.invoke(s.principal, req);
    const r2 = await k.gateway.invoke(s.principal, req);
    expect(r2).toEqual(r1);
  });

  it("degrades after repeated plugin errors and quarantines at the threshold", async () => {
    const k = testKernel(db, { quarantineAfterFailures: 2 });
    await k.plugins.install(
      null,
      makeManifest({
        pluginId: "fx-plugin-ro",
        version: "1.0.0",
        entrypoint: "ro.ts",
        capabilities: [cap("fx_plugin_ro.boom@1")],
      }),
    );
    const inst = await k.plugins.enable(null, "fx-plugin-ro");
    const o = await seedOrg(db.admin, "q", { alice: "owner" });
    const s = await loginSession(k, o.users.alice!.subject);
    const { workspaceId, version } = await createWs(k, s);
    await pluginUp(k, s, workspaceId, version, "fx-plugin-ro");
    await giveLease(k, s, workspaceId, "fx_plugin_ro.boom@1");
    await k.gateway.invoke(s.principal, execReq(s, workspaceId, "fx_plugin_ro.boom@1"));
    expect((await k.plugins.getInstallation(inst.id))!.state).toBe("enabled");
    await k.gateway.invoke(s.principal, execReq(s, workspaceId, "fx_plugin_ro.boom@1"));
    expect((await k.plugins.getInstallation(inst.id))!.state).toBe("quarantined");
    await k.plugins.release(null, "fx-plugin-ro");
    expect((await k.plugins.getInstallation(inst.id))!.state).toBe("enabled");
  });
});
