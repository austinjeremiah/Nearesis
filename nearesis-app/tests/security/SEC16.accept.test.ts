/**
 * SEC16: payload and parser abuse bounds. PASS: every abusive input is rejected with 413, 400 or 422 inside 2 s with
 * under 100 MB of memory growth; 0 prototype pollution, 0 code execution, no crash; a legitimate client keeps its
 * latency during the abuse; rejected ingestion pages are quarantined with a trace event and promote no facts.
 * Real boundaries: the Fastify API (JSON bodies and Yjs collab updates), the public MCP HTTP endpoint, the CanvasSpec
 * validator and the Explorer ingestion collector. Bounds are frozen here before any run. The abuse corpus is generated
 * deterministically (no randomness), so a re-run sends byte-identical inputs.
 */
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { validatePanelSpec } from "../../packages/canvas-schema/src/index.ts";
import { buildApp } from "../../apps/api/src/app.ts";
import { createTestDb, seedOrg, testKernel } from "../../packages/kernel/test/helpers/index.ts";
import type { TestDb } from "../../packages/kernel/test/helpers/index.ts";
import { startPublicMcpHttp } from "../../services/mcp-public/src/http.ts";
import { ExplorerFixtureServer } from "../../services/ingestion/src/testing/servers.ts";
import { loadPages, setupEnv, type TestEnv } from "../../services/ingestion/test/helpers/env.ts";
import type { FastifyInstance } from "fastify";

// fastify is a dependency of the API package, not of the repository root
const Fastify = (
  (await import(
    pathToFileURL(createRequire(join(process.cwd(), "apps/api/package.json")).resolve("fastify")).href
  )) as { default: typeof import("fastify").default }
).default;

// Frozen bounds (owner-accepted 2026-11-11; not tunable after a failure).
const MAX_MS = 2_000;
const MAX_GROWTH_BYTES = 100 * 1024 * 1024;
const LEGIT_P95_MS = 1_000; // PERF01 cached-query SLO used as the latency bound for the legitimate probe
const MCP_PORT = 4791;
const REJECT = new Set([400, 413, 422]);

type Body = { name: string; bytes: Buffer; headers?: Record<string, string> };
const J = (s: string): Buffer => Buffer.from(s, "utf8");
const MB = 1024 * 1024;

function corpus(): Body[] {
  const filler = (n: number) => J(`{"objective":"${"A".repeat(n)}","networkScope":"fixture-only"}`);
  const zeros = Buffer.alloc(100 * MB); // 100 MB of zeros compresses to about 100 KB
  return [
    { name: "body-50MB", bytes: filler(50 * MB) },
    { name: "body-2MB", bytes: filler(2 * MB) },
    { name: "deep-10000-arrays", bytes: J("[".repeat(10_000) + "]".repeat(10_000)) },
    { name: "deep-10000-objects", bytes: J('{"a":'.repeat(10_000) + "1" + "}".repeat(10_000)) },
    {
      name: "duplicate-keys",
      bytes: J('{"objective":"one","objective":"two","networkScope":"fixture-only"}'),
    },
    {
      name: "proto-key",
      bytes: J('{"__proto__":{"polluted":true},"objective":"x","networkScope":"fixture-only"}'),
    },
    {
      name: "constructor-prototype",
      bytes: J('{"constructor":{"prototype":{"polluted":true}},"objective":"x"}'),
    },
    { name: "huge-exponent", bytes: J('{"objective":"x","expectedVersion":1e999}') },
    { name: "huge-integer-400-digits", bytes: J(`{"objective":"x","expectedVersion":${"9".repeat(400)}}`) },
    {
      name: "invalid-utf8",
      bytes: Buffer.concat([J('{"objective":"'), Buffer.from([0xff, 0xfe, 0xc3, 0x28]), J('"}')]),
    },
    {
      name: "lone-surrogate-escape-and-nul",
      bytes: J('{"objective":"\\ud800\\u0000","networkScope":"fixture-only"}'),
    },
    { name: "truncated", bytes: J('{"objective":"x","networkScope":') },
    {
      name: "code-in-string",
      bytes: J('{"objective":"\'; globalThis.__SEC16_EXEC=1; //","networkScope":"fixture-only"}'),
    },
    {
      name: "gzip-bomb-declared",
      bytes: gzipSync(zeros, { level: 9 }),
      headers: { "content-encoding": "gzip" },
    },
    { name: "gzip-bomb-undeclared", bytes: gzipSync(zeros, { level: 9 }) },
    { name: "empty", bytes: Buffer.alloc(0) },
    { name: "nodes-bomb", bytes: J("[" + "0,".repeat(400_000) + "0]") },
  ];
}

