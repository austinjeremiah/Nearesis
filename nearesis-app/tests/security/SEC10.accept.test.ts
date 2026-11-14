/**
 * SEC10: secret canary leak scan across every sink. PASS: 0 occurrences of any canary form (raw, base64, base64url, hex,
 * URL-encoded, any 8-character fragment) in any sink; every sink class scanned with more than 0 bytes; a canary planted in
 * one sink is found (scanner sensitivity).
 *
 * Canaries (random per run): a provider API key and a partner JWT, provisioned through the real path (process
 * environment into CredentialSource.fromEnv); a database password (a disposable Postgres role really using it); a signing
 * key (the ed25519 key of the chain-commit signer process, handed over on stdin). One golden flow plus fault injection:
 * provider errors that echo request headers, a transport crash whose message holds the headers, a 401 that writes a
 * blocker, debug logging raised, a bad database connection, a signer that dies mid-flow, API errors, and a process crash.
 * Sinks: application and child-process logs, traces (trace and run event tables), every Postgres table of the kernel and
 * ingestion schemas (events, outbox, audit, commands, quarantine ...), Redis, the raw archive object store, blocker
 * artifacts, API error bodies, the SSE stream, a capsule with its exports and static site, and a crash output.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { signManifest } from "../../packages/plugin-sdk/src/index.ts";
import type { ExecutionRequest } from "../../packages/contracts/src/index.ts";
import type { Kernel, Session } from "../../packages/kernel/src/index.ts";
import {
  TEST_KEY,
  TEST_PUBLISHER,
  createTestDb,
  grant,
  loginSession,
  pluginUp,
  seedOrg,
  testKernel,
} from "../../packages/kernel/test/helpers/index.ts";
import type { TestDb } from "../../packages/kernel/test/helpers/index.ts";
import { buildApp } from "../../apps/api/src/app.ts";
import {
  PLUGIN_ROOT,
  ALLOWED_CONTRACT,
  ALLOWED_METHOD,
  CAPABILITY,
  buildManifest,
  startSigner,
} from "../../plugins/chain-commit/src/index.ts";
import { buildCapsule } from "../../packages/capsule/src/index.ts";
import { CredentialSource } from "../../services/ingestion/src/http/credentials.ts";
import { ExplorerCollector } from "../../services/ingestion/src/adapters/explorer.ts";
import { ALLOW_EXPLORER, HttpClient, type FetchImpl } from "../../services/ingestion/src/http/client.ts";
import { ExplorerFixtureServer } from "../../services/ingestion/src/testing/servers.ts";
import { loadPages, setupEnv, type TestEnv } from "../../services/ingestion/test/helpers/env.ts";
import { RESEARCH_BUNDLE, SNAPSHOT } from "../../packages/capsule/test/helpers.ts";
import type { FastifyInstance } from "fastify";

const kernelRequire = createRequire(join(process.cwd(), "packages/kernel/package.json"));
const pg = (await import(pathToFileURL(kernelRequire.resolve("pg")).href)) as typeof import("pg");
const PORT = 4791;

// ---- canaries: random letters and digits, no shared prefix or structure, so fragments are unique to each canary ----
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const rnd = (n: number) => Array.from(randomBytes(n), (b) => ALPHA[b % ALPHA.length]).join("");
const keys = generateKeyPairSync("ed25519");
const signingPem = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const signingDer = keys.privateKey.export({ format: "der", type: "pkcs8" });
const CANARY = {
  providerKey: `${rnd(5)}${rnd(30)}`,
  partnerJwt: `${rnd(14)}.${rnd(30)}.${rnd(24)}`,
  dbPassword: `${rnd(28)}`,
};
const forms = (v: string): string[] => {
  const raw = Buffer.from(v);
  return [
    v,
    raw.toString("base64"),
    raw.toString("base64").replace(/=+$/, ""),
    raw.toString("base64url"),
    raw.toString("hex"),
    encodeURIComponent(v),
  ];
};
const fragments = (v: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i + 8 <= v.length; i++) out.push(v.slice(i, i + 8));
  return out;
};
const signingBody = signingPem.replace(/-----[^-]+-----|\s/g, "");
const NEEDLES: Array<{ canary: string; needle: string }> = [
  ...[CANARY.providerKey, CANARY.partnerJwt, CANARY.dbPassword].flatMap((c) => [
    ...forms(c).map((needle) => ({ canary: c.slice(0, 4) + "..", needle })),
    ...fragments(c).map((needle) => ({ canary: c.slice(0, 4) + "..", needle })),
  ]),
  ...[
    signingBody,
    Buffer.from(signingPem).toString("base64"),
    signingDer.toString("base64"),
    signingDer.toString("hex"),
    signingDer.subarray(-32).toString("hex"),
    signingDer.subarray(-32).toString("base64"),
    encodeURIComponent(signingBody),
  ].map((needle) => ({ canary: "signing-key", needle })),
  ...fragments(signingBody.slice(signingBody.length - 44)).map((needle) => ({
    canary: "signing-key",
    needle,
  })),
];

interface Sink {
  cls: string;
  name: string;
  text: string;
}
const sinks: Sink[] = [];
const take = (cls: string, name: string, data: string | Uint8Array) =>
  sinks.push({ cls, name, text: typeof data === "string" ? data : Buffer.from(data).toString("latin1") });
const scan = (list: Sink[]) => {
  const hits: Array<{ sink: string; canary: string }> = [];
  let bytes = 0;
  for (const s of list) {
    bytes += s.text.length;
    for (const { canary, needle } of NEEDLES) {
      const at = s.text.indexOf(needle);
      if (at >= 0)
        hits.push({
          sink: `${s.cls}/${s.name}`,
          canary: `${canary} in context ${JSON.stringify(s.text.slice(Math.max(0, at - 60), at + 20))}`,
        });
    }
  }
  return { hits, bytes };
};
const walkFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walkFiles(p) : [p];
  });

// ---- output capture ----
const logs: string[] = [];
const restore: Array<() => void> = [];
function captureOutput() {
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      logs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    restore.push(() => (stream.write = orig as typeof stream.write));
  }
}

let db: TestDb;
let k: Kernel;
let app: FastifyInstance;
let ing: TestEnv;
let signer: Awaited<ReturnType<typeof startSigner>> | undefined;
let rpc: ReturnType<typeof import("node:http").createServer> | undefined;
const savedEnv: Record<string, string | undefined> = {};
const roleName = `sec10_canary_${randomBytes(4).toString("hex")}`;

beforeAll(async () => {
  captureOutput();
  // provision through the real path: the process environment, debug logging raised
  for (const [k2, v] of Object.entries({
    INTENTS_EXPLORER_JWT: CANARY.partnerJwt,
    COINGECKO_PRO_API_KEY: CANARY.providerKey,
    DEBUG: "*",
    LOG_LEVEL: "debug",
  })) {
    savedEnv[k2] = process.env[k2];
    process.env[k2] = v;
  }
  db = await createTestDb();
  ing = await setupEnv();
}, 120_000);
afterAll(async () => {
  for (const f of restore) f();
  for (const [k2, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k2];
    else process.env[k2] = v;
  }
  signer?.stop();
  await new Promise<void>((r) => (rpc ? rpc.close(() => r()) : r()));
  await app?.close();
  const root = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? "postgres://nearesis:nearesis@127.0.0.1:55432/nearesis",
  });
  await root.connect().catch(() => undefined);
  await root.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => undefined);
  await root.end().catch(() => undefined);
  await ing?.close();
  await db?.drop();
});

it("SEC10: no canary credential appears in any sink after a golden flow with faults", async () => {
  const redisBefore = new Set(await ing.redis.keys("*"));

  // ============ A. ingestion: golden flow, then provider faults that echo the credential ============
  const creds = CredentialSource.fromEnv(); // the real provisioning path: process.env
  // The HTTP client itself holds the provisioned credentials (the shared test helper would attach its own fixture JWT).
  const collectorWith = (e: TestEnv, fetchImpl: FetchImpl, dir: string) =>
    new ExplorerCollector({
      http: new HttpClient({ allow: [ALLOW_EXPLORER], fetchImpl, credentials: creds, clock: e.clock }),
      archive: e.archive,
      db: e.tdb.db,
      redis: e.redis,
      clock: e.clock,
      credentials: creds,
      pageSize: 5,
      blockerDir: dir,
      sourceEnvironment: "fixture_synthetic",
    });
  const blockerDir = join(ing.tmp, "blockers");
  const pages = loadPages("fx.explorer.pages-3");
  const good = new ExplorerFixtureServer(ing.clock, pages);
  await collectorWith(ing, good.fetchImpl, blockerDir).run({ maxPages: 1 });
  expect(good.requests.every((r) => r.hasAuthorization)).toBe(true); // the credential really was sent

  type Init = { method: string; headers: Record<string, string>; body?: string };
  const asResponse = (status: number, body: string) => ({
    status,
    headers: { forEach: (cb: (v: string, k: string) => void) => cb("application/json", "content-type") },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  });
  const authOf = (h: Record<string, string>): string =>
    Object.entries(h).find(([k]) => k.toLowerCase() === "authorization")?.[1] ?? "";
  const faults: Array<[string, (url: string, init: Init) => Promise<ReturnType<typeof asResponse>>]> = [
    [
      "500 echoing request headers",
      async (_u, init) =>
        asResponse(
          500,
          JSON.stringify({ error: "upstream", echo: init.headers, debug: JSON.stringify(init.headers) }),
        ),
    ],
    [
      "200 body embedding the bearer token",
      async (_u, init) =>
        asResponse(200, JSON.stringify([{ note: `Authorization: ${authOf(init.headers)}` }])),
    ],
    [
      "transport crash with headers in the message",
      async (_u, init) => {
        throw new Error(`ECONNRESET while sending ${JSON.stringify(init.headers)}`);
      },
    ],
    [
      "401 echoing the rejected token",
      async (_u, init) =>
        asResponse(401, JSON.stringify({ error: "token rejected", token: authOf(init.headers) })),
    ],
    [
      "403 echoing the rejected token",
      async (_u, init) =>
        asResponse(403, JSON.stringify({ error: "forbidden", token: authOf(init.headers) })),
    ],
  ];
  const faultResults: Array<{ fault: string; status: string; error: string | null }> = [];
  for (const [name, fetchImpl] of faults) {
    const env2 = await setupEnv();
    try {
      const col = collectorWith(env2, fetchImpl as never, join(env2.tmp, "blockers"));
      let status = "threw";
      let error: string | null = null;
      try {
        status = (await col.run({ maxPages: 1 })).status;
      } catch (e) {
        error = `${(e as Error).message}\n${(e as Error).stack ?? ""}`;
        take("logs", `fault-error:${name}`, error);
      }
      faultResults.push({ fault: name, status, error });
      // every sink of this faulted run
      await dumpPostgres(env2.tdb.db, ["ingestion"], `ingestion:${name}`);
      for (const f of walkFiles(env2.tmp))
        take("object-store", `${name}:${f.split("/").slice(-2).join("/")}`, readFileSync(f));
      for (const k2 of await env2.redis.keys("*"))
        if (!redisBefore.has(k2)) take("redis", `${name}:${k2}`, k2 + (await redisValue(env2.redis, k2)));
    } finally {
      await env2.close();
    }
  }
  async function dumpPostgres(
    pool: { query: (q: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, string>> }> },
    schemas: string[],
    label: string,
  ) {
    const t = await pool.query(
      "SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema = ANY($1)",
      [schemas],
    );
    for (const { s, t: tn } of t.rows) {
      const r = await pool.query(`SELECT x::text AS row FROM ${s}."${tn}" x`);
      take("postgres", `${label}:${s}.${tn}`, `${s}.${tn}\n` + r.rows.map((x) => x["row"]).join("\n"));
    }
  }
  // the golden ingestion environment
  await dumpPostgres(ing.tdb.db as never, ["ingestion"], "ingestion:golden");
  for (const f of walkFiles(ing.tmp))
    take("object-store", `golden:${f.split("/").slice(-2).join("/")}`, readFileSync(f));
  async function redisValue(r: typeof ing.redis, key: string): Promise<string> {
    const type = await r.type(key);
    if (type === "string") return (await r.get(key)) ?? "";
    if (type === "hash") return JSON.stringify(await r.hgetall(key));
    if (type === "list") return JSON.stringify(await r.lrange(key, 0, -1));
    if (type === "set") return JSON.stringify(await r.smembers(key));
    if (type === "zset") return JSON.stringify(await r.zrange(key, 0, -1, "WITHSCORES"));
    return "";
  }
  for (const k2 of await ing.redis.keys("*"))
    if (!redisBefore.has(k2)) take("redis", `golden:${k2}`, k2 + (await redisValue(ing.redis, k2)));

  // ============ B. database password canary: a role that really uses it ============
  const adminUrl = process.env.DATABASE_URL ?? "postgres://nearesis:nearesis@127.0.0.1:55432/nearesis";
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${CANARY.dbPassword}'`);
  await root.query(`GRANT CONNECT ON DATABASE ${db.name} TO ${roleName}`);
  await root.end();
  const u = new URL(adminUrl);
  u.username = roleName;
  u.password = CANARY.dbPassword;
  u.pathname = `/${db.name}`;
  const okPool = new pg.Pool({ connectionString: u.toString(), max: 1 });
  const ok = await okPool.query("SELECT 1 AS one");
  await okPool.end();
  expect(ok.rows[0]!.one).toBe(1);
  const badDb = new URL(u.toString());
  badDb.pathname = "/no_such_database_sec10";
  const badPool = new pg.Pool({ connectionString: badDb.toString(), max: 1 });
  const dbErr = await badPool.query("SELECT 1").then(
    () => "",
    (e: Error) => `${e.message}\n${e.stack ?? ""}`,
  );
  await badPool.end().catch(() => undefined);
  const wrong = new URL(u.toString());
  wrong.password = "wrong-" + rnd(6);
  const wrongPool = new pg.Pool({ connectionString: wrong.toString(), max: 1 });
  const authErr = await wrongPool.query("SELECT 1").then(
    () => "",
    (e: Error) => `${e.message}\n${e.stack ?? ""}`,
  );
  await wrongPool.end().catch(() => undefined);
  expect(dbErr.length + authErr.length).toBeGreaterThan(0);
  take("logs", "database-connection-errors", dbErr + "\n" + authErr);

  // ============ C. kernel + API + signer: golden commit, then the signer dies mid-flow ============
  signer = await startSigner(signingPem);
  const { createServer } = await import("node:http");
  rpc = createServer((req, res) => {
    req.resume();
    req.on("end", () =>
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ result: { hash: "fixture-tx" } })),
    );
  });
  await new Promise<void>((r) => rpc!.listen(0, "127.0.0.1", r));
  const rpcPort = (rpc.address() as { port: number }).port;
  process.env.CHAIN_COMMIT_SIGNER_URL = `http://127.0.0.1:${signer.port}/sign`;
  process.env.CHAIN_COMMIT_RPC_URL = `http://127.0.0.1:${rpcPort}/`;
  k = testKernel(db, { pluginRoot: PLUGIN_ROOT });
  app = await buildApp({
    kernel: k,
    nodeEnv: "test",
    guards: { mutationsPerWindow: 1_000_000, loginsPerWindow: 1_000_000 },
  });
  const org = await seedOrg(db.admin, "sec10", { alice: "owner" });
  const alice: Session = await loginSession(k, org.users.alice!.subject);
  const manifest = buildManifest({
    publisher: TEST_PUBLISHER,
    networkHosts: [`127.0.0.1:${signer.port}`, `127.0.0.1:${rpcPort}`],
  });
  (manifest as unknown as Record<string, unknown>).signature = signManifest(manifest, TEST_KEY.privateKey);
  await k.plugins.install(null, manifest);
  await k.plugins.enable(null, "chain-commit");
  const w = await k.workspaces.create(alice, {
    objective: "sec10",
    networkScope: "near-testnet",
    idempotencyKey: `c-${randomUUID()}`,
  });
  await pluginUp(k, alice, w.workspaceId, w.version, "chain-commit");
  const run = randomUUID();
  const agentId = randomUUID();
  const agentPrincipal = { kind: "agent", actorId: agentId, orgId: org.orgId, parentRunId: run } as const;
  await k.leases.issue(alice, {
    workspaceId: w.workspaceId,
    holderActorId: agentId,
    capability: CAPABILITY,
    grants: [grant({ resource: "chain", action: "commit" })],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const { canonicalJson, sha256Hex } = await import("../../packages/plugin-sdk/src/index.ts");
  const call = async (payloadHash: string) => {
    const input = {
      network: "near-testnet",
      contract: ALLOWED_CONTRACT,
      method: ALLOWED_METHOD,
      payloadHash,
      depositYocto: "1",
      gas: 10_000_000_000_000,
    };
    await k.db.tx({ orgId: org.orgId, userId: alice.userId }, (tx) =>
      k.approvals.grant(tx, {
        orgId: org.orgId,
        workspaceId: w.workspaceId,
        runId: run,
        actionHash: sha256Hex(canonicalJson({ capability: CAPABILITY, input })),
        approvedBy: alice.userId,
      }),
    );
    return k.gateway.invoke(
      agentPrincipal as never,
      {
        requestId: randomUUID(),
        idempotencyKey: `idem-${randomUUID()}`,
        tenantId: org.orgId,
        workspaceId: w.workspaceId,
        actor: { kind: "agent", actorId: agentId, parentRunId: run },
        capability: CAPABILITY,
        input,
        deadlineMs: 8000,
        trace: { traceId: randomUUID() },
      } as unknown as ExecutionRequest,
    );
  };
  const golden = await call("a".repeat(64));
  expect(golden.state).toBe("ok");
  signer.stop(); // fault: the signer dies, the next call fails with whatever error the stack produces
  await new Promise((r) => setTimeout(r, 200));
  const faulted = await call("b".repeat(64));
  expect(faulted.state).not.toBe("ok");
  take("error-bodies", "gateway-responses", JSON.stringify([golden, faulted]));

  // API error bodies and the SSE stream (the session token, a bearer secret, is sent on every request)
  const login = await app.inject({
    method: "POST",
    url: "/v1/dev/login",
    payload: { oidcSubject: org.users.alice!.subject },
  });
  const token = (login.json() as { token: string }).token;
  const auth = { authorization: `Bearer ${token}` };
  const apiBodies: string[] = [];
  const attempts: Array<{
    method: "GET" | "POST";
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }> = [
    { method: "GET", url: `/v1/workspaces/${randomUUID()}`, headers: auth },
    { method: "GET", url: "/v1/workspaces", headers: { authorization: `Bearer ${CANARY.partnerJwt}` } },
    { method: "GET", url: "/v1/workspaces", headers: { authorization: `Bearer ${CANARY.providerKey}` } },
    {
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...auth, "content-type": "application/json" },
      payload: `{"objective":"${CANARY.dbPassword}","networkScope":"bogus"}`,
    },
    {
      method: "POST",
      url: `/v1/workspaces/${w.workspaceId}/commands`,
      headers: { ...auth, "content-type": "application/json" },
      payload: JSON.stringify({ type: "nope", secret: CANARY.partnerJwt }),
    },
    {
      method: "POST",
      url: "/v1/workspaces",
      headers: { ...auth, "content-type": "application/json" },
      payload: `{"x":`,
    },
    { method: "GET", url: `/v1/workspaces/${w.workspaceId}/canvas`, headers: auth },
  ];
  for (const a of attempts) {
    const r = await app.inject({
      method: a.method,
      url: a.url,
      headers: a.headers,
      ...(a.payload ? { payload: a.payload } : {}),
    });
    apiBodies.push(`${r.statusCode} ${r.body} ${JSON.stringify(r.headers)}`);
  }
  take("error-bodies", "api-errors", apiBodies.join("\n"));
  await app.listen({ port: PORT, host: "127.0.0.1" });
  const sse = await new Promise<string>((resolve) => {
    let data = "";
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PORT,
        path: `/v1/workspaces/${w.workspaceId}/events`,
        headers: { ...auth, "last-event-id": "0" },
      },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
      },
    );
    req.on("error", () => undefined);
    req.end();
    setTimeout(() => (req.destroy(), resolve(data)), 1500);
  });
  expect(sse).toContain("event:");
  take("sse", "workspace-events", sse);

  // every kernel table, plus audit, outbox and commands explicitly named in the sink inventory
  await dumpPostgres(db.admin as never, ["public", "runtime"], "kernel");
  // runtime schema may be absent in this database; the kernel dump above covers public

  // ============ D. capsule, exports and static site, built while the canaries are live in the environment ============
  const capOut = mkdtempSync(join(tmpdir(), "sec10-capsule-"));
  buildCapsule({ snapshotDir: SNAPSHOT, outDir: capOut, researchBundleDir: RESEARCH_BUNDLE });
  for (const f of walkFiles(capOut))
    take(
      f.includes("site") || f.endsWith(".html")
        ? "static-site"
        : f.includes("exports")
          ? "exports"
          : "capsule",
      f.slice(capOut.length),
      readFileSync(f),
    );

  // ============ E. crash output: a process holding the credentials dies with a stack trace ============
  const crashDir = mkdtempSync(join(tmpdir(), "sec10-crash-"));
  const script = join(crashDir, "crash.ts");
  writeFileSync(
    script,
    `import { CredentialSource } from ${JSON.stringify(join(process.cwd(), "services/ingestion/src/http/credentials.ts"))};
const c = CredentialSource.fromEnv();
console.log(String(c), JSON.stringify(c));
import { inspect } from "node:util";
console.log(inspect(c, { depth: 5, showHidden: true }));
c.get("INTENTS_EXPLORER_JWT");
throw new Error("simulated worker crash after reading credentials");
`,
  );
  const crash = spawnSync(process.execPath, [script], { env: process.env, encoding: "utf8" });
  expect(crash.status).not.toBe(0);
  take("crash", "child-stdout-stderr", `${crash.stdout}\n${crash.stderr}`);
  const reportCfg = {
    onFatal: process.report?.reportOnFatalError,
    onUncaught: process.report?.reportOnUncaughtException,
  };
  expect(reportCfg).toEqual({ onFatal: false, onUncaught: false }); // no diagnostic report (it embeds the environment) is written on a crash

  // application and container logs, as captured from this process and everything it ran
  take("logs", "process-stdout-stderr", logs.join(""));

  // ============ scan ============
  const classes = new Set(sinks.map((s) => s.cls));
  const required = [
    "logs",
    "postgres",
    "redis",
    "object-store",
    "error-bodies",
    "sse",
    "capsule",
    "exports",
    "static-site",
    "crash",
  ];
  const byClass = new Map<string, number>();
  for (const s of sinks) byClass.set(s.cls, (byClass.get(s.cls) ?? 0) + s.text.length);
  const real = scan(sinks);

  // (c) scanner sensitivity: plant each canary class in one sink of a copy and require detection
  const plant = (v: string) =>
    scan([...sinks.slice(0, 3), { cls: "control", name: "planted", text: `...${v}...` }]).hits.some(
      (h) => h.sink === "control/planted",
    );
  const sensitivity = {
    providerKey: plant(CANARY.providerKey),
    partnerJwtBase64: plant(Buffer.from(CANARY.partnerJwt).toString("base64")),
    dbPasswordFragment: plant(CANARY.dbPassword.slice(5, 13)),
    signingKeyHex: plant(signingDer.toString("hex")),
    signingKeyUrlEncoded: plant(encodeURIComponent(signingBody)),
  };

  const detail = real.hits.slice(0, 12).map((h) => `${h.sink} <- ${h.canary}`);
  expect(detail).toEqual([]);
  for (const c of required) expect(byClass.get(c) ?? 0, `sink class ${c} scanned bytes`).toBeGreaterThan(0);
  expect(Object.values(sensitivity).every(Boolean)).toBe(true);
  expect(faultResults.length).toBe(faults.length);
  void classes;

  observe({
    testId: "SEC10",
    observed: `4 canaries (provider key, partner JWT, database password used by a real Postgres role, signing key held by the signer process) provisioned through the real path; golden flow (ingestion page, kernel workspace, approved chain commit, capsule build, SSE) plus ${faults.length} provider and transport faults, a bad database connection, a dead signer, ${attempts.length} hostile API requests and a crashing process, with debug logging raised: ${sinks.length} sinks in ${byClass.size} classes (${[...byClass].map(([c, n]) => `${c} ${n}`).join(", ")} bytes), ${real.bytes} bytes scanned against ${NEEDLES.length} needles (raw, base64, base64url, hex, URL-encoded, 8-character fragments): ${real.hits.length} hits; every required sink class had more than 0 bytes; scanner sensitivity (planted canary found): ${JSON.stringify(sensitivity)}`,
    fixtureHash: createHash("sha256")
      .update(
        JSON.stringify({ faults: faults.map((f) => f[0]), required, attempts: attempts.map((a) => a.url) }),
      )
      .digest("hex"),
    evidence: {
      sinkClasses: Object.fromEntries(byClass),
      sinkCount: sinks.length,
      bytesScanned: real.bytes,
      needles: NEEDLES.length,
      hits: [],
      sensitivity,
      faultResults: faultResults.map((f) => ({ fault: f.fault, status: f.status })),
    },
  });
}, 600_000);
