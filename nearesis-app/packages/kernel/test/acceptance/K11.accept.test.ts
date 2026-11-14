import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { KernelError } from "../../src/index.ts";
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
  newLatch,
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
  const org = await seedOrg(db.admin, "k11", { alice: "owner" });
  s = await loginSession(k, org.users.alice!.subject);
});
afterAll(async () => db?.drop());

const SAY = "fx_plugin_echo.say@1";
const SLOW = "fx_plugin_echo.slow@1";
const caps = [cap(SAY), cap(SLOW, { timeoutMs: 10_000 })];

const wait = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

it("K11: upgrade and rollback preserve pinned versions and in-flight work", async () => {
  const snaps: Record<string, unknown> = {};
  const snap = async (name: string) => {
    const i = await k.engine.inspect();
    snaps[name] = i.plugins.map((p) => ({
      v: p.version,
      state: p.state,
      active: p.active,
      live: p.liveCapabilities.length,
      deps: p.dependentWorkspaces.length,
    }));
  };

  // Negative case: a manifest without rollbackStrategy is rejected at install.
  let neg: KernelError | undefined;
  try {
    await k.plugins.install(
      null,
      makeManifest({
        pluginId: "fx-plugin-echo",
        version: "9.9.9",
        entrypoint: "echo-1.0.0.ts",
        capabilities: caps,
        dropRollback: true,
      }),
    );
  } catch (e) {
    neg = e as KernelError;
  }
  expect(neg?.reasonCode).toBe("MANIFEST_INVALID");

  for (const [v, f] of [
    ["1.0.0", "echo-1.0.0.ts"],
    ["1.1.0", "echo-1.1.0.ts"],
    ["2.0.0", "echo-2.0.0.ts"],
  ] as const) {
    await k.plugins.install(
      s.userId,
      makeManifest({ pluginId: "fx-plugin-echo", version: v, entrypoint: f, capabilities: caps }),
    );
  }
  // 1. install + enable 1.0.0
  await k.plugins.enable(s.userId, "fx-plugin-echo", "1.0.0");
  const w1 = await createWs(k, s, "W1");
  const w2 = await createWs(k, s, "W2");
  const w1v = await pluginUp(k, s, w1.workspaceId, w1.version, "fx-plugin-echo");
  await pluginUp(k, s, w2.workspaceId, w2.version, "fx-plugin-echo");
  for (const w of [w1, w2]) {
    await giveLease(k, s, w.workspaceId, SAY);
    await giveLease(k, s, w.workspaceId, SLOW);
  }
  await snap("1-enabled-1.0.0");
  const pinned = async () =>
    (
      await db.admin.query(
        "SELECT workspace_id, pinned_major FROM workspace_plugins ORDER BY pinned_major, workspace_id",
      )
    ).rows;
  expect((await pinned()).every((r) => r.pinned_major === 1)).toBe(true);

  // 2. in-flight slow call on W1 against 1.0.0
  const latch = newLatch("k11");
  const before = fx().calls["fx-plugin-echo@1.0.0"] ?? 0;
  const inflight = k.gateway.invoke(s.principal, execReq(s, w1.workspaceId, SLOW, { latch: "k11" }));
  await wait(() => (fx().calls["fx-plugin-echo@1.0.0"] ?? 0) > before);

  // 3. upgrade to 1.1.0 while in flight
  const up = await k.plugins.upgrade(s.userId, "fx-plugin-echo", "1.1.0");
  expect(up).toEqual({ from: "1.0.0", to: "1.1.0" });
  await snap("3-upgraded-1.1.0");

  // 4. release latch: the in-flight call finishes on the version it started with
  latch.release();
  const r1 = await inflight;
  expect(r1.state).toBe("ok");
  expect(r1.provenance.pluginVersion).toBe("1.0.0");
  expect((r1.payload as { version: string }).version).toBe("1.0.0");

  // 5. new invocation => 1.1.0
  const r2 = await k.gateway.invoke(s.principal, execReq(s, w1.workspaceId, SAY, { text: "x" }));
  expect(r2.provenance.pluginVersion).toBe("1.1.0");
  expect((r2.payload as { version: string }).version).toBe("1.1.0");

  // 6. rollback => 1.0.0
  const calls11 = fx().calls["fx-plugin-echo@1.1.0"];
  const rb = await k.plugins.rollback(s.userId, "fx-plugin-echo");
  expect(rb).toEqual({ from: "1.1.0", to: "1.0.0" });
  await snap("6-rolled-back");
  const insp = await k.engine.inspect();
  const live = insp.plugins.filter((p) => p.liveCapabilities.length > 0);
  expect(live.map((p) => p.version)).toEqual(["1.0.0"]);
  expect(insp.plugins.find((p) => p.version === "1.1.0")).toMatchObject({
    active: false,
    state: "installed",
    liveCapabilities: [],
  });
  const caps1 = await k.plugins.listCapabilities(s.principal, s.userId, w1.workspaceId);
  expect(new Set(caps1.map((c) => c.version))).toEqual(new Set(["1.0.0"]));

  // 7. new invocation => 1.0.0, and 1.1.0 code is not callable
  const r3 = await k.gateway.invoke(s.principal, execReq(s, w1.workspaceId, SAY, { text: "y" }));
  expect(r3.provenance.pluginVersion).toBe("1.0.0");
  expect((r3.payload as { version: string }).version).toBe("1.0.0");
  expect(fx().calls["fx-plugin-echo@1.1.0"]).toBe(calls11);

  // 8. breaking upgrade without migration is rejected; W1 stays pinned to 1.x
  let e8: KernelError | undefined;
  try {
    await k.plugins.upgrade(s.userId, "fx-plugin-echo", "2.0.0");
  } catch (e) {
    e8 = e as KernelError;
  }
  expect(e8).toBeInstanceOf(KernelError);
  expect(e8!.reasonCode).toBe("ABI_MAJOR_CHANGE_REQUIRES_MIGRATION");
  expect((await pinned()).every((r) => r.pinned_major === 1)).toBe(true);
  expect((await k.plugins.activeInstallation("fx-plugin-echo"))!.version).toBe("1.0.0");
  const r4 = await k.gateway.invoke(s.principal, execReq(s, w1.workspaceId, SAY, { text: "z" }));
  expect(r4.provenance.pluginVersion).toBe("1.0.0");

  // 9. with a declared migration
  const e9 = await k.plugins.upgrade(s.userId, "fx-plugin-echo", "2.0.0", { migration: "echo-v1-to-v2" });
  expect(e9).toEqual({ from: "1.0.0", to: "2.0.0" });
  expect((await pinned()).every((r) => r.pinned_major === 2)).toBe(true);
  const r5 = await k.gateway.invoke(s.principal, execReq(s, w1.workspaceId, SAY, { text: "w" }));
  expect(r5.provenance.pluginVersion).toBe("2.0.0");
  await snap("9-migrated-2.0.0");

  // (e) exactly one audit event per upgrade/rollback, with actor, from and to
  const audit = (
    await db.admin.query(
      "SELECT action, actor_id, detail FROM audit_events WHERE action IN ('plugin.upgraded','plugin.rolled_back','plugin.upgrade_denied') ORDER BY occurred_at",
    )
  ).rows;
  expect(audit.map((a) => a.action)).toEqual([
    "plugin.upgraded",
    "plugin.rolled_back",
    "plugin.upgrade_denied",
    "plugin.upgraded",
  ]);
  const flat = audit
    .filter((a) => a.action !== "plugin.upgrade_denied")
    .map((a) => ({ action: a.action, actor: a.actor_id, from: a.detail.from, to: a.detail.to }));
  expect(flat).toEqual([
    { action: "plugin.upgraded", actor: s.userId, from: "1.0.0", to: "1.1.0" },
    { action: "plugin.rolled_back", actor: s.userId, from: "1.1.0", to: "1.0.0" },
    { action: "plugin.upgraded", actor: s.userId, from: "1.0.0", to: "2.0.0" },
  ]);

  // (f) no result attributed to the wrong version: every stored invocation matches its payload version
  const inv = (
    await db.admin.query("SELECT capability, plugin_version, response FROM tool_invocations WHERE state='ok'")
  ).rows;
  for (const row of inv)
    expect((row.response.payload as { version: string }).version).toBe(row.plugin_version);
  expect(row0(inv)).toBeTruthy();
  void w1v;

  observe({
    testId: "K11",
    observed: `in-flight call started on 1.0.0 survived upgrade to 1.1.0 and reported pluginVersion=${r1.provenance.pluginVersion}; post-upgrade call ${r2.provenance.pluginVersion}; post-rollback call ${r3.provenance.pluginVersion}, 1.1.0 inactive/not live and code counter unchanged; upgrade to 2.0.0 without migration -> ${e8!.reasonCode} (W1 pinned_major stayed 1, active stayed 1.0.0, call ${r4.provenance.pluginVersion}); with migration -> ${r5.provenance.pluginVersion}; audit: ${flat.length} upgrade/rollback events (2 upgrades, 1 rollback) each with actor/from/to, plus 1 separate upgrade_denied; ${inv.length} ok invocations all payload version == attributed version; missing-rollbackStrategy manifest rejected (${neg!.reasonCode})`,
    evidence: {
      inspectSnapshots: snaps,
      auditEvents: audit,
      envelopes: [r1, r2, r3, r4, r5].map((r) => ({
        requestId: r.requestId,
        state: r.state,
        provenance: r.provenance,
        version: (r.payload as { version: string }).version,
      })),
    },
  });
});

function row0<T>(a: T[]): T | undefined {
  return a[0];
}
