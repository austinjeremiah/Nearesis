import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import type { Kernel, Session } from "../../src/index.ts";
import {
  cap,
  createTestDb,
  createWs,
  execReq,
  fx,
  giveLease,
  loginSession,
  makeManifest,
  pluginUp,
  runCmd,
  seedOrg,
  testKernel,
} from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  const org = await seedOrg(db.admin, "k07", { alice: "owner" });
  s = await loginSession(k, org.users.alice!.subject);
});
afterAll(async () => db?.drop());

const CAP = "fx_plugin_echo.say@1";

it("K07: invocation of a disabled plugin is denied, the tool never runs, and an audit event is persisted", async () => {
  await k.plugins.install(
    null,
    makeManifest({
      pluginId: "fx-plugin-echo",
      version: "1.0.0",
      entrypoint: "echo-1.0.0.ts",
      capabilities: [cap(CAP)],
    }),
  );
  await k.plugins.enable(null, "fx-plugin-echo");
  const { workspaceId, version } = await createWs(k, s);
  const v2 = await pluginUp(k, s, workspaceId, version, "fx-plugin-echo");
  await giveLease(k, s, workspaceId, CAP);

  // Control: enabled plugin runs.
  const ok = await k.gateway.invoke(s.principal, execReq(s, workspaceId, CAP, { text: "hi" }));
  expect(ok.state).toBe("ok");
  const callsBefore = fx().calls["fx-plugin-echo@1.0.0"];
  expect(callsBefore).toBe(1);

  // (a) Global disable.
  await k.plugins.disable(s.userId, "fx-plugin-echo", "operator test");
  const denied = await k.gateway.invoke(s.principal, execReq(s, workspaceId, CAP, { text: "hi" }));
  expect(denied.state).toBe("blocked");
  expect(denied.reasonCode).toBe("PLUGIN_DISABLED");
  expect(fx().calls["fx-plugin-echo@1.0.0"]).toBe(callsBefore);
  const a1 = (
    await db.admin.query(
      "SELECT outcome, reason_code, actor_id, workspace_id FROM audit_events WHERE action='tool.invoke.denied' AND subject=$1",
      [CAP],
    )
  ).rows;
  expect(a1).toHaveLength(1);
  expect(a1[0]).toMatchObject({
    outcome: "denied",
    reason_code: "PLUGIN_DISABLED",
    actor_id: s.userId,
    workspace_id: workspaceId,
  });
  const disabledAudit = (
    await db.admin.query("SELECT count(*)::int n FROM audit_events WHERE action='plugin.disabled'")
  ).rows[0].n;
  expect(disabledAudit).toBe(1);

  // (b) Re-enable, then disable only for the workspace (command path).
  await k.plugins.enable(null, "fx-plugin-echo");
  expect((await k.gateway.invoke(s.principal, execReq(s, workspaceId, CAP, { text: "again" }))).state).toBe(
    "ok",
  );
  const calls2 = fx().calls["fx-plugin-echo@1.0.0"];
  await runCmd(k, s, workspaceId, "plugin.disable", { pluginId: "fx-plugin-echo" }, v2);
  const denied2 = await k.gateway.invoke(s.principal, execReq(s, workspaceId, CAP, { text: "no" }));
  expect(denied2.state).toBe("blocked");
  expect(denied2.reasonCode).toBe("PLUGIN_DISABLED");
  expect(fx().calls["fx-plugin-echo@1.0.0"]).toBe(calls2);
  const denies = (
    await db.admin.query(
      "SELECT count(*)::int n FROM audit_events WHERE action='tool.invoke.denied' AND reason_code='PLUGIN_DISABLED'",
    )
  ).rows[0].n;
  expect(denies).toBe(2);

  // Idempotent replay of a denied request does not re-run or re-audit.
  const req = execReq(s, workspaceId, CAP, {});
  const d1 = await k.gateway.invoke(s.principal, req);
  const d2 = await k.gateway.invoke(s.principal, req);
  expect(d2).toEqual(d1);

  observe({
    testId: "K07",
    observed: `global disable -> state=${denied.state} reasonCode=${denied.reasonCode}; workspace-level disable -> ${denied2.reasonCode}; tool call counter stayed at ${callsBefore}/${calls2} (never executed); persisted tool.invoke.denied audit rows with reason PLUGIN_DISABLED = ${denies}; plugin.disabled audit rows = ${disabledAudit}`,
    evidence: {
      denied: { state: denied.state, reasonCode: denied.reasonCode },
      denied2: { state: denied2.state, reasonCode: denied2.reasonCode },
      auditRows: a1,
      sideEffectCounter: fx().calls["fx-plugin-echo@1.0.0"],
    },
  });
});