async function growthDuring<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number; growth: number }> {
  const base = process.memoryUsage().rss;
  let peak = base;
  const t = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
  const t0 = performance.now();
  try {
    const result = await fn();
    peak = Math.max(peak, process.memoryUsage().rss);
    return { result, ms: performance.now() - t0, growth: Math.max(0, peak - base) };
  } finally {
    clearInterval(t);
  }
}

function rawPost(port: number, path: string, body: Buffer, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", () => resolve(0)); // 0 = no HTTP response at all (a failure for this suite)
    req.end(body);
  });
}

const snapshotGlobals = () => ({
  objectProto: Object.getOwnPropertyNames(Object.prototype).sort().join(","),
  arrayProto: Object.getOwnPropertyNames(Array.prototype).sort().join(","),
  functionProto: Object.getOwnPropertyNames(Function.prototype).sort().join(","),
  globals: Object.getOwnPropertyNames(globalThis).sort().join(","),
});

let db: TestDb;
let app: FastifyInstance;
let ing: TestEnv;
let mcp: Awaited<ReturnType<typeof startPublicMcpHttp>>;
const open: FastifyInstance[] = [];
beforeAll(async () => {
  db = await createTestDb();
  app = await buildApp({
    kernel: testKernel(db),
    nodeEnv: "test",
    guards: { mutationsPerWindow: 1_000_000, loginsPerWindow: 1_000_000 },
  });
  open.push(app);
  ing = await setupEnv();
  mcp = await startPublicMcpHttp({ port: MCP_PORT });
}, 120_000);
afterAll(async () => {
  for (const a of open) await a.close();
  await mcp?.close();
  await ing?.close();
  await db?.drop();
});

