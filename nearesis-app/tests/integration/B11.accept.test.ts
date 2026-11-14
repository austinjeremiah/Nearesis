import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { observe } from "@nearesis/acceptance";
import type { PluginManifest } from "../../packages/contracts/src/index.ts";
import { signManifest } from "../../packages/plugin-sdk/src/index.ts";
import {
  NEAR_THESIS_DESCRIPTOR,
  POINT_TYPES,
  PLUGIN_ROOT,
  activateDescriptor,
  buildManifest,
  engineInterfaces,
  schemaSha,
  type Descriptor,
} from "../../plugins/near-thesis/src/index.ts";
import {
  TEST_KEY,
  TEST_PUBLISHER,
  createTestDb,
  createWs,
  execReq,
  loginSession,
  seedOrg,
  testKernel,
  type TestDb,
} from "../../packages/kernel/test/helpers/index.ts";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** ch.25 "Typed capability dependency graph", vendored (a drift check runs when the Bible is present). */
const CH25_REQUIRES = [
  "kernel.workspace@1",
  "kernel.agent_supervisor@1",
  "semantic.catalog@1",
  "research.experiment_registry@1",
  "canvas.panel_compiler@1",
  "evidence.provenance@1",
];
const CH25_USES = [
  "data.near.bigquery@1",
  "data.near.oneclick_explorer@1",
  "data.near.oneclick_quotes@1",
  "data.price.daily@1",
  "data.near.contract_registry@1",
  "model.near.predictive_thesis@1",
  "verify.outlayer@1",
  "publish.static@1",
  "publish.memo@1",
];

/** The kernel and agent runtime must reference capability ids only, never a concrete near-thesis module. */
export function findPluginImports(source: string): string[] {
  const re = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']*near-thesis[^"']*)["']/g;
  return [...source.matchAll(re)].map((m) => m[1]!);
}
function walk(dir: string, skip: string[]): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (skip.includes(n)) return [];
    return statSync(p).isDirectory() ? walk(p, skip) : /\.(ts|mts|mjs)$/.test(n) ? [p] : [];
  });
}

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => db?.drop(), 60_000);

function signed(over: Partial<PluginManifest> & { pluginId?: string }): PluginManifest {
  const m = { ...buildManifest({ publisher: TEST_PUBLISHER }), ...over } as Record<string, unknown>;
  delete m.signature;
  m.signature = signManifest(m as unknown as PluginManifest, TEST_KEY.privateKey);
  return m as unknown as PluginManifest;
}

