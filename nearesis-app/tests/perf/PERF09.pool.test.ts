/**
 * PERF09 (alternative harness, thresholds in reference-b.json): overload is absorbed by per-tenant caps, bounded queues
 * and visible degradation, never by unbounded memory or silent staleness (ch.13 "Backpressure", ch.16b 6.2). Real kernel +
 * Postgres + API over HTTP. FIXTURE mode. Differs from PERF09.accept.test.ts in that the engine models a SHARED FIFO
 * worker pool (like a Temporal task queue), so cross-tenant harm is measured as time-to-run, not only as ack latency.
 *  (a)+(b) one tenant submits 200 simultaneous investigations; another tenant keeps submitting at a steady rate. Judged:
 *          the saturated tenant never has more agents running than its cap, every refusal is 429 with Retry-After and a
 *          retry hint, the wait queue and process memory stay inside their declared bounds, and the other tenant's
 *          time-to-run p95 stays within the declared factor of its unloaded p95.
 *  (c)     300 SSE clients (raw sockets) on one busy workspace, 20 of them slow (10 late readers that read 200 ms in every 6 s, 10 that never read), while
 *          2000 commands with ~4 KB events commit. Judged: the 280 healthy clients receive every event in order with p95
 *          below the bound; slow clients are served coalesced aggregates and the stuck ones are disconnected; the peak
 *          unflushed bytes on any connection stay below the declared bound; no stream is left open.
 *  (d)     a chart request for 5,000,000 rows is bounded by the max-rows rule with explicit truncation metadata.
 *  (e)     a degraded source: last finalized snapshot served with a warning on every read, publication of current values
 *          blocked, and after restore exactly one cautious probe reaches the source before the breaker closes.
 * Negative control: the same overload run against an API built without per-tenant caps must FAIL (a) and (b).
 * Judgement functions are pure so the control runs the very same code.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { cpus, totalmem } from "node:os";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { ChartData, ErrorResponse, ResultTruncation } from "../../packages/contracts/src/index.ts";
import { boundChartRows } from "../../packages/canvas-schema/src/index.ts";
import { buildApp } from "../../apps/api/src/index.ts";
import type { InvestigationEngine } from "../../apps/api/src/index.ts";
import { DegradationGuard } from "../../apps/api/src/overload/index.ts";
import { MonitorFeeder } from "../../apps/api/src/monitor-feeder.ts";
import type { FeederDeps, WatermarkRow } from "../../apps/api/src/monitor-feeder.ts";
import {
  createTestDb,
  createWs,
  loginSession,
  seedOrg,
  testKernel,
} from "../../packages/kernel/test/helpers/index.ts";
import type { TestDb } from "../../packages/kernel/test/helpers/index.ts";
import type { Kernel, Session } from "../../packages/kernel/src/index.ts";
import { DRYRUN, percentile, sha256Text, stats } from "./_reference.ts";
import { evidenceBase, gateB, histogram, referenceB, thr } from "./_b.ts";

const th = thr("PERF09");
let API_CAPPED = 0; // ephemeral ports: other suites run alongside
let API_UNCAPPED = 0;
const SSE_WORKSPACES = 1;
const COMMANDS_PER_WS = 2000;
const STUCK = th.slowClients! / 2;
const RESUME = th.slowClients! - STUCK;
const B_SAMPLES = 60;
const B_SPACING_MS = 30;
const B_RUN_MS = 20;
const CONTROL_CENSOR_MS = 8000;
const SSE_OPTIONS = {
  maxPerClient: 6,
  slowAfterMs: 300,
  slowDrainTimeoutMs: 10_000,
  slowMaxLag: 5,
  maxTotal: 2000,
};

export const FIXTURE_SPEC = {
  investigations: th.investigations,
  tenantCap: th.tenantCap,
  queuePerTenant: th.queuePerTenant,
  queueGlobal: th.queueGlobal,
  queueTimeoutMs: th.queueTimeoutMs,
  workerPool: th.workerPool,
  runMs: th.runMs,
  otherTenant: { samples: B_SAMPLES, spacingMs: B_SPACING_MS, runMs: B_RUN_MS, censorMs: CONTROL_CENSOR_MS },
  sse: {
    clients: th.sseClients,
    slow: th.slowClients,
    resume: RESUME,
    stuck: STUCK,
    workspaces: SSE_WORKSPACES,
    commandsPerWorkspace: COMMANDS_PER_WS,
    eventBytes: th.sseEventBytes,
    ...SSE_OPTIONS,
  },
  chart: { rows: th.chartRows, maxRows: th.maxRows, series: "sin(i/1000) with one spike and one gap" },
  degradation: { breakerOpenMs: th.breakerOpenMs, probeBurst: th.probeBurst, failureThreshold: 3 },
  bounds: { memoryGrowthMaxMiB: th.memoryGrowthMaxMiB, sseBufferedBytesMax: th.sseBufferedBytesMax },
  otherTenantP95Factor: th.otherTenantP95Factor,
};

/** Pure judgements (the negative control runs the same code). */
export const capHolds = (peakRunning: number, cap: number) => peakRunning <= cap;
export const refusalsAreRetryable = (r: Array<{ status: number; retryAfter: number | null }>) =>
  r.every((x) => x.status === 202 || (x.status === 429 && x.retryAfter !== null && x.retryAfter >= 1));
export const isolationHolds = (baseP95: number, overloadP95: number, factor: number) =>
  overloadP95 <= baseP95 * factor;

