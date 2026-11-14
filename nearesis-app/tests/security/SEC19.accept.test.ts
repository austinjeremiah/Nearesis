/**
 * SEC19: tenant isolation on every non-SQL surface, and the service-role exceptions. PASS: 0 bytes of tenant A reach
 * tenant B on any surface, A's existing and non-existent ids answer identically, every Redis and object-store key
 * carries the tenant namespace, the application role is NOSUPERUSER NOBYPASSRLS with an exact service-role table list,
 * and A's cache entry is not served to B for an identical query.
 * Real API, real Postgres (RLS), real Cube/ClickHouse/Redis gateway, real object store and memory store, two tenants with
 * deliberately colliding titles and sequential ids. Surfaces: (1) SSE with Last-Event-ID replay, (2) Yjs collaboration,
 * (3) runs and workflow identifiers, (4) semantic cache, (5) agent memory, (6) object store, (7) Redis key space,
 * (8) workspace, canvas and graph reads. The service role is audited from the live catalog against a frozen list.
 */
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { buildApp } from "../../apps/api/src/app.ts";
import { createTestDb, seedOrg, testKernel } from "../../packages/kernel/test/helpers/index.ts";
import type { TestDb } from "../../packages/kernel/test/helpers/index.ts";
import { ObjectStore } from "../../packages/kernel/src/history/objects.ts";
import { makePool, migrate as migrateRuntime } from "../../packages/workflow/src/index.ts";
import { createTestDatabase, type TestDatabase } from "../../packages/workflow/src/db.ts";
import { MemoryNotFound, MemoryStore } from "../../packages/agent-runtime/src/index.ts";
import { buildCacheKey } from "../../packages/semantic-gateway/src/cache.ts";
import { ast, setupEnv, W1, W2, type Env } from "../../packages/semantic-gateway/test/helpers.ts";
import { baseline } from "../../services/analytics/src/index.ts";
import type { FastifyInstance } from "fastify";

const require = createRequire(join(process.cwd(), "packages/kernel/package.json"));
const Redis = (
  (await import(
    pathToFileURL(
      createRequire(join(process.cwd(), "packages/semantic-gateway/package.json")).resolve("ioredis"),
    ).href
  )) as {
    Redis: new (url: string) => {
      keys(p: string): Promise<string[]>;
      get(k: string): Promise<string | null>;
      quit(): Promise<unknown>;
    };
  }
).Redis;
void require;
const PORT = 4791;

// Frozen before any run: the service-role (SECURITY DEFINER) functions and the tables each may touch.
const SERVICE_ROLE: Record<string, string[]> = {
  auth_resolve_subject: ["users", "memberships"],
  outbox_claim: ["outbox", "workspace_events"],
  outbox_settle: ["outbox"],
  operator_plugin_dependents: ["workspace_plugins"],
  operator_repin_workspaces: ["workspace_plugins"],
  monitor_open_tasks: ["marker_tasks"],
  monitor_rules_for_source: ["monitor_rules"],
  // migration 014 (verified-state write path): the single writer; it refuses non-verifier callers and a workspace outside the caller org
  // migration 016 (release gate): tenant-bound; signer and reviewer must be distinct human owners or admins of the caller org
  release_waiver_sign: ["memberships", "release_waivers"],
  verified_state_record: ["verification_states", "verifier_identities", "workspaces"],
};
// Tables without row-level security that the application role may read: platform-level, no tenant content.
const GLOBAL_TABLES = new Set([
  "monitor_scheduler_lease",
  "monitor_scheduler_lease_history",
  "plugin_incidents",
  "plugin_installations",
  "public_assets",
  "source_watermark_events",
  "verifier_identities", // select-only registry of verifier actor ids (migration 014)
]);

let db: TestDb;
let app: FastifyInstance;
let gwEnv: Env;
let memDb: TestDatabase;
beforeAll(async () => {
  db = await createTestDb();
  const pool = makePool(db.adminUrl, 2);
  try {
    await migrateRuntime(pool);
  } finally {
    await pool.end();
  }
  app = await buildApp({
    kernel: testKernel(db),
    nodeEnv: "test",
    guards: { mutationsPerWindow: 1_000_000, loginsPerWindow: 1_000_000 },
  });
  memDb = await createTestDatabase();
  gwEnv = await setupEnv(baseline());
}, 180_000);
afterAll(async () => {
  await app?.close();
  await gwEnv?.close();
  await memDb?.drop();
  await db?.drop();
});