it("B11: near-thesis registers five point types, activation checks the capability graph, and missing dependencies disable it with a readable reason", async () => {
  // (a) five point types, five required fields each, graph equals ch.25 as sets
  const engine = engineInterfaces(APP);
  const act = activateDescriptor(NEAR_THESIS_DESCRIPTOR, engine, APP);
  expect(act.rejected).toEqual([]);
  expect(act.state).toBe("enabled");
  const counts: Record<string, number> = {};
  for (const t of POINT_TYPES) {
    const regs = NEAR_THESIS_DESCRIPTOR.registrations[t];
    expect(regs.length, t).toBeGreaterThan(0);
    counts[t] = regs.length;
    for (const r of regs) {
      for (const f of ["requiredGrant", "apiVersion", "schemaSha", "sourceDocument", "fixture"] as const)
        expect(r[f], `${t}/${r.id}.${f}`).toBeTruthy();
      expect(r.schemaSha).toBe(schemaSha(r.schema));
      expect(existsSync(join(APP, r.fixture)), r.fixture).toBe(true);
    }
  }
  expect(counts).toEqual({
    dataPacks: 5,
    semanticViews: 5,
    researchTemplates: 3,
    agentTasks: 4,
    publisherTemplates: 3,
  });
  expect(new Set(NEAR_THESIS_DESCRIPTOR.requires)).toEqual(new Set(CH25_REQUIRES));
  expect(new Set(NEAR_THESIS_DESCRIPTOR.uses)).toEqual(new Set(CH25_USES));
  const ch25 = resolve(APP, "..", "NEARESIS_Build_Bible/chapters/25_BOUNTY_PLUGIN_PIPELINE.md");
  if (existsSync(ch25)) {
    const t = readFileSync(ch25, "utf8");
    for (const r of CH25_REQUIRES) expect(t, `ch.25 drift: ${r}`).toContain(`requires ${r}`);
    for (const u of CH25_USES) expect(t, `ch.25 drift: ${u}`).toContain(u);
  }

  // (b) a missing required interface disables the plugin with a readable dependency list and the app stays up
  const reduced = new Set(engine);
  reduced.delete("semantic.catalog@1");
  const off = activateDescriptor(NEAR_THESIS_DESCRIPTOR, reduced, APP);
  expect(off.state).toBe("disabled");
  expect(off.unmet).toEqual(["semantic.catalog@1"]);
  expect(off.reason).toContain("semantic.catalog@1");
  // and through the real kernel plugin manager: a manifest requiring an interface the engine lacks is installed disabled
  const org = await seedOrg(db.admin, "b11", { alice: "owner" });
  const k = testKernel(db, { pluginRoot: PLUGIN_ROOT });
  await k.boot();
  const s = await loginSession(k, org.users.alice!.subject);
  const good = signed({ pluginId: "near-thesis-b11-good" });
  const broken = signed({ pluginId: "near-thesis-b11-broken", requires: ["semantic.catalog@1"] });
  await k.plugins.install(s.principal.actorId, good);
  await k.plugins.install(s.principal.actorId, broken);
  const rows = (
    await db.admin.query<{ plugin_id: string; state: string; state_reason: string | null }>(
      "SELECT plugin_id, state, state_reason FROM plugin_installations WHERE plugin_id LIKE 'near-thesis-b11-%' ORDER BY plugin_id",
    )
  ).rows;
  const byId = Object.fromEntries(rows.map((r) => [r.plugin_id, r]));
  expect(byId["near-thesis-b11-broken"]!.state).toBe("disabled");
  expect(byId["near-thesis-b11-good"]!.state).not.toBe("disabled");
  expect(String(byId["near-thesis-b11-broken"]!.state_reason ?? "")).toContain("semantic.catalog@1");
  expect(await k.db.ping()).toBe(true); // the app is still up

  // (c) a registration lacking a schema SHA is rejected
  const lacking: Descriptor = structuredClone(NEAR_THESIS_DESCRIPTOR);
  lacking.registrations.semanticViews[0]!.schemaSha = null;
  const rej = activateDescriptor(lacking, engine, APP);
  expect(rej.rejected).toEqual([
    expect.objectContaining({
      type: "semanticViews",
      id: "near_usage",
      reason: expect.stringContaining("schemaSha"),
    }),
  ]);
  const wrong: Descriptor = structuredClone(NEAR_THESIS_DESCRIPTOR);
  wrong.registrations.agentTasks[0]!.schemaSha = "0".repeat(64);
  expect(activateDescriptor(wrong, engine, APP).rejected).toHaveLength(1);

  // (d) a director request for a capability it holds no lease for is denied by the kernel and audited; the workspace is unaffected
  const w = await createWs(k, s, "b11 ungranted");
  const before = await k.workspaces.get(s, w.workspaceId);
  const agent = { kind: "agent" as const, actorId: crypto.randomUUID(), parentRunId: crypto.randomUUID() };
  const denied = await k.gateway.invoke(
    {
      kind: "agent",
      actorId: agent.actorId,
      orgId: s.principal.orgId,
      parentRunId: agent.parentRunId,
    } as never,
    execReq(s, w.workspaceId, "semantic.query@1", {}, { actor: agent } as never),
  );
  expect(denied.state).not.toBe("ok");
  const aud = await db.admin.query<{ action: string; outcome: string; actor_id: string }>(
    "SELECT action, outcome, actor_id FROM audit_events WHERE workspace_id=$1 AND outcome='denied' AND actor_id=$2",
    [w.workspaceId, agent.actorId],
  );
  expect(aud.rows.length).toBeGreaterThanOrEqual(1);
  const after = await k.workspaces.get(s, w.workspaceId);
  expect(after.version).toBe(before.version);

  // (e) static check: kernel and agent runtime import no concrete near-thesis class
  const scan = [join(APP, "packages/kernel/src"), join(APP, "packages/agent-runtime/src")].flatMap((d) =>
    walk(d, ["testing", "node_modules"]),
  );
  const offenders = scan.flatMap((f) =>
    findPluginImports(readFileSync(f, "utf8")).map((i) => `${f.slice(APP.length + 1)} -> ${i}`),
  );
  expect(scan.length).toBeGreaterThan(30);
  expect(offenders).toEqual([]);
  // negative control: a kernel file with a direct plugin import is caught
  expect(findPluginImports(`import { composeCanvas } from "@nearesis/near-thesis";`)).toEqual([
    "@nearesis/near-thesis",
  ]);
  expect(
    findPluginImports(`const m = await import("../../../plugins/near-thesis/src/entry.ts");`),
  ).toHaveLength(1);
  // out-of-scope observation recorded: the workflow package (not named in (e)) does import the plugin
  const wf = walk(join(APP, "packages/workflow/src"), ["node_modules"]).filter(
    (f) => findPluginImports(readFileSync(f, "utf8")).length,
  );

  observe({
    testId: "B11",
    fixtureHash: createHash("sha256").update(JSON.stringify(NEAR_THESIS_DESCRIPTOR)).digest("hex"),
    observed: `near-thesis registers ${JSON.stringify(counts)} (5 point types, 5 fields each, schemaSha recomputed, fixtures exist); requires/uses sets equal ch.25 (${CH25_REQUIRES.length}/${CH25_USES.length}); with semantic.catalog@1 removed the descriptor activates disabled ("${off.reason}") and the real kernel manager installs a manifest requiring it as disabled (reason "${byId["near-thesis-b11-broken"]!.state_reason}") while the kernel stays up; a registration without schemaSha and one with a wrong sha are rejected; an agent calling semantic.query@1 without a lease was ${denied.state}, audited (${aud.rows.length} audit row(s)), workspace version unchanged (${before.version}); static scan of ${scan.length} kernel and agent-runtime source files (testing/ excluded): 0 near-thesis imports, detector catches a planted import. Note: packages/workflow imports the plugin in ${wf.length} file(s) (outside the criterion).`,
    evidence: {
      counts,
      offenders,
      scanned: scan.length,
      workflowImports: wf.map((f) => f.slice(APP.length + 1)),
      denied: denied.state,
      disabled: byId,
    },
  });
}, 300_000);