const p95 = (xs: number[]) =>
  percentile(
    [...xs].sort((a, b) => a - b),
    95,
  );
const phase = (m: string) => {
  if (DRYRUN) process.stderr.write(`PHASE ${new Date().toISOString().slice(11, 23)} ${m}\n`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number) => {
  const t = Date.now();
  while (!cond() && Date.now() - t < ms) await sleep(20);
  return cond();
};

// ---- the engine: a shared FIFO worker pool, as Temporal's task queue is -----------------------------------------------
class PoolEngine implements InvestigationEngine {
  private queue: Array<{ runId: string; tenantId: string; ms: number }> = [];
  private active = 0;
  private stopped = false;
  private timers = new Set<NodeJS.Timeout>();
  readonly execStart = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();
  readonly runningByTenant = new Map<string, number>();
  readonly peakByTenant = new Map<string, number>();
  constructor(
    private readonly admin: TestDb["admin"],
    private readonly slots: number,
    private readonly msFor: (tenantId: string) => number,
  ) {}
  async start(i: {
    runId: string;
    tenantId: string;
    workspaceId: string;
    investigationId: string;
    questionId: string;
    budgetId: string;
  }) {
    const workflowId = `investigation-${i.investigationId}-${i.questionId}`;
    await this.admin.query(
      `INSERT INTO runtime.runs(id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state)
       VALUES ($1,$2,$3,$4,$5,'live',$6,$7,'EXECUTING') ON CONFLICT (id) DO NOTHING`,
      [i.runId, i.tenantId, i.workspaceId, i.investigationId, i.questionId, i.budgetId, workflowId],
    );
    this.queue.push({ runId: i.runId, tenantId: i.tenantId, ms: this.msFor(i.tenantId) });
    this.pump();
    return { runId: i.runId, workflowId };
  }
  async signal() {}
  private pump() {
    while (!this.stopped && this.active < this.slots && this.queue.length) {
      const j = this.queue.shift()!;
      this.active++;
      const n = (this.runningByTenant.get(j.tenantId) ?? 0) + 1;
      this.runningByTenant.set(j.tenantId, n);
      this.peakByTenant.set(j.tenantId, Math.max(this.peakByTenant.get(j.tenantId) ?? 0, n));
      this.execStart.set(j.runId, performance.now());
      this.waiters.get(j.runId)?.forEach((w) => w());
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.active--;
        this.runningByTenant.set(j.tenantId, (this.runningByTenant.get(j.tenantId) ?? 1) - 1);
        void this.admin
          .query("UPDATE runtime.runs SET state = 'COMPLETE' WHERE id = $1", [j.runId])
          .catch(() => undefined)
          .then(() => this.pump());
      }, j.ms);
      this.timers.add(t);
    }
  }
  /** Resolves with the time the run began executing, or null after `censorMs`. */
  whenStarted(runId: string, censorMs: number): Promise<number | null> {
    const at = this.execStart.get(runId);
    if (at !== undefined) return Promise.resolve(at);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), censorMs);
      const arr = this.waiters.get(runId) ?? [];
      arr.push(() => {
        clearTimeout(t);
        resolve(this.execStart.get(runId)!);
      });
      this.waiters.set(runId, arr);
    });
  }
  /** Stop everything and mark what is left finished, so the next scenario starts from an empty runtime. */
  async drain(admin: TestDb["admin"]) {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.queue = [];
    await admin.query("UPDATE runtime.runs SET state = 'COMPLETE' WHERE state = 'EXECUTING'");
  }
}

// ---- raw SSE client ------------------------------------------------------------------------------------------------
interface SseConn {
  sock: net.Socket;
  status: () => number;
  ids: number[];
  recvAt: Map<number, number>;
  coalesced: () => number;
  closed: () => boolean;
  close: () => void;
}
function rawSse(base: string, path: string, token: string, clientId: string): SseConn {
  const url = new URL(base + path);
  const sock = net.createConnection({ host: url.hostname, port: Number(url.port) });
  let status = 0;
  let head = "";
  let tail = "";
  let coalesced = 0;
  let closed = false;
  const ids: number[] = [];
  const recvAt = new Map<number, number>();
  sock.on("data", (d) => {
    const now = performance.now();
    const s = d.toString("utf8");
    if (!status) {
      head += s;
      const m = /^HTTP\/1\.1 (\d+)/.exec(head);
      if (m) status = Number(m[1]);
      if (status !== 200) return;
    }
    tail += s;
    let i: number;
    while ((i = tail.indexOf("\n\n")) >= 0) {
      const frame = tail.slice(0, i);
      tail = tail.slice(i + 2);
      const id = /(?:^|\n)id: (\d+)/.exec(frame)?.[1];
      const isCoalesced = /event: coalesced/.test(frame);
      if (isCoalesced) coalesced++;
      if (id !== undefined && !isCoalesced) {
        ids.push(Number(id));
        recvAt.set(Number(id), now);
      }
    }
    if (tail.length > 200_000) tail = tail.slice(-1000);
  });
  sock.on("error", () => undefined);
  sock.on("close", () => (closed = true));
  sock.write(
    `GET ${url.pathname} HTTP/1.1\r\nhost: ${url.host}\r\nauthorization: Bearer ${token}\r\nx-client-id: ${clientId}\r\naccept: text/event-stream\r\n\r\n`,
  );
  return {
    sock,
    status: () => status,
    ids,
    recvAt,
    coalesced: () => coalesced,
    closed: () => closed,
    close: () => sock.destroy(),
  };
}