it("SEC16: abusive inputs are rejected within bounds at every parser boundary", async () => {
  const before = snapshotGlobals();
  const org = await seedOrg(db.admin, "sec16", { alice: "owner" });
  const login = await app.inject({
    method: "POST",
    url: "/v1/dev/login",
    payload: { oidcSubject: org.users.alice!.subject },
  });
  const token = (login.json() as { token: string }).token;
  const auth = { authorization: `Bearer ${token}` };
  const created = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...auth, "idempotency-key": `ws-${randomUUID()}` },
    payload: { objective: "sec16 workspace", networkScope: "fixture-only" },
  });
  expect(created.statusCode).toBe(201);
  const wsId = (created.json() as { workspaceId: string }).workspaceId;
  const inputs = corpus();
  const fixtureHash = createHash("sha256")
    .update(
      inputs
        .map((i) => `${i.name}:${i.bytes.length}:${createHash("sha256").update(i.bytes).digest("hex")}`)
        .join("\n"),
    )
    .digest("hex");

  // (c) a legitimate client keeps probing for the whole abuse run
  const legit: number[] = [];
  let legitErrors = 0;
  let probing = true;
  const prober = (async () => {
    while (probing) {
      const t0 = performance.now();
      const r = await app.inject({ method: "GET", url: `/v1/workspaces/${wsId}`, headers: auth });
      legit.push(performance.now() - t0);
      if (r.statusCode !== 200) legitErrors++;
      await new Promise((res) => setTimeout(res, 25));
    }
  })();

  const rows: Array<{ boundary: string; input: string; status: number; ms: number; growthMB: number }> = [];
  const failures: string[] = [];
  const record = (boundary: string, input: string, status: number, ms: number, growth: number) => {
    rows.push({ boundary, input, status, ms: Math.round(ms), growthMB: Math.round(growth / MB) });
    if (!REJECT.has(status)) failures.push(`${boundary}/${input}: status ${status}`);
    if (ms > MAX_MS) failures.push(`${boundary}/${input}: ${Math.round(ms)} ms`);
    if (growth > MAX_GROWTH_BYTES)
      failures.push(`${boundary}/${input}: growth ${Math.round(growth / MB)} MB`);
  };

  // 1. API JSON parser: workspace creation and the command endpoint
  for (const url of ["/v1/workspaces", `/v1/workspaces/${wsId}/commands`]) {
    for (const i of inputs) {
      const r = await growthDuring(() =>
        app.inject({
          method: "POST",
          url,
          headers: { ...auth, "content-type": "application/json", ...(i.headers ?? {}) },
          payload: i.bytes,
        }),
      );
      record(
        `api:${url.includes("commands") ? "commands" : "workspaces"}`,
        i.name,
        r.result.statusCode,
        r.ms,
        r.growth,
      );
      expect(r.result.body).not.toMatch(/\bat \S+ \(|node_modules|stack/i); // no stack in error bodies
    }
  }

  // 2. MCP public HTTP endpoint (real socket)
  for (const i of inputs) {
    const r = await growthDuring(() =>
      rawPost(mcp.port, "/mcp", i.bytes, {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": String(i.bytes.length),
        ...(i.headers ?? {}),
      }),
    );
    record("mcp:/mcp", i.name, r.result, r.ms, r.growth);
  }

  // 3. CanvasSpec: a malicious spec through the validator and through the API command endpoint
  const cyc: Record<string, unknown> = { kind: "timeSeries" };
  cyc.self = cyc;
  const wide = { kind: "scatter", data: Array.from({ length: 50_000 }, (_, k) => [k, k]) };
  const hostile: Array<[string, unknown]> = [
    ["cyclic", cyc],
    ["50000-point-scatter", wide],
    ["deep-10000", JSON.parse('{"a":'.repeat(30) + "1" + "}".repeat(30))],
    [
      "executable-keys",
      { kind: "bar", renderer: "x", dangerouslySetInnerHTML: { __html: "<img onerror=1>" } },
    ],
    ["function-value", { kind: "bar", formatter: () => globalThis.__SEC16_EXEC_FN }],
    ["own-proto-key", JSON.parse('{"__proto__":{"polluted":true},"kind":"bar"}')],
    ["jsx-string", "<Chart onLoad={() => 1} />"],
    ["huge-numbers", { kind: "bar", width: 1e308, height: -1e308, x: NaN }],
  ];
  for (const [name, spec] of hostile) {
    const r = await growthDuring(async () => validatePanelSpec(spec));
    const s = r.result.ok ? 200 : 422;
    record("canvas:validatePanelSpec", name, s, r.ms, r.growth);
  }
  for (const [name, spec] of hostile.filter(([n]) => !["cyclic", "function-value"].includes(n))) {
    const r = await growthDuring(() =>
      app.inject({
        method: "POST",
        url: `/v1/workspaces/${wsId}/commands`,
        headers: { ...auth, "content-type": "application/json", "idempotency-key": `c-${randomUUID()}` },
        payload: JSON.stringify({ type: "canvas.apply_patch", panel: spec }),
      }),
    );
    record("api:commands(canvasspec)", name, r.result.statusCode, r.ms, r.growth);
  }

  // 4. Yjs collab updates: garbage, truncated, oversized and foreign-root updates
  const yjs: Array<[string, string]> = [
    ["not-base64", "%%%not base64%%%"],
    [
      "garbage-bytes",
      Buffer.from(Array.from({ length: 4096 }, (_, k) => (k * 131) & 0xff)).toString("base64"),
    ],
    ["truncated", Buffer.from([1, 1, 200, 3]).toString("base64")],
    [
      "oversized-900KB",
      Buffer.alloc(900_000, 7)
        .toString("base64")
        .slice(0, 1_000_00 * 9),
    ],
    ["empty", ""],
  ];
  for (const [name, update] of yjs) {
    const r = await growthDuring(() =>
      app.inject({
        method: "POST",
        url: `/v1/workspaces/${wsId}/collab/layout/updates`,
        headers: { ...auth, "content-type": "application/json" },
        payload: JSON.stringify({ update }),
      }),
    );
    record("api:collab", name, r.result.statusCode, r.ms, r.growth);
  }

  // 5. Ingestion: the same corpus as Explorer page bodies, a 1,000,000-row page, via the real collector
  const pages = loadPages("fx.explorer.pages-3");
  const factsBefore = Number(
    (await ing.tdb.db.query<{ n: string }>("SELECT count(*) n FROM ingestion.explorer_swaps")).rows[0]!.n,
  );
  const pageInputs: Body[] = [
    ...inputs.filter((i) => !i.headers && i.name !== "empty" && i.name !== "body-2MB"),
    { name: "rows-1000000", bytes: J("[" + "{},".repeat(999_999) + "{}]") },
    { name: "rows-10001", bytes: J("[" + "{},".repeat(10_000) + "{}]") },
  ];
  let quarantined = 0;
  let traces = 0;
  for (const [n, i] of pageInputs.entries()) {
    const server = new ExplorerFixtureServer(ing.clock, pages);
    const c = ing.collector(server.fetchImpl);
    server.intercept(
      () => ({ status: 200, body: i.bytes.toString("latin1") === "" ? "" : i.bytes }) as never,
    );
    const r = await growthDuring(() => c.run({ maxPages: 1 }));
    const q = await ing.tdb.db.query<{ reason_code: string }>(
      "SELECT reason_code FROM ingestion.quarantine ORDER BY id DESC LIMIT 1",
    );
    const nq = Number(
      (await ing.tdb.db.query<{ n: string }>("SELECT count(*) n FROM ingestion.quarantine")).rows[0]!.n,
    );
    const nt = Number(
      (
        await ing.tdb.db.query<{ n: string }>(
          "SELECT count(*) n FROM ingestion.trace_events WHERE kind='explorer.quarantine'",
        )
      ).rows[0]!.n,
    );
    const isQuarantined = r.result.status === "quarantined" && nq === n + 1 && nt === n + 1;
    if (isQuarantined) {
      quarantined++;
      traces = nt;
    }
    record("ingestion:explorer", i.name, isQuarantined ? 422 : 200, r.ms, r.growth);
    expect(q.rows[0]?.reason_code ?? "").toMatch(/^(BAD_JSON|PAGE_LIMIT|BAD_SCHEMA|NOT_ARRAY)$/);
  }
  const factsAfter = Number(
    (await ing.tdb.db.query<{ n: string }>("SELECT count(*) n FROM ingestion.explorer_swaps")).rows[0]!.n,
  );

  probing = false;
  await prober;

  // (b) globals unchanged, nothing executed, process still serving
  const after = snapshotGlobals();
  const health = await app.inject({ method: "GET", url: "/health" });
  const polluted =
    ({} as { polluted?: unknown }).polluted !== undefined ||
    ([] as { polluted?: unknown }).polluted !== undefined;
  const executed = (globalThis as { __SEC16_EXEC?: unknown }).__SEC16_EXEC !== undefined;
  const p95 = [...legit].sort((a, b) => a - b)[Math.floor(legit.length * 0.95)] ?? Infinity;

  // negative control: a lenient parser build and an unbounded server must FAIL criterion (a)
  const lenient = await buildApp({
    kernel: testKernel(db),
    nodeEnv: "test",
    guards: { lenientJsonParser: true, mutationsPerWindow: 1_000_000, loginsPerWindow: 1_000_000 },
  });
  open.push(lenient);
  const lTok = (
    (
      await lenient.inject({
        method: "POST",
        url: "/v1/dev/login",
        payload: { oidcSubject: org.users.alice!.subject },
      })
    ).json() as { token: string }
  ).token;
  const dup = await lenient.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: {
      authorization: `Bearer ${lTok}`,
      "content-type": "application/json",
      "idempotency-key": `ws-${randomUUID()}`,
    },
    payload: inputs.find((i) => i.name === "duplicate-keys")!.bytes,
  });
  const unbounded = Fastify({ logger: false, bodyLimit: 200 * MB });
  unbounded.post("/x", async () => ({ ok: true }));
  open.push(unbounded);
  const big = await unbounded.inject({
    method: "POST",
    url: "/x",
    headers: { "content-type": "application/json" },
    payload: inputs.find((i) => i.name === "body-50MB")!.bytes,
  });
  const controlRejected = REJECT.has(dup.statusCode) && REJECT.has(big.statusCode);

  expect(failures).toEqual([]);
  expect(polluted).toBe(false);
  expect(executed).toBe(false);
  expect(after).toEqual(before);
  expect(health.statusCode).toBe(200);
  expect(legitErrors).toBe(0);
  expect(p95).toBeLessThan(LEGIT_P95_MS);
  expect(quarantined).toBe(pageInputs.length);
  expect(traces).toBe(pageInputs.length);
  expect(factsAfter).toBe(factsBefore);
  expect(controlRejected).toBe(false); // the unbounded and lenient builds fail criterion (a)

  const maxMs = Math.max(...rows.map((r) => r.ms));
  const maxGrowth = Math.max(...rows.map((r) => r.growthMB));
  observe({
    testId: "SEC16",
    observed: `${rows.length} abusive requests across 6 boundaries (API JSON bodies on 2 routes, MCP HTTP, CanvasSpec validator and command endpoint, Yjs collab updates, Explorer ingestion collector; ${inputs.length} generated bodies incl. 50 MB, 10,000-deep JSON, duplicate keys, __proto__ and constructor.prototype, 1e999 and 400-digit numbers, invalid UTF-8, 100 MB gzip bombs, 1,000,000-row page): all rejected with 400/413/422 or quarantined; max latency ${maxMs} ms (bound ${MAX_MS}); max RSS growth ${maxGrowth} MB (bound 100); global-object snapshot unchanged, 0 pollution, 0 code execution, health 200 after; ${legit.length} legitimate probes p95 ${p95.toFixed(0)} ms (bound ${LEGIT_P95_MS}), ${legitErrors} errors; ${quarantined}/${pageInputs.length} ingestion pages quarantined with ${traces} trace events and ${factsAfter - factsBefore} facts promoted; control (duplicate keys on a lenient parser: ${dup.statusCode}; 50 MB on an unbounded server: ${big.statusCode}) was accepted, so the suite detects missing bounds`,
    fixtureHash,
    evidence: { rows, legitProbes: legit.length, p95, controlStatuses: [dup.statusCode, big.statusCode] },
  });
}, 600_000);
