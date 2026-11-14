import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enablePluginsInTx } from "../src/index.ts";
import type { Kernel, Session } from "../src/index.ts";
import {
  cap,
  createTestDb,
  execReq,
  giveLease,
  loginSession,
  makeManifest,
  seedOrg,
  testKernel,
} from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
let other: Session;
const SAY = "fx_plugin_echo.say@1";
beforeAll(async () => {
  process.env.NEARESIS_DEFAULT_PLUGINS = "fx-plugin-echo,fx-not-installed";
  db = await createTestDb();
  k = testKernel(db);
  const a = await seedOrg(db.admin, "dp", { alice: "owner" });
  const b = await seedOrg(db.admin, "dp2", { bob: "owner" });
  s = await loginSession(k, a.users.alice!.subject);
  other = await loginSession(k, b.users.bob!.subject);
  await k.plugins.install(
    null,
    makeManifest({
      pluginId: "fx-plugin-echo",
      version: "1.0.0",
      entrypoint: "echo-1.0.0.ts",
      capabilities: [cap(SAY)],
    }),
  );
  await k.plugins.enable(null, "fx-plugin-echo");
});
afterAll(async () => {
  delete process.env.NEARESIS_DEFAULT_PLUGINS;
  await db?.drop();
});

const create = (who: Session, objective: string, extra?: { requiredPlugins?: string[] }) =>
  k.workspaces.create(
    who,
    { objective, networkScope: "fixture-only", idempotencyKey: `k-${randomUUID()}` },
    extra,
  );
const rows = async (ws: string) =>
  (
    await db.admin.query(
      "SELECT plugin_id, pinned_major, enabled, enabled_by FROM workspace_plugins WHERE workspace_id=$1",
      [ws],
    )
  ).rows;

describe("default plugin set at workspace creation", () => {
  it("enables the default set at the active major, audited, and the workspace can run a capability at once", async () => {
    const { workspaceId } = await create(s, "fresh workspace objective");
    expect(await rows(workspaceId)).toEqual([
      { plugin_id: "fx-plugin-echo", pinned_major: 1, enabled: true, enabled_by: s.userId },
    ]);
    const audit = await db.admin.query(
      "SELECT detail FROM audit_events WHERE workspace_id=$1 AND action='plugin.enabled_by_default'",
      [workspaceId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].detail).toMatchObject({
      pluginId: "fx-plugin-echo",
      pinnedMajor: 1,
      reason: "workspace_created",
    });
    await giveLease(k, s, workspaceId, SAY);
    const r = await k.gateway.invoke(s.principal, execReq(s, workspaceId, SAY));
    expect(r.state).toBe("ok");
  });

  it("is idempotent on retry and enables template-required plugins; uninstalled ones are skipped without failing", async () => {
    const key = `k-${randomUUID()}`;
    const body = { objective: "retry objective", networkScope: "fixture-only", idempotencyKey: key };
    const a = await k.workspaces.create(s, body, { requiredPlugins: ["fx-plugin-echo"] });
    const b = await k.workspaces.create(s, body, { requiredPlugins: ["fx-plugin-echo"] });
    expect(b.workspaceId).toBe(a.workspaceId);
    expect(await rows(a.workspaceId)).toHaveLength(1);
  });

  it("backfill helper enables only missing rows, never re-enables one an admin disabled, and stays inside the tenant", async () => {
    const { workspaceId } = await create(s, "to be disabled");
    await db.admin.query("UPDATE workspace_plugins SET enabled=false WHERE workspace_id=$1", [workspaceId]);
    const res = await db.app.tx({ orgId: s.principal.orgId, userId: s.userId }, (tx) =>
      enablePluginsInTx(tx, {
        orgId: s.principal.orgId,
        workspaceId,
        userId: null,
        plugins: ["fx-plugin-echo", "fx-not-installed"],
        reason: "backfill",
      }),
    );
    expect(res).toEqual({ enabled: [], skipped: ["fx-not-installed"] });
    expect((await rows(workspaceId))[0]!.enabled).toBe(false);
    // other tenant's workspace is untouched by s's work and has its own rows
    const o = await create(other, "other org objective");
    expect((await rows(o.workspaceId))[0]).toMatchObject({
      plugin_id: "fx-plugin-echo",
      enabled_by: other.userId,
    });
    const cross = await db.admin.query(
      "SELECT count(*)::int n FROM workspace_plugins wp JOIN workspaces w ON w.id=wp.workspace_id WHERE wp.org_id <> w.org_id",
    );
    expect(cross.rows[0].n).toBe(0);
  });
});