let db: TestDb;
let k: Kernel;
let engine: PoolEngine;
let cappedApp: Awaited<ReturnType<typeof buildApp>> | null = null;
let uncappedApp: Awaited<ReturnType<typeof buildApp>> | null = null;
const g = gateB(import.meta.url);
let orgA = "";
let tokA = "";
let tokB = "";
let sessA: Session;
let wsQA = "";
let wsQB = "";
const liveConns: SseConn[] = [];
/** 64 pooled keep-alive connections: the OS accept backlog is not what is under test. */
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

/** The apps keep one engine handle; each scenario swaps the pool behind it. */
const engineProxy: InvestigationEngine = {
  start: (i) => engine.start(i),
  signal: () => engine.signal(),
};
const appOptions = (admission: boolean) => ({
  kernel: k,
  engine: engineProxy,
  nodeEnv: "test",
  ssePollMs: 250,
  overload: {
    admission: admission
      ? {
          maxRunningPerTenant: th.tenantCap!,
          maxQueuedPerTenant: th.queuePerTenant!,
          maxQueuedGlobal: th.queueGlobal!,
          queueTimeoutMs: th.queueTimeoutMs!,
          pollMs: 50,
        }
      : (false as const),
    sse: SSE_OPTIONS,
  },
});
const newPool = () => new PoolEngine(db.admin, th.workerPool!, (t) => (t === orgA ? th.runMs! : B_RUN_MS));

beforeAll(async () => {
  if (!g.ok && !DRYRUN) return;
  db = await createTestDb();
  const { migrate: runtimeMigrate, makePool } = await import("../../packages/workflow/src/db.ts");
  const rtPool = makePool(db.adminUrl, 2);
  await runtimeMigrate(rtPool);
  await rtPool.end();
  k = testKernel(db, {}, { stream: { headCacheMs: 100 } });
  await k.boot();
  k.outbox.start();
  const a = await seedOrg(db.admin, "perf09a", { alice: "owner" });
  const b = await seedOrg(db.admin, "perf09b", { bob: "owner" });
  orgA = a.orgId;
  sessA = await loginSession(k, a.users.alice!.subject);
  const sessB = await loginSession(k, b.users.bob!.subject);
  tokA = await k.devAuth!.login(a.users.alice!.subject);
  tokB = await k.devAuth!.login(b.users.bob!.subject);
  wsQA = (await createWs(k, sessA, "perf09 questions A")).workspaceId;
  wsQB = (await createWs(k, sessB, "perf09 questions B")).workspaceId;
  engine = newPool();
  cappedApp = await buildApp(appOptions(true));
  await cappedApp.listen({ host: "127.0.0.1", port: 0 });
  API_CAPPED = (cappedApp.server.address() as { port: number }).port;
}, 180_000);
afterAll(async () => {
  for (const c of liveConns) c.close();
  agent.destroy();
  await engine?.drain(db.admin).catch(() => undefined);
  k?.outbox.stop?.();
  await cappedApp?.close();
  await uncappedApp?.close();
  await db?.drop();
}, 120_000);

const body = () =>
  JSON.stringify({
    question: "Why did fees spike?",
    snapshotPolicy: "live",
    budget: { tokens: 200000, toolCalls: 12, usd: 3 },
  });

