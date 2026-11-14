import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { observe } from "@nearesis/acceptance";
import { runFlow } from "./lib/flow.ts";
import { openStack, q, stopIfBlocked, type Stack } from "./lib/stack.ts";

let s: Stack;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => s?.close(), 120_000);

it("B04: with every installed plugin connected, each agent tool call's provenance references the plugin version that served it", async () => {
  if (await stopIfBlocked(s, "B04", "the real-stack flow")) return;
  const f = await runFlow(s);
  const ws = f.workspaceId;
  const admin = s.env.kernel!.kernelAdmin;
  const inst = (
    await admin.query<{ id: string; plugin_id: string; version: string; state: string }>(
      "SELECT id, plugin_id, version, state FROM plugin_installations ORDER BY plugin_id",
    )
  ).rows;
  const enabledInWs = (
    await admin.query<{ plugin_id: string }>(
      "SELECT plugin_id FROM workspace_plugins WHERE workspace_id=$1 AND enabled",
      [ws],
    )
  ).rows.map((r) => r.plugin_id);
  // all installed plugins are connected: enabled platform-wide and in the workspace
  expect(inst.length).toBeGreaterThanOrEqual(2);
  for (const i of inst) expect(i.state, i.plugin_id).toBe("enabled");
  expect(enabledInWs.sort()).toEqual(inst.map((i) => i.plugin_id).sort());

  const inv = (
    await admin.query<{
      capability: string;
      plugin_version: string | null;
      installation_id: string | null;
      state: string;
      actor_id: string;
    }>(
      "SELECT capability, plugin_version, installation_id, state, actor_id FROM tool_invocations WHERE workspace_id=$1 AND state='ok'",
      [ws],
    )
  ).rows;
  expect(inv.length).toBeGreaterThan(5);
  const byInst = new Map(inst.map((i) => [i.id, i]));
  const used = new Set<string>();
  for (const r of inv) {
    expect(r.plugin_version, r.capability).toBeTruthy();
    expect(r.plugin_version).not.toBe("0.0.0");
    const owner = byInst.get(r.installation_id ?? "");
    expect(owner, `installation of ${r.capability}`).toBeTruthy();
    expect(r.plugin_version).toBe(owner!.version); // provenance version equals the installed manifest version
    used.add(owner!.plugin_id);
  }
  // both connected plugins actually served calls of this one workspace's flow
  expect([...used].sort()).toEqual(inst.map((i) => i.plugin_id).sort());
  // task provenance: agent invocations are attributed to the tasks of the runs of this workspace
  const taskIds = new Set(
    (await q<{ id: string }>(s.env, s.env.tenantId, "SELECT id FROM tasks WHERE workspace_id=$1", [ws])).map(
      (t) => t.id,
    ),
  );
  const agentCalls = inv.filter((r) => taskIds.has(r.actor_id));
  expect(agentCalls.length).toBeGreaterThan(2);
  const agentPlugins = new Set(agentCalls.map((r) => byInst.get(r.installation_id ?? "")!.plugin_id));
  expect(agentPlugins.size).toBeGreaterThanOrEqual(1);

  // negative control: a call that resolves to no plugin carries version 0.0.0 and unresolved provenance, and is detected by the same check
  const denied = await s.env.kernel!.kernel.gateway.invoke(s.env.kernel!.session.principal, {
    requestId: crypto.randomUUID(),
    idempotencyKey: `idem-${crypto.randomUUID()}`,
    tenantId: s.env.kernel!.orgId,
    workspaceId: ws,
    actor: { kind: "human", actorId: s.env.kernel!.userId },
    capability: "nonexistent.tool@1",
    input: {},
    deadlineMs: 5000,
    trace: { traceId: crypto.randomUUID() },
  } as never);
  const prov = (denied as { provenance?: { pluginId: string; pluginVersion: string } }).provenance;
  expect(denied.state).not.toBe("ok");
  expect(prov?.pluginVersion === "0.0.0" || prov === undefined).toBe(true);

  observe({
    testId: "B04",
    fixtureHash: createHash("sha256")
      .update(JSON.stringify(inst.map((i) => `${i.plugin_id}@${i.version}`)))
      .digest("hex"),
    observed: `${inst.length} installed plugins (${inst.map((i) => `${i.plugin_id}@${i.version}`).join(", ")}) all enabled and connected to the workspace; ${inv.length} successful tool invocations of the flow each carry plugin_version equal to the installed manifest version of the installation that served them (0 unresolved), served by ${[...used].join(" and ")}; ${agentCalls.length} of them attributed to agent tasks; a call to an unknown capability is refused with unresolved provenance (${prov?.pluginId ?? "none"}@${prov?.pluginVersion ?? "none"}).`,
    evidence: { installed: inst, invocations: inv.length, used: [...used], unresolvedControl: prov ?? null },
  });
}, 600_000);