const sans = (body: string): string => body.replace(/"traceId":"[^"]*"/g, '"traceId":"-"');
const hex = (n = 6) => randomUUID().replace(/-/g, "").slice(0, n);

function sseRead(token: string, path: string, lastEventId: string, ms: number): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        path,
        headers: { authorization: `Bearer ${token}`, "last-event-id": lastEventId },
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("error", () => undefined);
      },
    );
    req.on("error", () => undefined);
    req.end();
    setTimeout(() => {
      req.destroy();
      resolve(data);
    }, ms);
  });
}

it("SEC19: tenant B reaches 0 bytes of tenant A on every non-SQL surface, and the service role is exactly as declared", async () => {
  const surfaces: Record<string, { probes: number; leakedBytes: number }> = {};
  const note = (s: string, probes: number, leaked: number) => {
    surfaces[s] = {
      probes: (surfaces[s]?.probes ?? 0) + probes,
      leakedBytes: (surfaces[s]?.leakedBytes ?? 0) + leaked,
    };
  };
  const failures: string[] = [];

  // ---- two tenants with colliding titles ----
  const A = await seedOrg(db.admin, "sec19-a", { alice: "owner" });
  const B = await seedOrg(db.admin, "sec19-b", { bob: "owner" });
  const login = async (subject: string) =>
    (
      (
        await app.inject({ method: "POST", url: "/v1/dev/login", payload: { oidcSubject: subject } })
      ).json() as { token: string }
    ).token;
  const aTok = await login(A.users.alice!.subject);
  const bTok = await login(B.users.bob!.subject);
  const aH = { authorization: `Bearer ${aTok}` };
  const bH = { authorization: `Bearer ${bTok}` };
  const mk = async (h: Record<string, string>) => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...h, "idempotency-key": `ws-${randomUUID()}` },
      payload: { objective: "Quarterly flows (colliding title)", networkScope: "fixture-only" },
    });
    expect(r.statusCode).toBe(201);
    return (r.json() as { workspaceId: string }).workspaceId;
  };
  const aWs = await mk(aH);
  const bWs = await mk(bH);
  const canary = `ALPHA${hex(8)}`; // content only tenant A holds
  const canaries = [canary, aWs, A.orgId, A.users.alice!.userId];
  const leak = (text: string) => canaries.filter((c) => text.includes(c)).length;
  const ghost = randomUUID();

  // A writes content: a collab layout entry carrying the canary, and a run
  const Y = await import(pathToFileURL(require.resolve("yjs")).href);
  const doc = new Y.Doc();
  doc.getMap("layout").set(`panel-${canary}`, { x: 1, y: 2 });
  const upd = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  const w = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${aWs}/collab/layout/updates`,
    headers: { ...aH, "content-type": "application/json" },
    payload: JSON.stringify({ update: upd }),
  });
  expect(w.statusCode).toBeLessThan(300);
  const seedRun = async (tenant: string, ws: string, question: string) => {
    const runId = randomUUID();
    await db.admin.query(
      `INSERT INTO runtime.runs(id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state)
       VALUES ($1,$2,$3,$4,$5,'live',$6,$7,'EXECUTING')`,
      [
        runId,
        tenant,
        ws,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        `investigation-${randomUUID()}-${randomUUID()}`,
      ],
    );
    await db.admin.query(
      "INSERT INTO runtime.run_events(tenant_id, run_id, source, seq, kind, detail) VALUES ($1,$2,'run',1,'note',$3)",
      [tenant, runId, JSON.stringify({ text: question })],
    );
    return runId;
  };
  const aRun = await seedRun(A.orgId, aWs, `question holding ${canary}`);
  const bRun = await seedRun(B.orgId, bWs, "colliding question");

  // identical-answer helper: B asks for A's id and for a non-existent id; the two must match byte for byte (sans traceId)
  const same = async (
    surface: string,
    method: "GET" | "POST",
    mapUrl: (id: string) => string,
    aId: string,
    payload?: unknown,
  ) => {
    const go = (id: string) =>
      app.inject({
        method,
        url: mapUrl(id),
        headers: { ...bH, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
        ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
      });
    const real = await go(aId);
    const none = await go(ghost);
    const identical = real.statusCode === none.statusCode && sans(real.body) === sans(none.body);
    if (!identical)
      failures.push(
        `${surface}: A's id answers ${real.statusCode} but a ghost id ${none.statusCode} (or bodies differ)`,
      );
    const l = leak(real.body);
    if (l) failures.push(`${surface}: ${l} canary forms in the body`);
    note(surface, 1, l);
  };

  // (8) workspace, canvas, graph and history reads
  for (const p of [
    "",
    "/canvas",
    "/graph",
    "/runs",
    "/sources",
    "/branches",
    "/snapshots",
    "/summaries",
    "/revalidation",
    "/comments",
  ])
    await same(`rest:${p || "/"}`, "GET", (id) => `/v1/workspaces/${id}${p}`, aWs);

  // (2) Yjs collaboration
  for (const scope of ["layout", "notes"]) {
    await same(`yjs:state:${scope}`, "GET", (id) => `/v1/workspaces/${id}/collab/${scope}/state`, aWs);
    await same(`yjs:presence:${scope}`, "GET", (id) => `/v1/workspaces/${id}/collab/${scope}/presence`, aWs);
    await same(`yjs:update:${scope}`, "POST", (id) => `/v1/workspaces/${id}/collab/${scope}/updates`, aWs, {
      update: upd,
    });
  }
  const bState = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${bWs}/collab/layout/state`,
    headers: bH,
  });
  note("yjs:own-state", 1, leak(bState.body));
  if (leak(bState.body)) failures.push("yjs: B's own layout state contains A's canary");
  // A's room is untouched by B's rejected update
  const aState = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${aWs}/collab/layout/state`,
    headers: aH,
  });
  expect(aState.body).toContain(canary);

  // (3) runs and workflow identifiers
  await same("runs:get", "GET", (id) => `/v1/runs/${id}`, aRun);
  await same("runs:approvals", "GET", (id) => `/v1/runs/${id}/approvals`, aRun);
  await same("runs:cancel", "POST", (id) => `/v1/runs/${id}/cancel`, aRun, { reason: "x" });
  const bRuns = await app.inject({ method: "GET", url: `/v1/workspaces/${bWs}/runs`, headers: bH });
  note("runs:own-list", 1, leak(bRuns.body) + (bRuns.body.includes(aRun) ? 1 : 0));
  if (!bRuns.body.includes(bRun) || bRuns.body.includes(aRun))
    failures.push("runs: B's list is not exactly B's runs");

  // (1) SSE: B on A's stream is a 404 like a ghost; B's own stream replayed from A's cursor leaks nothing
  await same("sse:subscribe", "GET", (id) => `/v1/workspaces/${id}/events`, aWs);
  await app.listen({ port: PORT, host: "127.0.0.1" });
  const aHead = await sseRead(aTok, `/v1/workspaces/${aWs}/events`, "0", 1200);
  expect(aHead).toContain("event:"); // the stream carries A's events to A (probe is not vacuous)
  for (const last of ["0", "1", "2", "9999", "-1", "abc"]) {
    const body = await sseRead(bTok, `/v1/workspaces/${bWs}/events`, last, 700);
    const l = leak(body);
    if (l) failures.push(`sse: B's stream from Last-Event-ID ${last} carries ${l} A canaries`);
    note("sse:replay", 1, l);
  }
  const crossBody = await sseRead(bTok, `/v1/workspaces/${aWs}/events`, "0", 500);
  note("sse:cross-stream", 1, leak(crossBody));
  if (leak(crossBody)) failures.push("sse: B subscribing to A's workspace received A bytes");

  // (4) semantic cache: A's cached result is not served to B for an identical query
  const gw = gwEnv.gateway();
  const q = ast();
  const first = await gw.query(W1, q);
  const again = await gw.query(W1, q);
  const other = await gw.query(W2, q);
  const execBefore = gw.stats().executions;
  const otherAgain = await gw.query(W2, q);
  expect(first.ok && again.ok && other.ok && otherAgain.ok).toBe(true);
  if (!(first.ok && again.ok && other.ok && otherAgain.ok)) throw new Error("gateway query failed");
  const cacheOk =
    first.cache === "miss" && again.cache === "hit" && other.cache === "miss" && otherAgain.cache === "hit";
  if (!cacheOk)
    failures.push(
      `cache: ${first.cache}/${again.cache}/${other.cache}/${otherAgain.cache}, expected miss/hit/miss/hit`,
    );
  expect(gw.stats().executions).toBe(execBefore); // the repeat for B was a hit on B's own entry
  expect(first.cacheKey).not.toBe(other.cacheKey);
  note("cache", 4, other.cache === "hit" ? 1 : 0);
  // negative control: a cache keyed without tenant collides, i.e. would serve A's entry to B
  const parts = (t: string, ws: string) => ({
    tenantId: t,
    workspaceId: ws,
    aclClasses: ["member"],
    semanticVersion: "1.0.0",
    semanticModelHash: "h".repeat(12),
    sourceVintage: "v",
    queryHash: "q".repeat(32),
  });
  const tenantless = (t: string, ws: string) =>
    buildCacheKey({ ...parts(t, ws), tenantId: "", workspaceId: "" });
  const controlCollides = tenantless("t1", "w1") === tenantless("t2", "w2");
  const realDiffers = buildCacheKey(parts("t1", "w1")) !== buildCacheKey(parts("t2", "w2"));

  // (7) Redis key space: every semantic cache key carries a tenant and workspace namespace, and a guessed key is empty
  const redis = new Redis("redis://127.0.0.1:56379");
  const keys = await redis.keys("semantic:*");
  const badKeys = keys.filter((k) => {
    const [, kind, tenant, workspace] = k.split(":");
    return kind === "q" ? !tenant || !workspace : false;
  });
  const mine = keys.filter((k) => ["t1", "t2"].includes(k.split(":")[2] ?? ""));
  if (mine.length < 2) failures.push("redis: this run's cache entries are missing from the key space");
  const guessed = await redis.get(
    `semantic:q:t2:w2:${"0".repeat(12)}:1.0.0:${"0".repeat(12)}:v:${"0".repeat(32)}`,
  );
  await redis.quit();
  if (badKeys.length)
    failures.push(`redis: keys without tenant namespace: ${badKeys.slice(0, 3).join(" | ")}`);
  if (guessed !== null) failures.push("redis: a guessed key returned data");
  note("redis", keys.length, badKeys.length);

  // (5) memory recall: tenant A's memory is not recalled, fetched or distinguished by tenant B
  const mem = new MemoryStore(memDb.app);
  const [tA, wA, tB, wB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const { withTenant } = await import("../../packages/workflow/src/db.ts");
  await withTenant(memDb.app, tA, (c) =>
    c.query(
      "INSERT INTO agent_evidence_refs (tenant_id, workspace_id, evidence_id, tombstoned) VALUES ($1,$2,'E1',false)",
      [tA, wA],
    ),
  );
  const mId = await mem.store(
    { tenantId: tA, workspaceId: wA, role: "skeptic" },
    { scope: "workspace", tier: "semantic", content: `memory ${canary}`, evidenceId: "E1" },
  );
  const nsB = { tenantId: tB, workspaceId: wB, role: "skeptic" };
  const recalled = await mem.recall(nsB, canary);
  const errOf = (id: string) =>
    mem.get(nsB, id).then(
      () => null,
      (e: Error) => e,
    );
  const eReal = await errOf(mId);
  const eGhost = await errOf(randomUUID());
  const sameNs = await mem.recall({ tenantId: tA, workspaceId: wB, role: "skeptic" }, canary); // right tenant, wrong workspace
  if (recalled.length || sameNs.length) failures.push("memory: recall crossed the namespace");
  if (
    !(eReal instanceof MemoryNotFound) ||
    !(eGhost instanceof MemoryNotFound) ||
    eReal.message !== eGhost.message
  )
    failures.push("memory: A's memory id is distinguishable from a ghost id");
  note("memory", 4, recalled.length + sameNs.length);

  // (6) object store: content-addressed per organisation; a hash guessed from A's bytes returns nothing to B
  const store = new ObjectStore(testKernel(db).db);
  const sA = await testKernel(db).identity.resolveSession(aTok);
  const sB = await testKernel(db).identity.resolveSession(bTok);
  const bytes = Buffer.from(`object holding ${canary}`);
  const put = await store.put(sA, bytes);
  const bGet = await store.get(sB, put.hash);
  const bGhost = await store.get(sB, createHash("sha256").update(randomUUID()).digest("hex"));
  const aGet = await store.get(sA, put.hash);
  const bPut = await store.put(sB, bytes);
  const rows = await db.admin.query<{ org_id: string; n: string }>(
    "SELECT org_id, count(*) n FROM raw_objects WHERE hash = $1 GROUP BY org_id",
    [put.hash],
  );
  const noOrg = Number(
    (await db.admin.query<{ n: string }>("SELECT count(*) n FROM raw_objects WHERE org_id IS NULL")).rows[0]!
      .n,
  );
  if (bGet !== null || bGhost !== null)
    failures.push("object store: B read A's object or distinguished a ghost hash");
  if (!aGet || Buffer.from(aGet).toString() !== bytes.toString())
    failures.push("object store: A cannot read its own object");
  if (bPut.hash !== put.hash || rows.rowCount !== 2 || noOrg !== 0)
    failures.push("object store: keys are not namespaced per organisation");
  note("objects", 4, bGet === null ? 0 : 1);

  // ---- service role and roles (c) ----
  const role = (
    await db.admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='nearesis_app'",
    )
  ).rows[0]!;
  const bypassers = (
    await db.admin.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolbypassrls AND NOT rolsuper",
    )
  ).rows;
  const tables = (
    await db.admin.query<{ s: string; t: string; rls: boolean; frc: boolean; sel: boolean }>(
      `SELECT n.nspname s, c.relname t, c.relrowsecurity rls, c.relforcerowsecurity frc, has_table_privilege('nearesis_app', c.oid, 'SELECT') sel
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','runtime') AND c.relkind='r'`,
    )
  ).rows;
  const granted = tables.filter((t) => t.sel);
  const unprotected = granted
    .filter((t) => !(t.rls && t.frc) && !GLOBAL_TABLES.has(t.t))
    .map((t) => `${t.s}.${t.t}`);
  const denied = tables
    .filter((t) => !t.sel)
    .map((t) => `${t.s}.${t.t}`)
    .sort();
  const globalCols = (
    await db.admin.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1) AND column_name IN ('org_id','tenant_id','workspace_id','user_id')`,
      [[...GLOBAL_TABLES]],
    )
  ).rows;
  const definers = (
    await db.admin.query<{ proname: string; src: string }>(
      "SELECT p.proname, p.prosrc src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef AND n.nspname IN ('public','runtime')",
    )
  ).rows;
  const tableNames = tables.map((t) => t.t);
  const definerRefs: Record<string, string[]> = {};
  for (const d of definers)
    definerRefs[d.proname] = tableNames.filter((t) => new RegExp(`\\b${t}\\b`).test(d.src)).sort();
  const driftFns = Object.keys(definerRefs)
    .filter((f) => !(f in SERVICE_ROLE))
    .concat(Object.keys(SERVICE_ROLE).filter((f) => !(f in definerRefs)));
  const driftRefs = Object.entries(definerRefs).filter(
    ([f, r]) => SERVICE_ROLE[f] && JSON.stringify(r) !== JSON.stringify([...SERVICE_ROLE[f]!].sort()),
  );
  // with no tenant context, the application role sees nothing in a tenant table and is refused on migrations
  const noCtx = await db.app.tx(
    { orgId: randomUUID(), userId: randomUUID(), actorKind: "user" },
    async (tx) => ({
      outbox: Number((await tx.query<{ n: string }>("SELECT count(*) n FROM outbox")).rows[0]!.n),
      events: Number((await tx.query<{ n: string }>("SELECT count(*) n FROM workspace_events")).rows[0]!.n),
    }),
  );
  const truth = Number(
    (await db.admin.query<{ n: string }>("SELECT count(*) n FROM workspace_events")).rows[0]!.n,
  );
  const migrationsDenied = await db.app
    .tx({ orgId: randomUUID(), userId: randomUUID(), actorKind: "user" }, (tx) =>
      tx.query("SELECT 1 FROM schema_migrations"),
    )
    .then(
      () => false,
      () => true,
    );
  if (role.rolsuper || role.rolbypassrls) failures.push("roles: application role is superuser or BYPASSRLS");
  if (bypassers.length)
    failures.push(`roles: non-superuser roles with BYPASSRLS: ${bypassers.map((b) => b.rolname).join(",")}`);
  if (unprotected.length)
    failures.push(`rls: granted tables without forced RLS and not declared global: ${unprotected.join(",")}`);
  if (globalCols.length) failures.push(`global tables carry tenant columns: ${JSON.stringify(globalCols)}`);
  if (driftFns.length || driftRefs.length)
    failures.push(`service role drift: ${JSON.stringify({ driftFns, driftRefs })}`);
  if (noCtx.outbox !== 0 || noCtx.events !== 0 || truth === 0)
    failures.push(`rls: foreign tenant context sees ${JSON.stringify(noCtx)} of ${truth} events`);
  if (!migrationsDenied) failures.push("grants: application role can read schema_migrations");

  // negative controls
  expect(controlCollides).toBe(true);
  expect(realDiffers).toBe(true);
  expect(failures).toEqual([]);
  for (const k of [
    "rest:/",
    "yjs:state:layout",
    "runs:get",
    "sse:subscribe",
    "cache",
    "redis",
    "memory",
    "objects",
  ])
    expect(
      surfaces[k] ?? surfaces[Object.keys(surfaces).find((s) => s.startsWith(k.split(":")[0]!))!],
      k,
    ).toBeDefined();
  const totalProbes = Object.values(surfaces).reduce((n, s) => n + s.probes, 0);
  const totalLeak = Object.values(surfaces).reduce((n, s) => n + s.leakedBytes, 0);
  expect(totalLeak).toBe(0);

  observe({
    testId: "SEC19",
    observed: `2 tenants with the same workspace title: ${totalProbes} probes by B across 8 surfaces (REST, Yjs state/presence/updates, runs and workflow ids, SSE subscribe and Last-Event-ID replay 0/1/2/9999/-1/abc, semantic cache, agent memory, object store, Redis keys) leaked ${totalLeak} A canary forms; A's existing id and a ghost id answered identically on every id-addressed probe; cache miss/hit/miss/hit with distinct keys (tenant-less control key collides: ${controlCollides}); ${keys.length} Redis semantic keys all tenant and workspace namespaced, guessed key empty; object rows per org for A's bytes: ${rows.rowCount}, 0 rows without org; application role super=${role.rolsuper} bypassrls=${role.rolbypassrls}, 0 other BYPASSRLS roles; ${granted.length} granted tables, ${granted.length - GLOBAL_TABLES.size} with forced RLS and ${GLOBAL_TABLES.size} declared platform-level with no tenant columns; ${denied.length} tables denied (${denied.join(", ")}); ${definers.length} SECURITY DEFINER service-role functions equal the declared list with exact table sets; foreign tenant context sees 0 of ${truth} events`,
    fixtureHash: createHash("sha256")
      .update(JSON.stringify({ SERVICE_ROLE, GLOBAL: [...GLOBAL_TABLES].sort() }))
      .digest("hex"),
    evidence: {
      surfaces,
      serviceRole: definerRefs,
      deniedTables: denied,
      globalTables: [...GLOBAL_TABLES].sort(),
      redisKeys: keys.length,
    },
  });
}, 600_000);
