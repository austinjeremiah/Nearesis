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
  const org = await seedOrg(db.admin, "k12", { alice: "owner" });
  s = await loginSession(k, org.users.alice!.subject);
});
afterAll(async () => db?.drop());

const ECHO = "fx_plugin_echo.say@1";
const RO = "fx_plugin_ro.say@1";
const QU = "fx_plugin_quarantine.say@1";
const DM = "fx_plugin_dep_missing.say@1";

async function groundTruth() {
  const inst = (await db.admin.query("SELECT * FROM plugin_installations ORDER BY plugin_id, version")).rows;
  const dep = (await db.admin.query("SELECT plugin_id, workspace_id FROM workspace_plugins WHERE enabled"))
    .rows;
  const inc = (
    await db.admin.query(
      "SELECT installation_id, kind, detail FROM plugin_incidents WHERE resolved_at IS NULL",
    )
  ).rows;
  return inst.map((r) => ({
    pluginId: r.plugin_id as string,
    version: r.version as string,
    state: r.state as string,
    trust: r.trust as string,
    active: r.active as boolean,
    lastHeartbeatAt: r.last_heartbeat_at ? new Date(r.last_heartbeat_at).toISOString() : null,
    liveCapabilities:
      r.active && (r.state === "enabled" || r.state === "degraded")
        ? (r.manifest.capabilities as Array<{ id: string }>).map((c) => c.id).sort()
        : [],
    dependentWorkspaces: r.active
      ? dep
          .filter((d) => d.plugin_id === r.plugin_id)
          .map((d) => d.workspace_id as string)
          .sort()
      : [],
    openIncidents: inc
      .filter((i) => i.installation_id === r.id)
      .map((i) => `${i.kind}:${i.detail}`)
      .sort(),
  }));
}
async function viewOfInspect() {
  const i = await k.engine.inspect();
  return i.plugins.map((p) => ({
    pluginId: p.pluginId,
    version: p.version,
    state: p.state as string,
    trust: p.trust as string,
    active: p.active,
    lastHeartbeatAt: p.lastHeartbeatAt,
    liveCapabilities: [...p.liveCapabilities].sort(),
    dependentWorkspaces: [...p.dependentWorkspaces].sort(),
    openIncidents: p.openIncidents.map((x) => `${x.kind}:${x.detail}`).sort(),
  }));
}

