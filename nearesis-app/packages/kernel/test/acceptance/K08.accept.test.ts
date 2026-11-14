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
  const org = await seedOrg(db.admin, "k08", { alice: "owner" });
  s = await loginSession(k, org.users.alice!.subject);
});
afterAll(async () => db?.drop());

const HANG = "fx_plugin_timeout.hang@1";
const SAY = "fx_plugin_timeout.say@1";
const TIMEOUT_MS = 250;

it("K08: a plugin timeout is bounded, marks the plugin degraded and never reports success", async () => {
  await k.plugins.install(
    null,
    makeManifest({
      pluginId: "fx-plugin-timeout",
      version: "1.0.0",
      entrypoint: "timeout.ts",
      capabilities: [cap(HANG, { timeoutMs: TIMEOUT_MS }), cap(SAY)],
    }),
  );
  await k.plugins.enable(null, "fx-plugin-timeout");
  const { workspaceId, version } = await createWs(k, s);
  await pluginUp(k, s, workspaceId, version, "fx-plugin-timeout");
  await giveLease(k, s, workspaceId, HANG);
  await giveLease(k, s, workspaceId, SAY);

  const t0 = Date.now();
  const res = await k.gateway.invoke(s.principal, execReq(s, workspaceId, HANG, {}, { deadlineMs: 60_000 }));
  const elapsed = Date.now() - t0;

  expect(res.state).toBe("failed");
  expect(res.reasonCode).toBe("PLUGIN_TIMEOUT");
  expect(JSON.stringify(res.payload)).not.toContain("late-success");
  expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
  expect(elapsed).toBeLessThan(TIMEOUT_MS + 1500);
  expect(fx().calls["fx-plugin-timeout@1.0.0:hang"]).toBe(1);

  const row = (
    await db.admin.query(
      "SELECT state, state_reason, consecutive_failures FROM plugin_installations WHERE plugin_id='fx-plugin-timeout'",
    )
  ).rows[0];
  expect(row.state).toBe("degraded");
  const incidents = (
    await db.admin.query(
      "SELECT kind FROM plugin_incidents WHERE plugin_id='fx-plugin-timeout' AND resolved_at IS NULL",
    )
  ).rows;
  expect(incidents.map((i) => i.kind)).toEqual(["timeout"]);
  const stored = (
    await db.admin.query("SELECT state, reason_code FROM tool_invocations WHERE request_id=$1", [
      res.requestId,
    ])
  ).rows[0];
  expect(stored).toMatchObject({ state: "failed", reason_code: "PLUGIN_TIMEOUT" });
  const audit = (
    await db.admin.query(
      "SELECT outcome, reason_code FROM audit_events WHERE action='tool.invoke.completed' AND subject=$1",
      [HANG],
    )
  ).rows;
  expect(audit).toEqual([{ outcome: "failed", reason_code: "PLUGIN_TIMEOUT" }]);

  // The degraded plugin is visible in inspect(); a successful health check heals it.
  const insp = await k.engine.inspect();
  expect(insp.plugins[0]).toMatchObject({ state: "degraded" });
  expect(insp.plugins[0]!.openIncidents).toHaveLength(1);
  const healed = await k.plugins.checkHealth(
    insp.plugins.length ? (await k.plugins.activeInstallation("fx-plugin-timeout"))!.id : "",
  );
  expect(healed.state).toBe("enabled");

  observe({
    testId: "K08",
    observed: `hang capability with timeoutMs=${TIMEOUT_MS} (deadline 60000): returned after ${elapsed}ms with state=${res.state} reasonCode=${res.reasonCode}; payload contains no success data; plugin state in DB = degraded with 1 open timeout incident; stored invocation state=failed; audit outcome=failed; health check subsequently healed plugin to enabled`,
    evidence: {
      elapsedMs: elapsed,
      timeoutMs: TIMEOUT_MS,
      response: { state: res.state, reasonCode: res.reasonCode },
      pluginRow: row,
      incidents,
      audit,
    },
  });
});