interface Submission {
  status: number;
  retryAfter: number | null;
  reasonCode: string | null;
  bodyRetryAfter: number | null;
  validBody: boolean;
  runId: string | null;
  sentAt: number;
}
function submit(port: number, token: string, ws: string): Promise<Submission> {
  const sentAt = performance.now();
  return new Promise((resolve, reject) => {
    const payload = body();
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/v1/workspaces/${ws}/questions`,
        method: "POST",
        agent,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const j = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          const ra = res.headers["retry-after"];
          const status = res.statusCode ?? 0;
          resolve({
            status,
            retryAfter: typeof ra === "string" ? Number(ra) : null,
            reasonCode: typeof j.reasonCode === "string" ? j.reasonCode : null,
            bodyRetryAfter: typeof j.retryAfterSeconds === "number" ? j.retryAfterSeconds : null,
            validBody: status === 429 ? ErrorResponse.safeParse(j).success : true,
            runId: typeof j.runId === "string" ? j.runId : null,
            sentAt,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * The burst is generated in a separate process: with the 200 clients in this process they would compete with the server
 * for the same event loop, and tenant B's measured latency would include the load generator's own CPU.
 */
const BURST_SCRIPT = `
const http = require("node:http");
const [port, token, ws, n, payload] = process.argv.slice(1);
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const one = () => new Promise((resolve) => {
  const sentAt = Date.now();
  const req = http.request({ host: "127.0.0.1", port: Number(port), path: "/v1/workspaces/" + ws + "/questions", method: "POST", agent,
    headers: { authorization: "Bearer " + token, "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      resolve({ status: res.statusCode, retryAfter: res.headers["retry-after"] ?? null, body, ms: Date.now() - sentAt });
    });
  });
  req.on("error", (e) => resolve({ status: 0, retryAfter: null, body: { error: String(e) }, ms: Date.now() - sentAt }));
  req.end(payload);
});
Promise.all(Array.from({ length: Number(n) }, one)).then((r) => { process.stdout.write(JSON.stringify(r)); agent.destroy(); });
`;
function burstInChild(port: number, token: string, ws: string, n: number): Promise<Submission[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", BURST_SCRIPT, String(port), token, ws, String(n), body()], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const out: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.on("error", reject);
    child.on("close", () => {
      try {
        const rows = JSON.parse(Buffer.concat(out).toString("utf8")) as Array<{
          status: number;
          retryAfter: string | null;
          body: Record<string, unknown> | null;
        }>;
        resolve(
          rows.map((r) => ({
            status: r.status,
            retryAfter: r.retryAfter === null ? null : Number(r.retryAfter),
            reasonCode: typeof r.body?.reasonCode === "string" ? r.body.reasonCode : null,
            bodyRetryAfter: typeof r.body?.retryAfterSeconds === "number" ? r.body.retryAfterSeconds : null,
            validBody: r.status === 429 ? ErrorResponse.safeParse(r.body).success : true,
            runId: typeof r.body?.runId === "string" ? r.body.runId : null,
            sentAt: 0,
          })),
        );
      } catch (e) {
        reject(e);
      }
    });
  });
}

interface Overload {
  aStatuses: Submission[];
  peakRunningA: number;
  peakQueued: number;
  peakQueuedTenant: number;
  baseLatency: number[];
  overloadLatency: number[];
  censored: number;
  admittedA: number;
  timeline: Array<{ tMs: number; rssMiB: number; heapMiB: number; queued: number; runningA: number }>;
  rssGrowthMiB: number;
}

/** One full (a)+(b) scenario against `port`: baseline for tenant B, then A's burst while B keeps submitting. */
async function overloadScenario(port: number, app: Awaited<ReturnType<typeof buildApp>>): Promise<Overload> {
  const measureB = async (n: number, censor: number) => {
    const lat: number[] = [];
    let censored = 0;
    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < n; i++) {
      tasks.push(
        submit(port, tokB, wsQB).then(async (sub) => {
          if (sub.status !== 202 || !sub.runId) {
            lat.push(censor);
            censored++;
            return;
          }
          const at = await engine.whenStarted(sub.runId, censor);
          if (at === null) {
            lat.push(censor);
            censored++;
          } else lat.push(at - sub.sentAt);
        }),
      );
      await sleep(B_SPACING_MS);
    }
    await Promise.all(tasks);
    return { lat, censored };
  };

  const timeline: Overload["timeline"] = [];
  const t0 = performance.now();
  const rss0 = process.memoryUsage().rss;
  let peakQueued = 0;
  let peakQueuedTenant = 0;
  let peakRss = rss0;
  const sampler = setInterval(() => {
    const m = process.memoryUsage();
    const st = app.overload.admission?.stats();
    const queued = st?.queuedGlobal ?? 0;
    peakQueued = Math.max(peakQueued, queued);
    peakQueuedTenant = Math.max(peakQueuedTenant, st?.tenants[orgA]?.queued ?? 0);
    peakRss = Math.max(peakRss, m.rss);
    timeline.push({
      tMs: Math.round(performance.now() - t0),
      rssMiB: Math.round(m.rss / 2 ** 20),
      heapMiB: Math.round(m.heapUsed / 2 ** 20),
      queued,
      runningA: engine.runningByTenant.get(orgA) ?? 0,
    });
  }, 50);
  try {
    const base = await measureB(B_SAMPLES, CONTROL_CENSOR_MS);
    // the overload: 200 simultaneous submissions from tenant A while B keeps its steady rate
    const burst = burstInChild(port, tokA, wsQA, th.investigations!);
    const over = await measureB(B_SAMPLES, CONTROL_CENSOR_MS);
    const aStatuses = await burst;
    await sleep(th.queueTimeoutMs! + 500); // let waiters time out and the queue drain
    return {
      aStatuses,
      peakRunningA: engine.peakByTenant.get(orgA) ?? 0,
      peakQueued,
      peakQueuedTenant,
      baseLatency: base.lat,
      overloadLatency: over.lat,
      censored: over.censored,
      admittedA: aStatuses.filter((x) => x.status === 202).length,
      timeline,
      rssGrowthMiB: Math.round((peakRss - rss0) / 2 ** 20),
    };
  } finally {
    clearInterval(sampler);
  }
}

it("PERF09: per-tenant caps, bounded queues, coalesced SSE, max-rows truncation and visible degradation", async () => {
  if (!g.ok && !DRYRUN) {
    observe({ testId: "PERF09", observed: "not executed", blocked: g.reason });
    return;
  }
  const fixtureHash = sha256Text(JSON.stringify(FIXTURE_SPEC));
  if (DRYRUN) process.stderr.write(`FIXTUREHASH PERF09 ${fixtureHash}\n`);
  if (g.ok) expect(referenceB().fixtures.PERF09).toBe(fixtureHash);
  const rss00 = process.memoryUsage().rss;
  const wall0 = Date.now();

  phase("start a+b capped");
  // ================= (a) + (b) with per-tenant caps =================
  const run = await overloadScenario(API_CAPPED, cappedApp!);
  await engine.drain(db.admin);
  const refusals = run.aStatuses.filter((x) => x.status === 429);
  const baseP95 = p95(run.baseLatency);
  const overP95 = p95(run.overloadLatency);
  const aParts = {
    cap: capHolds(run.peakRunningA, th.tenantCap!),
    retryable: refusalsAreRetryable(run.aStatuses),
    only202or429: run.aStatuses.every((x) => x.status === 202 || x.status === 429),
    bodies: refusals.every((x) => x.validBody && x.bodyRetryAfter === x.retryAfter),
    queueGlobal: run.peakQueued <= th.queueGlobal!,
    queueTenant: run.peakQueuedTenant <= th.queuePerTenant!,
    memory: run.rssGrowthMiB <= th.memoryGrowthMaxMiB!,
  };
  const aOk = Object.values(aParts).every(Boolean);
  const bOk = isolationHolds(baseP95, overP95, th.otherTenantP95Factor!) && run.censored === 0;
  const refusalReasons: Record<string, number> = {};
  for (const r of refusals)
    refusalReasons[r.reasonCode ?? "?"] = (refusalReasons[r.reasonCode ?? "?"] ?? 0) + 1;

  phase("start control");
  // ================= negative control: the same load against an API without per-tenant caps =================
  engine = newPool();
  uncappedApp = await buildApp(appOptions(false));
  await uncappedApp.listen({ host: "127.0.0.1", port: 0 });
  API_UNCAPPED = (uncappedApp.server.address() as { port: number }).port;
  const ctl = await overloadScenario(API_UNCAPPED, uncappedApp);
  await engine.drain(db.admin);
  const ctlAFails =
    !capHolds(ctl.peakRunningA, th.tenantCap!) ||
    !refusalsAreRetryable(ctl.aStatuses.filter((x) => x.status !== 202));
  const ctlBFails = !isolationHolds(p95(ctl.baseLatency), p95(ctl.overloadLatency), th.otherTenantP95Factor!);
  await uncappedApp.close();
  uncappedApp = null;
  engine = newPool();

  phase("start sse");
  // ================= (c) SSE: 300 clients, 20 slow =================
  const wsIds: string[] = [];
  for (let w = 0; w < SSE_WORKSPACES; w++)
    wsIds.push((await createWs(k, sessA, `perf09 sse ${w}`)).workspaceId);
  const base = `http://127.0.0.1:${API_CAPPED}`;
  const perWs = th.sseClients! / SSE_WORKSPACES;
  const conns: Array<{ c: SseConn; ws: number; kind: "fast" | "resume" | "stuck" }> = [];
  for (let w = 0; w < SSE_WORKSPACES; w++)
    for (let i = 0; i < perWs; i++) {
      const kind: "fast" | "resume" | "stuck" =
        i < STUCK / SSE_WORKSPACES ? "stuck" : i < (STUCK + RESUME) / SSE_WORKSPACES ? "resume" : "fast";
      const c = rawSse(base, `/v1/workspaces/${wsIds[w]}/events`, tokA, `c${w}-${i}`);
      liveConns.push(c);
      conns.push({ c, ws: w, kind });
      if (conns.length % 25 === 0) await sleep(150); // paced connects: the OS accept backlog is not under test
    }
  expect(await until(() => conns.every((x) => x.c.status() === 200), 60_000)).toBe(true);
  expect(conns.filter((x) => x.kind !== "fast")).toHaveLength(th.slowClients!);
  phase("sse connected");
  const sse0 = cappedApp!.overload.sse.stats();
  for (const x of conns) if (x.kind !== "fast") x.c.sock.pause();
  // late readers trickle: read for 200 ms every 6 s; the socket buffers fill between pulses, so each stall is longer than slowAfterMs but shorter than the drain timeout
  const trickles = conns
    .filter((x) => x.kind === "resume")
    .map((x) =>
      setInterval(() => {
        x.c.sock.resume();
        setTimeout(() => x.c.sock.pause(), 200);
      }, 6000),
    );
  const sseStart = performance.now();
  const sseTimeline: Array<{ tMs: number; rssMiB: number; open: number; peakBufferedKiB: number }> = [];
  const sseSampler = setInterval(() => {
    const st = cappedApp!.overload.sse.stats();
    sseTimeline.push({
      tMs: Math.round(performance.now() - sseStart),
      rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20),
      open: st.open,
      peakBufferedKiB: Math.round(st.peakBufferedBytes / 1024),
    });
  }, 250);
  const big = "x".repeat(th.sseEventBytes!);
  const issued = new Map<number, number[]>();
  const versions: number[] = [];
  for (const ws of wsIds) versions.push((await k.workspaces.get(sessA, ws)).version);
  for (let i = 0; i < COMMANDS_PER_WS; i++) {
    await Promise.all(
      wsIds.map(async (ws, w) => {
        const arr = issued.get(w) ?? [];
        arr.push(performance.now());
        issued.set(w, arr);
        await k.commands.execute(sessA, ws, {
          apiVersion: "v1",
          commandId: randomUUID(),
          commandType: "workspace.update_objective",
          payload: { objective: `${i}-${big}` },
          expectedVersion: versions[w]! + i,
        });
      }),
    );
    await sleep(2);
  }
  phase("sse commands done");
  const heads: number[] = [];
  for (const ws of wsIds)
    heads.push(
      Number(
        (
          await db.admin.query("SELECT coalesce(max(seq),0) m FROM workspace_events WHERE workspace_id=$1", [
            ws,
          ])
        ).rows[0]!.m,
      ),
    );
  const fast = conns.filter((x) => x.kind === "fast");
  await until(() => fast.every((x) => (x.c.ids.at(-1) ?? 0) >= heads[x.ws]!), 60_000);
  await until(() => cappedApp!.overload.sse.stats().slowDropped - sse0.slowDropped >= STUCK, 30_000);
  phase("sse settled");
  clearInterval(sseSampler);
  for (const t of trickles) clearInterval(t);
  const sse1 = cappedApp!.overload.sse.stats();
  // per-event latency of the healthy clients (the k-th workspace.updated event of a workspace is command k)
  const cmdSeqsByWs = new Map<number, number[]>();
  for (let w = 0; w < SSE_WORKSPACES; w++)
    cmdSeqsByWs.set(
      w,
      (
        await db.admin.query(
          "SELECT seq FROM workspace_events WHERE workspace_id=$1 AND event_type='workspace.updated' ORDER BY seq",
          [wsIds[w]],
        )
      ).rows
        .map((q) => Number(q.seq))
        .slice(-COMMANDS_PER_WS),
    );
  const lat: number[] = [];
  let missing = 0;
  let outOfOrder = 0;
  let healthyCoalesced = 0;
  for (const x of fast) {
    healthyCoalesced += x.c.coalesced();
    cmdSeqsByWs.get(x.ws)!.forEach((seq, i) => {
      const r = x.c.recvAt.get(seq);
      if (r === undefined) missing++;
      else lat.push(r - issued.get(x.ws)![i]!);
    });
    for (let i = 1; i < x.c.ids.length; i++) if (x.c.ids[i]! <= x.c.ids[i - 1]!) outOfOrder++;
  }
  const slowConns = conns.filter((x) => x.kind !== "fast");
  const resumeCoalesced = conns.filter((x) => x.kind === "resume").map((x) => x.c.coalesced());
  const stuckClosed = conns.filter((x) => x.kind === "stuck").filter((x) => x.c.closed()).length;
  const sseLat = stats(lat);
  const sseParts = {
    noMissing: missing === 0,
    ordered: outOfOrder === 0,
    healthyNotCoalesced: healthyCoalesced === 0,
    p95: lat.length > 0 && p95(lat) < th.sseP95Ms!,
    coalescedServed: sse1.coalescedFrames > sse0.coalescedFrames,
    resumeGotAggregate: resumeCoalesced.some((n) => n > 0),
    stuckDropped: sse1.slowDropped - sse0.slowDropped >= STUCK,
    buffersBounded: sse1.peakBufferedBytes <= th.sseBufferedBytesMax!,
  };
  const sseOk = Object.values(sseParts).every(Boolean);
  for (const x of conns) x.c.close();
  const openAfter = await until(() => cappedApp!.overload.sse.stats().open === 0, 20_000);
  const sseRssGrowth = Math.round(
    (Math.max(...sseTimeline.map((x) => x.rssMiB)) * 2 ** 20 - rss00) / 2 ** 20,
  );

  phase("start chart");
  // ================= (d) 5,000,000-row chart request =================
  const N = th.chartRows!;
  const SPIKE = 3_333_333;
  const GAP = 1_234_567;
  const y = (i: number): number | null => (i === GAP ? null : i === SPIKE ? 1e9 : Math.sin(i / 1000));
  const heapBeforeChart = process.memoryUsage().heapUsed;
  const tc = performance.now();
  const bounded = boundChartRows({
    count: N,
    rowAt: (i) =>
      [new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString(), y(i)] as [string, number | null],
    yAt: y,
    maxRows: th.maxRows!,
  });
  const chartMs = performance.now() - tc;
  const chartHeapMiB = Math.round((process.memoryUsage().heapUsed - heapBeforeChart) / 2 ** 20);
  const trunc = bounded.truncation ? ResultTruncation.safeParse(bounded.truncation) : null;
  const chartData = ChartData.safeParse({
    panelId: randomUUID(),
    queryHash: "b".repeat(64),
    dataRevision: 1,
    columns: [
      { name: "t", unit: null },
      { name: "v", unit: null },
    ],
    rows: bounded.rows,
    downsampling: bounded.downsampling,
    freshness: "fresh",
    sourceWatermark: null,
    truncation: bounded.truncation,
  });
  const chartOk =
    bounded.rows.length <= th.maxRows! &&
    trunc?.success === true &&
    trunc.data.requestedRows === N &&
    trunc.data.returnedRows === bounded.rows.length &&
    bounded.downsampling.originalPoints === N &&
    bounded.rows.some((r) => r[1] === 1e9) &&
    bounded.rows.some((r) => r[1] === null) &&
    chartData.success;

  phase("start degrade");
  // ================= (e) degraded source =================
  let now = Date.parse("2026-11-12T12:00:00Z");
  const guard = new DegradationGuard<Record<string, number>>({
    failureThreshold: 3,
    openMs: th.breakerOpenMs!,
    now: () => now,
  });
  const SRC = "near-explorer";
  let upstream = 0;
  let sourceUp = true;
  const fetchLive = async () => {
    upstream++;
    if (!sourceUp) throw new Error("source down");
    return { value: { "live.swaps": 42 }, watermark: "2026-11-11T00:00:00.000Z", finalized: true };
  };
  const phases: Array<Record<string, unknown>> = [];
  const healthy = await guard.read(SRC, fetchLive);
  phases.push({ phase: "healthy", servedFrom: healthy.serve.servedFrom, breaker: healthy.serve.breaker });
  sourceUp = false;
  const upstreamBeforeDegraded = upstream;
  const degradedReads = [];
  for (let i = 0; i < 100; i++) degradedReads.push(await guard.read(SRC, fetchLive));
  const upstreamWhileDegraded = upstream - upstreamBeforeDegraded;
  const silent = degradedReads.filter(
    (r) =>
      r.serve.servedFrom !== "last_finalized_snapshot" ||
      !r.serve.warning ||
      r.serve.currentPublicationAllowed,
  ).length;
  const warned = degradedReads.every(
    (r) =>
      r.serve.warning !== undefined &&
      r.serve.warning.asOf === "2026-11-11T00:00:00.000Z" &&
      r.serve.warning.staleSeconds > 0 &&
      r.value["live.swaps"] === 42,
  );
  let publicationBlocked = false;
  try {
    guard.assertCanPublishCurrent(SRC);
  } catch (e) {
    publicationBlocked = (e as { reasonCode?: string }).reasonCode === "STALE_PUBLICATION_BLOCKED";
  }
  // the monitor feeder must not publish a current value of the degraded source either
  const feedRows: WatermarkRow[] = [
    { providerId: SRC, newestEventTime: "2026-11-11 00:00:00.000", state: "fresh", version: 1 },
    { providerId: SRC, newestEventTime: null, state: "unavailable", version: 2 },
    { providerId: SRC, newestEventTime: "2026-11-11 12:00:00.000", state: "late", version: 3 },
  ];
  const published: string[] = [];
  const feedDeps: FeederDeps = {
    now: () => now,
    readWatermarks: async (after) => feedRows.filter((r) => r.version > after),
    metricIdsFor: () => ["live.swaps"],
    metricValue: async () => 42,
    enqueue: async (e) => {
      published.push(e.watermark);
      return { enqueued: true };
    },
    degradation: new DegradationGuard<Record<string, number>>({ openMs: th.breakerOpenMs!, now: () => now }),
  };
  const feedPass = await new MonitorFeeder(feedDeps).pollOnce();
  const feederBlocked = published.length === 1 && feedPass.blockedDegraded === 1;
  phases.push({
    phase: "degraded",
    reads: degradedReads.length,
    upstreamCalls: upstreamWhileDegraded,
    silentStale: silent,
    publicationBlocked,
    feederBlockedWatermarks: feedPass.blockedDegraded,
    breaker: guard.breakerOf(SRC).state,
  });
  // restore the source; before the interval nothing reaches it, after it exactly one probe does
  sourceUp = true;
  const upstreamBeforeRestore = upstream;
  for (let i = 0; i < 20; i++) await guard.read(SRC, fetchLive);
  const earlyCalls = upstream - upstreamBeforeRestore;
  now += th.breakerOpenMs!;
  const upstreamBeforeProbe = upstream;
  const burst = await Promise.all(Array.from({ length: th.probeBurst! }, () => guard.read(SRC, fetchLive)));
  const probeCalls = upstream - upstreamBeforeProbe;
  const liveAfter = burst.filter((r) => r.serve.servedFrom === "live").length;
  const afterReads = await guard.read(SRC, fetchLive);
  const publishAfter = (() => {
    try {
      guard.assertCanPublishCurrent(SRC);
      return true;
    } catch {
      return false;
    }
  })();
  phases.push({
    phase: "restored",
    callsBeforeInterval: earlyCalls,
    probeBurst: th.probeBurst,
    upstreamCallsDuringBurst: probeCalls,
    liveResults: liveAfter,
    breaker: guard.breakerOf(SRC).state,
    nextReadServedFrom: afterReads.serve.servedFrom,
    publicationAllowed: publishAfter,
  });
  const degradeOk =
    healthy.serve.servedFrom === "live" &&
    silent === 0 &&
    warned &&
    upstreamWhileDegraded <= 3 &&
    publicationBlocked &&
    feederBlocked &&
    earlyCalls === 0 &&
    probeCalls === 1 &&
    liveAfter === 1 &&
    guard.breakerOf(SRC).state === "closed" &&
    afterReads.serve.servedFrom === "live" &&
    publishAfter;

  const wallMs = Date.now() - wall0;
  const rssPeak = Math.max(...run.timeline.map((x) => x.rssMiB), ...sseTimeline.map((x) => x.rssMiB));

  if (DRYRUN)
    process.stderr.write(
      "DRYRUN " +
        JSON.stringify({
          a: {
            admitted: run.admittedA,
            refused: refusals.length,
            refusalReasons,
            peakRunningA: run.peakRunningA,
            peakQueued: run.peakQueued,
            peakQueuedTenant: run.peakQueuedTenant,
            rssGrowthMiB: run.rssGrowthMiB,
            parts: aParts,
          },
          b: {
            baseP95: Math.round(baseP95),
            overloadP95: Math.round(overP95),
            censored: run.censored,
            ok: bOk,
          },
          control: {
            admittedA: ctl.admittedA,
            peakRunningA: ctl.peakRunningA,
            baseP95: Math.round(p95(ctl.baseLatency)),
            overloadP95: Math.round(p95(ctl.overloadLatency)),
            censored: ctl.censored,
            aFails: ctlAFails,
            bFails: ctlBFails,
          },
          sse: {
            sseLat,
            missing,
            outOfOrder,
            healthyCoalesced,
            resumeCoalesced,
            stuckClosed,
            stats0: sse0,
            stats1: sse1,
            openAfter,
            parts: sseParts,
            rssGrowth: sseRssGrowth,
          },
          chart: { chartMs: Math.round(chartMs), chartHeapMiB, rows: bounded.rows.length, ok: chartOk },
          degrade: { phases, ok: degradeOk },
          rssPeak,
          wallMs,
        }) +
        "\n",
    );

  expect(ctlAFails).toBe(true); // a build without per-tenant caps must fail (a)
  expect(ctlBFails).toBe(true); // ... and (b)
  expect(aParts).toEqual(Object.fromEntries(Object.keys(aParts).map((x) => [x, true])));
  expect(bOk).toBe(true);
  expect(sseParts).toEqual(Object.fromEntries(Object.keys(sseParts).map((x) => [x, true])));
  expect(openAfter).toBe(true);
  expect(sseRssGrowth).toBeLessThanOrEqual(th.memoryGrowthMaxMiB!);
  expect(chartOk).toBe(true);
  expect(degradeOk).toBe(true);
  if (DRYRUN) return;
  expect(aOk && sseOk).toBe(true);

  const decimate = <T>(xs: T[], n: number) =>
    xs.filter((_, i) => i % Math.max(1, Math.ceil(xs.length / n)) === 0);
  observe({
    testId: "PERF09",
    observed: `(a) one tenant submitted ${th.investigations} simultaneous investigations (cap ${th.tenantCap} running, queue ${th.queuePerTenant}, timeout ${th.queueTimeoutMs} ms, shared pool of ${th.workerPool}): ${run.admittedA} admitted, ${refusals.length} refused 429 with Retry-After (${JSON.stringify(refusalReasons)}); peak running agents ${run.peakRunningA} <= ${th.tenantCap}; peak queue ${run.peakQueuedTenant} for the tenant (bound ${th.queuePerTenant}), ${run.peakQueued} overall (bound ${th.queueGlobal}); process RSS growth ${run.rssGrowthMiB} MiB (bound ${th.memoryGrowthMaxMiB}). (b) other tenant time-to-run p95 ${Math.round(baseP95)} ms alone, ${Math.round(overP95)} ms during the burst (factor ${(overP95 / baseP95).toFixed(2)}, bound ${th.otherTenantP95Factor}). (c) ${th.sseClients} SSE clients, ${th.slowClients} slow (${RESUME} late readers, ${STUCK} stuck), ${SSE_WORKSPACES * COMMANDS_PER_WS} commands of ~${th.sseEventBytes} B events: healthy clients missing ${missing}, out of order ${outOfOrder}, p95 ${sseLat.p95} ms (bound ${th.sseP95Ms}); ${sse1.coalescedFrames - sse0.coalescedFrames} coalesced frames, ${sse1.slowDropped - sse0.slowDropped} stuck clients disconnected; peak unflushed bytes on one connection ${sse1.peakBufferedBytes} (bound ${th.sseBufferedBytesMax}); 0 streams left open. (d) ${N} row chart request returned ${bounded.rows.length} rows (bound ${th.maxRows}) with truncation metadata, spike and gap preserved, in ${Math.round(chartMs)} ms. (e) degraded source: ${degradedReads.length} reads all served the last finalized snapshot with a warning (0 silent), ${upstreamWhileDegraded} upstream calls while the breaker opened, publication of current values blocked (API guard and monitor feeder), after restore ${earlyCalls} calls before the interval and exactly ${probeCalls} probe among ${th.probeBurst} concurrent reads, then breaker closed. Negative control (no per-tenant caps): peak running ${ctl.peakRunningA} > ${th.tenantCap} and other-tenant p95 ${Math.round(p95(ctl.overloadLatency))} ms vs ${Math.round(p95(ctl.baseLatency))} ms alone, judged FAIL (a) and (b) as required`,
    fixtureHash,
    evidence: {
      ...evidenceBase(g, {
        dataset: { id: "perf09 fixture spec", sha256: fixtureHash },
        concurrency: {
          investigations: th.investigations,
          sseClients: th.sseClients,
          slowClients: th.slowClients,
          workerPool: th.workerPool,
        },
        cacheState: "n/a (fresh database)",
      }),
      hardware: { cpu: cpus()[0]!.model, cores: cpus().length, ramGiB: Math.round(totalmem() / 2 ** 30) },
      admission: {
        capped: {
          statuses: Object.fromEntries(
            [202, 429].map((s) => [s, run.aStatuses.filter((x) => x.status === s).length]),
          ),
          refusalReasons,
          peakRunningA: run.peakRunningA,
          peakQueued: run.peakQueued,
          peakQueuedTenant: run.peakQueuedTenant,
          otherTenant: {
            alone: stats(run.baseLatency),
            duringBurst: stats(run.overloadLatency),
            histogramAlone: histogram(run.baseLatency),
            histogramDuringBurst: histogram(run.overloadLatency),
          },
        },
        control: {
          peakRunningA: ctl.peakRunningA,
          admittedA: ctl.admittedA,
          otherTenant: { alone: stats(ctl.baseLatency), duringBurst: stats(ctl.overloadLatency) },
          censoredAtMs: CONTROL_CENSOR_MS,
          censoredSamples: ctl.censored,
          judgedFailA: ctlAFails,
          judgedFailB: ctlBFails,
        },
      },
      timelines: {
        queueMemoryLatency: decimate(run.timeline, 60),
        sse: decimate(sseTimeline, 60),
        rssPeakMiB: rssPeak,
      },
      sse: {
        healthyLatency: sseLat,
        histogram: histogram(lat),
        coalescedFrames: sse1.coalescedFrames - sse0.coalescedFrames,
        slowDropped: sse1.slowDropped - sse0.slowDropped,
        slowEntered: sse1.slowEntered - sse0.slowEntered,
        peakBufferedBytes: sse1.peakBufferedBytes,
        resumeClientsCoalescedFrames: resumeCoalesced,
        slowClients: slowConns.length,
      },
      chart: {
        requestedRows: N,
        returnedRows: bounded.rows.length,
        truncation: bounded.truncation,
        ms: Math.round(chartMs),
      },
      degradation: { phases },
      resourceUse: { wallMs },
      screenshots: "degraded-mode screenshots are frontend evidence (INTEGRATION_QUEUE: PERF09 UI labels)",
    },
  });
}, 1_800_000);