it("K12: engine.inspect() and capability discovery report exactly the registered state", async () => {
  const pre = [
    ["fx-plugin-echo", "echo-1.0.0.ts", ECHO, []],
    ["fx-plugin-ro", "ro.ts", RO, []],
    ["fx-plugin-quarantine", "quarantine.ts", QU, []],
    ["fx-plugin-dep-missing", "dep-missing.ts", DM, ["near.explorer@1"]],
  ] as const;
  for (const [id, file, capId, requires] of pre) {
    await k.plugins.install(
      s.userId,
      makeManifest({
        pluginId: id,
        version: "1.0.0",
        entrypoint: file,
        capabilities: [cap(capId)],
        requires: [...requires],
      }),
    );
  }
  const depMissing = (await k.engine.inspect()).plugins.find((p) => p.pluginId === "fx-plugin-dep-missing")!;
  expect(depMissing.state).toBe("disabled");
  expect(depMissing.stateReason).toMatch(/near\.explorer@1/);
  expect(depMissing.stateReason).toMatch(/does not provide/);
  await expect(k.plugins.enable(s.userId, "fx-plugin-dep-missing")).rejects.toMatchObject({
    reasonCode: "DEPENDENCY_MISSING",
  });
  // Kernel still boots with the unmet dependency.
  await k.boot();

  const w1 = await createWs(k, s, "W1");
  const w2 = await createWs(k, s, "W2");
  for (const id of ["fx-plugin-echo", "fx-plugin-ro", "fx-plugin-quarantine"])
    await k.plugins.enable(s.userId, id);
  let v = w1.version;
  for (const id of ["fx-plugin-echo", "fx-plugin-ro", "fx-plugin-quarantine"])
    v = await pluginUp(k, s, w1.workspaceId, v, id);
  for (const c of [ECHO, RO, QU]) await giveLease(k, s, w1.workspaceId, c);
  for (const c of [ECHO, RO, QU]) await giveLease(k, s, w2.workspaceId, c);

  // Echo heartbeat; ro disabled (installed but disabled); quarantine forced via injected health failures.
  await k.plugins.checkHealth((await k.plugins.activeInstallation("fx-plugin-echo"))!.id);
  await k.plugins.disable(s.userId, "fx-plugin-ro", "test: installed but disabled");
  fx().healthFail["fx-plugin-quarantine"] = true;
  const qid = (await k.plugins.activeInstallation("fx-plugin-quarantine"))!.id;
  const states: string[] = [];
  for (let i = 0; i < 3; i++) states.push((await k.plugins.checkHealth(qid)).state);
  expect(states).toEqual(["degraded", "degraded", "quarantined"]);

  // (a) inspect == database ground truth.
  const truth = await groundTruth();
  const got = await viewOfInspect();
  expect(got).toEqual(truth);
  expect(got.map((g) => g.pluginId).sort()).toEqual([
    "fx-plugin-dep-missing",
    "fx-plugin-echo",
    "fx-plugin-quarantine",
    "fx-plugin-ro",
  ]);
  const by = (id: string) => got.find((g) => g.pluginId === id)!;
  expect(by("fx-plugin-echo")).toMatchObject({
    state: "enabled",
    liveCapabilities: [ECHO],
    dependentWorkspaces: [w1.workspaceId],
  });
  expect(by("fx-plugin-echo").lastHeartbeatAt).not.toBeNull();
  expect(by("fx-plugin-ro")).toMatchObject({ state: "disabled", liveCapabilities: [] });
  expect(by("fx-plugin-quarantine")).toMatchObject({ state: "quarantined", liveCapabilities: [] });
  expect(by("fx-plugin-quarantine").openIncidents).toHaveLength(3);
  expect(by("fx-plugin-dep-missing")).toMatchObject({ state: "disabled", liveCapabilities: [] });
  const diff = JSON.stringify(got) === JSON.stringify(truth) ? [] : ["MISMATCH"];
  expect(diff).toEqual([]);

  // (c) discovery scoped by workspace.
  const d1 = await k.plugins.listCapabilities(s.principal, s.userId, w1.workspaceId);
  const d2 = await k.plugins.listCapabilities(s.principal, s.userId, w2.workspaceId);
  expect(d1.map((c) => c.capability)).toEqual([ECHO]);
  expect(d2).toEqual([]);
  const w2echo = await k.gateway.invoke(s.principal, execReq(s, w2.workspaceId, ECHO, {}));
  const unknown = await k.gateway.invoke(s.principal, execReq(s, w2.workspaceId, "nothing.here@1", {}));
  expect(w2echo.state).toBe("blocked");
  expect(w2echo.reasonCode).toBe("CAPABILITY_NOT_AVAILABLE");
  expect(w2echo.reasonCode).toBe(unknown.reasonCode);
  expect(w2echo.payload).toEqual(unknown.payload);

  // (d) disabled and quarantined plugins are denied, audited, and their code never executes.
  const roCalls = fx().calls["fx-plugin-ro@1.0.0"] ?? 0;
  const quCalls = fx().calls["fx-plugin-quarantine@1.0.0"] ?? 0;
  const roRes = await k.gateway.invoke(s.principal, execReq(s, w1.workspaceId, RO, {}));
  const quRes = await k.gateway.invoke(s.principal, execReq(s, w1.workspaceId, QU, {}));
  expect(roRes).toMatchObject({ state: "blocked", reasonCode: "PLUGIN_DISABLED" });
  expect(quRes).toMatchObject({ state: "blocked", reasonCode: "PLUGIN_QUARANTINED" });
  expect(fx().calls["fx-plugin-ro@1.0.0"] ?? 0).toBe(roCalls);
  expect(fx().calls["fx-plugin-quarantine@1.0.0"] ?? 0).toBe(quCalls);
  expect(roCalls + quCalls).toBe(0);
  const denyAudit = (
    await db.admin.query(
      "SELECT subject, reason_code FROM audit_events WHERE action='tool.invoke.denied' AND workspace_id=$1 ORDER BY occurred_at",
      [w1.workspaceId],
    )
  ).rows;
  expect(denyAudit).toEqual([
    { subject: RO, reason_code: "PLUGIN_DISABLED" },
    { subject: QU, reason_code: "PLUGIN_QUARANTINED" },
  ]);

  observe({
    testId: "K12",
    observed: `inspect() == DB ground truth for ${got.length} plugins (diff empty); dep-missing shown disabled: "${depMissing.stateReason}", boot ok; states echo=enabled ro=disabled quarantine=quarantined(3 open incidents); W1 discovery=[${d1.map((c) => c.capability)}], W2 discovery=[]; W2 echo call and unknown capability both -> ${w2echo.reasonCode} with identical payload; disabled -> ${roRes.reasonCode}, quarantined -> ${quRes.reasonCode}; tool side-effect counters ro=${roCalls} quarantine=${quCalls}; 2 deny audit rows`,
    evidence: {
      inspect: got,
      groundTruth: truth,
      diff,
      discoveryW1: d1,
      discoveryW2: d2,
      denyAudit,
      sideEffectCounters: { ro: roCalls, quarantine: quCalls },
    },
  });
});
