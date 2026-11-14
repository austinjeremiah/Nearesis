/**
 * PERF09: overload is absorbed by per-tenant caps, bounded queues and visible degradation, never by unbounded memory or
 * silent staleness (ch.13 "Backpressure"; ch.11 SSE; ch.16b 6.2 PERF09). Real kernel + Postgres + API (buildApp with the
 * product's overload layer), mock investigation engine that records runs the way the workflow does and finishes them
 * after a declared duration.
 *
 *  (a) tenant A submits 200 concurrent investigations through POST /questions: running agents never exceed the cap
 *      (read from the engine and from the runtime schema), the excess is queued or refused 429 + Retry-After, the queue
 *      stays within its declared bounds and process heap growth within the declared bound;
 *  (b) tenant B's submission p95 during A's burst stays within the declared factor of B's idle p95;
 *  (c) 300 SSE clients (20 slow: 10 resume late, 10 never read) on one workspace under a command stream: slow clients get
 *      coalesced aggregates, the stuck ones are dropped, per-connection buffering stays bounded, the 280 healthy clients
 *      see every event in order within the SSE propagation bound;
 *  (d) a 5-million-row chart request is limited by the max-rows rule with a visible truncation label;
 *  (e) a degraded source serves the last finalized snapshot with a warning, current publication is blocked (the feeder
 *      publishes nothing), and after the open interval exactly one caller probes; a failed probe re-opens with a doubled
 *      interval; 401/403 never probe.
 * Negative control: the same burst against a build with the per-tenant cap switched off must FAIL (a) and (b).
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { buildApp } from "../../apps/api/src/index.ts";
import type { InvestigationEngine } from "../../apps/api/src/runs.ts";
import { DegradationGuard } from "../../apps/api/src/overload/index.ts";
import { MonitorFeeder } from "../../apps/api/src/monitor-feeder.ts";
import type { FeederDeps, WatermarkRow } from "../../apps/api/src/monitor-feeder.ts";
import { ChartData, ErrorResponse, ResultTruncation } from "../../packages/contracts/src/index.ts";
import type { WatermarkEvent } from "../../packages/contracts/src/index.ts";
import { boundChartRows, DEFAULT_MAX_CHART_ROWS } from "../../packages/canvas-schema/src/index.ts";
import { makePool, migrate as migrateRuntime } from "../../packages/workflow/src/db.ts";
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
import { evidenceBase, gateB, referenceB, thr } from "./_b.ts";

/**
 * Fixture sizes are ch.16b PERF09 step 5. Every other bound is "declared" in tests/perf/reference-b.json (PERF09 block and its
 * `declarations` note), set before the first run and never tuned after a failure.
 */
const P = thr("PERF09");
const LOAD = {
  investigations: P.investigations!,
  sseClients: P.sseClients!,
  slowClients: P.slowClients!,
  chartRows: P.chartRows!,
};
const DECL = {
  maxRunningPerTenant: P.tenantCap!,
  maxQueuedPerTenant: P.queuePerTenant!,
  maxQueuedGlobal: P.queueGlobal!,
  queueTimeoutMs: P.queueTimeoutMs!,
  workerPool: P.workerPool!, // shared mock worker pool: runs of every tenant execute on it
  investigationMs: P.runMs!, // worker time of one mock investigation
  heapGrowthBoundMiB: P.memoryGrowthMaxMiB!,
  otherTenantP95Factor: P.otherTenantP95Factor!,
  sseBufferBoundBytes: P.sseBufferedBytesMax!,
  ssePropagationP95Ms: P.sseP95Ms!,
  sseEventBytes: P.sseEventBytes!,
  maxRows: P.maxRows!,
  breakerOpenMs: P.breakerOpenMs!,
  probeBurst: P.probeBurst!,
  slowDrainTimeoutMs: 20_000, // app option, shortened from the 30 s default so stuck clients are dropped inside the run
  commands: 1200, // about 4.7 MB per client: more than the kernel socket buffers absorb, so paused clients really block
  pacedCommands: 200, // the first 200 at 10/s (steady load, propagation judged here); the other 1000 unpaced (backpressure)
  lateReadAfterMs: 8000, // the 10 late readers resume this long after the unpaced burst starts
  commandSpacingMs: 100, // 10 commands per second, as PERF07
  otherTenantSubmissions: 20,
  otherTenantSpacingMs: 400,
};
const API_PORT = 4743;
const API_PORT_CTL = 4744;
export const FIXTURE_SPEC = { LOAD, DECL };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MiB = 1024 * 1024;

interface BurstResult {
  status: Record<string, number>;
  reasons: Record<string, number>;
  badRetry: number;
  fiveXX: number;
  maxRunningEngine: number;
  maxRunningDb: number;
  peakQueuedGlobal: number;
  peakQueuedTenant: number;
  admitted: number;
  started: number;
  heapGrowthMiB: number;
  rssGrowthMiB: number;
  /** Other tenant: submission to run completion, ms. */
  bIdle: number[];
  bLoad: number[];
  /** Other tenant: start request latency, ms (reported, not judged). */
  bIdlePost: number[];
  bLoadPost: number[];
  timeline: Array<{ t: number; running: number; queued: number; heapMiB: number }>;
}

/** Pure judgements, shared by the real run and the negative control. */
export const judgeA = (
  r: BurstResult,
  cap: number,
  o: { queueTenant: number; queueGlobal: number; heapMiB: number },
) =>
  r.maxRunningEngine <= cap &&
  r.maxRunningDb <= cap &&
  r.fiveXX === 0 &&
  r.badRetry === 0 &&
  (r.status["202"] ?? 0) + (r.status["429"] ?? 0) === LOAD.investigations &&
  r.peakQueuedTenant <= o.queueTenant &&
  r.peakQueuedGlobal <= o.queueGlobal &&
  r.heapGrowthMiB <= o.heapMiB;
export const judgeB = (r: BurstResult, factor: number) => {
  const idle = percentile(
    [...r.bIdle].sort((x, y) => x - y),
    95,
  );
  const load = percentile(
    [...r.bLoad].sort((x, y) => x - y),
    95,
  );
  return r.bIdle.length > 0 && r.bLoad.length > 0 && load <= factor * idle;
};

let db: TestDb;
let k: Kernel;
let sA: Session;
let sB: Session;
let tokA = "";
let tokB = "";
let orgA = "";
let wsA = "";
let wsB = "";
let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let appCtl: Awaited<ReturnType<typeof buildApp>> | null = null;
const g = gateB(import.meta.url);

/**
 * Mock engine: records the run as EXECUTING at start (like the workflow's first activity), then executes it on a worker pool
 * shared by all tenants (FIFO, `workerPool` slots, `investigationMs` each) and marks it COMPLETE. Without a per-tenant cap one
 * tenant's backlog therefore occupies the whole pool; with it the other tenant always finds free slots.
 */
function mockEngine() {
  const running = new Map<string, number>();
  const maxRunning = new Map<string, number>();
  const doneAt = new Map<string, number>();
  const waiters = new Map<string, () => void>();
  let started = 0;
  let free = DECL.workerPool;
  const fifo: Array<() => void> = [];
  const pump = () => {
    while (free > 0 && fifo.length) {
      free--;
      fifo.shift()!();
    }
  };
  const engine: InvestigationEngine = {
    async start(i) {
      started++;
      const n = (running.get(i.tenantId) ?? 0) + 1;
      running.set(i.tenantId, n);
      maxRunning.set(i.tenantId, Math.max(maxRunning.get(i.tenantId) ?? 0, n));
      await db.admin.query(
        `INSERT INTO runtime.runs(id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state)
         VALUES ($1,$2,$3,$4,$5,'live',$6,$7,'EXECUTING') ON CONFLICT (id) DO NOTHING`,
        [
          i.runId,
          i.tenantId,
          i.workspaceId,
          i.investigationId,
          i.questionId,
          i.budgetId,
          `investigation-${i.investigationId}-${i.questionId}`,
        ],
      );
      void new Promise<void>((go) => {
        fifo.push(go);
        pump();
      }).then(async () => {
        await sleep(DECL.investigationMs);
        free++;
        pump();
        await db.admin.query("UPDATE runtime.runs SET state = 'COMPLETE' WHERE id = $1", [i.runId]);
        running.set(i.tenantId, (running.get(i.tenantId) ?? 1) - 1);
        doneAt.set(i.runId, performance.now());
        waiters.get(i.runId)?.();
      });
      return { runId: i.runId, workflowId: `investigation-${i.investigationId}-${i.questionId}` };
    },
    async signal() {},
  };
  /** Resolves with the run's completion time (performance.now), whenever it happens. */
  const completion = (runId: string) =>
    new Promise<number>((resolve) => {
      if (doneAt.has(runId)) return resolve(doneAt.get(runId)!);
      waiters.set(runId, () => resolve(doneAt.get(runId)!));
    });
  return { engine, maxRunning, started: () => started, completion };
}
const engMain = mockEngine();
const engCtl = mockEngine();

beforeAll(async () => {
  if (!g.ok && !DRYRUN) return;
  db = await createTestDb();
  const pool = makePool(db.adminUrl, 2);
  await migrateRuntime(pool);
  await pool.end();
  k = testKernel(db);
  await k.boot();
  k.outbox.start();
  const a = await seedOrg(db.admin, "perf09a", { alice: "owner" });
  const b = await seedOrg(db.admin, "perf09b", { bob: "owner" });
  orgA = a.orgId;
  sA = await loginSession(k, a.users.alice!.subject);
  sB = await loginSession(k, b.users.bob!.subject);
  tokA = await k.devAuth!.login(a.users.alice!.subject);
  tokB = await k.devAuth!.login(b.users.bob!.subject);
  wsA = (await createWs(k, sA, "perf09 A")).workspaceId;
  wsB = (await createWs(k, sB, "perf09 B")).workspaceId;
  const overload = {
    admission: {
      maxRunningPerTenant: DECL.maxRunningPerTenant,
      maxQueuedPerTenant: DECL.maxQueuedPerTenant,
      maxQueuedGlobal: DECL.maxQueuedGlobal,
      queueTimeoutMs: DECL.queueTimeoutMs,
    },
    sse: { slowDrainTimeoutMs: DECL.slowDrainTimeoutMs },
  };
  app = await buildApp({ kernel: k, nodeEnv: "test", engine: engMain.engine, overload }); // default SSE poll (250 ms)
  await app.listen({ host: "127.0.0.1", port: API_PORT });
  appCtl = await buildApp({
    kernel: k,
    nodeEnv: "test",
    engine: engCtl.engine,
    ssePollMs: 50,
    overload: { admission: false },
  });
  await appCtl.listen({ host: "127.0.0.1", port: API_PORT_CTL });
}, 180_000);
afterAll(async () => {
  k?.outbox.stop?.();
  agent.destroy();
  app?.server.closeAllConnections();
  appCtl?.server.closeAllConnections();
  await app?.close();
  await appCtl?.close();
  await db?.drop();
}, 120_000);

/** One keep-alive pool for the submissions: 200 concurrent requests share 64 sockets (the loopback accept queue is 128 on macOS). */
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const ask = (port: number, tok: string, ws: string) =>
  new Promise<{ status: number; ms: number; retryAfter: string | null; text: string }>((resolve, reject) => {
    const t0 = performance.now();
    const body = JSON.stringify({
      question: "Why did fees spike?",
      snapshotPolicy: "live",
      budget: { tokens: 200000, toolCalls: 12, usd: 10 },
    });
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/v1/workspaces/${ws}/questions`,
        method: "POST",
        agent,
        headers: {
          authorization: `Bearer ${tok}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "idempotency-key": `perf09-${randomUUID()}`,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            ms: performance.now() - t0,
            retryAfter: (res.headers["retry-after"] as string | undefined) ?? null,
            text,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });

/** Tenant B: a steady trickle of submissions (well inside its own cap). Samples: end-to-end run time and the start request. */
const bLoop = async (port: number, eng: ReturnType<typeof mockEngine>) => {
  const e2e: Promise<number>[] = [];
  const post: number[] = [];
  const t0s: number[] = [];
  for (let i = 0; i < DECL.otherTenantSubmissions; i++) {
    const t = performance.now();
    const r = await ask(port, tokB, wsB);
    if (r.status === 202) {
      post.push(r.ms);
      t0s.push(t);
      e2e.push(eng.completion((JSON.parse(r.text) as { runId: string }).runId));
    }
    const wait = DECL.otherTenantSpacingMs - (performance.now() - t);
    if (wait > 0) await sleep(wait);
  }
  const done = await Promise.all(e2e);
  return { e2e: done.map((d, i) => d - t0s[i]!), post };
};

async function burst(
  port: number,
  a: typeof app,
  eng: ReturnType<typeof mockEngine>,
  idleRun: Awaited<ReturnType<typeof bLoop>>,
): Promise<BurstResult> {
  const adm = a!.overload.admission;
  const startedBefore = eng.started();
  eng.maxRunning.clear();
  const h0 = process.memoryUsage();
  let stop = false;
  let maxDb = 0;
  let peakQT = 0;
  let peakQG = 0;
  const timeline: BurstResult["timeline"] = [];
  const t00 = performance.now();
  const sampler = (async () => {
    let n = 0;
    while (!stop) {
      const q = await db.admin.query(
        "SELECT count(*)::int AS n FROM runtime.runs WHERE tenant_id = $1 AND state = ANY($2::text[])",
        [orgA, ["REQUESTED", "PLANNING", "EXECUTING", "EVIDENCE_REVIEW", "CANVAS_PATCH_REVIEW"]],
      );
      maxDb = Math.max(maxDb, q.rows[0]!.n as number);
      const st = adm?.stats();
      if (st) {
        peakQG = Math.max(peakQG, st.queuedGlobal);
        peakQT = Math.max(peakQT, st.tenants[orgA]?.queued ?? 0);
      }
      const hm = process.memoryUsage();
      if (n++ % 5 === 0)
        timeline.push({
          t: Math.round(performance.now() - t00),
          running: q.rows[0]!.n as number,
          queued: st?.queuedGlobal ?? 0,
          heapMiB: Math.round((hm.heapUsed / MiB) * 10) / 10,
        });
      await sleep(20);
    }
  })();
  let peakHeap = h0.heapUsed;
  let peakRss = h0.rss;
  const mem = setInterval(() => {
    const m = process.memoryUsage();
    peakHeap = Math.max(peakHeap, m.heapUsed);
    peakRss = Math.max(peakRss, m.rss);
  }, 25);
  const [res, loadRun] = await Promise.all([
    Promise.all(Array.from({ length: LOAD.investigations }, () => ask(port, tokA, wsA))),
    bLoop(port, eng),
  ]);
  // let the admitted work finish so the queue and runs drain
  const drainBy = performance.now() + 90_000;
  while (performance.now() < drainBy) {
    const n = (
      await db.admin.query(
        "SELECT count(*)::int AS n FROM runtime.runs WHERE tenant_id = $1 AND state = 'EXECUTING'",
        [orgA],
      )
    ).rows[0]!.n as number;
    if (n === 0 && (adm?.stats().queuedGlobal ?? 0) === 0) break;
    await sleep(100);
  }
  stop = true;
  clearInterval(mem);
  await sampler;
  const status: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  let badRetry = 0;
  let fiveXX = 0;
  for (const r of res) {
    status[r.status] = (status[r.status] ?? 0) + 1;
    if (r.status >= 500) fiveXX++;
    if (r.status === 429) {
      const body = ErrorResponse.safeParse(JSON.parse(r.text));
      const hdr = Number(r.retryAfter);
      if (
        !body.success ||
        !(hdr >= 1) ||
        body.data.retryAfterSeconds !== hdr ||
        body.data.errorCode !== "RATE_LIMITED"
      )
        badRetry++;
      else reasons[body.data.reasonCode] = (reasons[body.data.reasonCode] ?? 0) + 1;
    } else if (r.status !== 202) badRetry++;
  }
  return {
    status,
    reasons,
    badRetry,
    fiveXX,
    maxRunningEngine: eng.maxRunning.get(orgA) ?? 0,
    maxRunningDb: maxDb,
    peakQueuedGlobal: peakQG,
    peakQueuedTenant: peakQT,
    admitted: adm?.stats().admitted ?? NaN,
    started: eng.started() - startedBefore,
    heapGrowthMiB: Math.round(((peakHeap - h0.heapUsed) / MiB) * 10) / 10,
    rssGrowthMiB: Math.round(((peakRss - h0.rss) / MiB) * 10) / 10,
    bIdle: idleRun.e2e,
    bLoad: loadRun.e2e,
    bIdlePost: idleRun.post,
    bLoadPost: loadRun.post,
    timeline,
  };
}

/** Raw SSE socket: can be paused (slow) or left unread (stuck). Records frame arrival per event id for healthy clients. */
function rawSse(port: number, ws: string, clientId: string, baseSeq: number, n: number) {
  const sock = net.createConnection({ host: "127.0.0.1", port });
  let status = 0;
  let head = "";
  let buf = "";
  let coalesced = 0;
  let bytes = 0;
  let closed = false;
  const ids: number[] = [];
  const at = new Float64Array(n + 8).fill(-1);
  sock.on("data", (d) => {
    bytes += d.length;
    const s = d.toString("utf8");
    if (!status) {
      head += s;
      const m = /^HTTP\/1\.1 (\d+)/.exec(head);
      if (m) status = Number(m[1]);
    }
    buf += s;
    const now = performance.now();
    const re = /id: (\d+)\nevent: ([\w.]+)\n/g;
    let last = 0;
    for (let m = re.exec(buf); m; m = re.exec(buf)) {
      last = re.lastIndex;
      if (m[2] === "coalesced") coalesced++;
      const id = Number(m[1]);
      ids.push(id);
      const i = id - baseSeq;
      if (i >= 0 && i < at.length) at[i] = now;
    }
    buf = buf.slice(Math.max(last, buf.length - 256));
  });
  sock.on("error", () => undefined);
  sock.on("close", () => (closed = true));
  sock.write(
    `GET /v1/workspaces/${ws}/events HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nauthorization: Bearer ${tokA}\r\nx-client-id: ${clientId}\r\nlast-event-id: ${baseSeq}\r\n\r\n`,
  );
  return {
    sock,
    get status() {
      return status;
    },
    ids,
    at,
    get bytes() {
      return bytes;
    },
    get coalesced() {
      return coalesced;
    },
    get headText() {
      return head;
    },
    get closed() {
      return closed;
    },
  };
}
const until = async (cond: () => boolean, ms: number) => {
  const t = performance.now();
  while (!cond() && performance.now() - t < ms) await sleep(10);
  return cond();
};

it("PERF09: caps, bounded queues, coalesced SSE, max rows and visible degradation under overload", async () => {
  if (!g.ok && !DRYRUN) {
    observe({ testId: "PERF09", observed: "not executed", blocked: g.reason });
    return;
  }
  const fixtureHash = sha256Text(JSON.stringify(FIXTURE_SPEC));
  if (DRYRUN) process.stderr.write(`FIXTUREHASH PERF09 ${fixtureHash}\n`);
  if (g.ok) expect(referenceB().fixtures.PERF09).toBe(fixtureHash);
  const bounds = {
    queueTenant: DECL.maxQueuedPerTenant,
    queueGlobal: DECL.maxQueuedGlobal,
    heapMiB: DECL.heapGrowthBoundMiB,
  };

  // ---- (a), (b): tenant A burst against the capped build
  // PERF09_SKIP_BURST=1 (only with PERF_DRYRUN=1) skips (a)/(b) and the control to iterate on the SSE phase
  const skipBurst = DRYRUN && process.env.PERF09_SKIP_BURST === "1";
  const emptyBurst: BurstResult = {
    status: {},
    reasons: {},
    badRetry: 0,
    fiveXX: 0,
    maxRunningEngine: 0,
    maxRunningDb: 0,
    peakQueuedGlobal: 0,
    peakQueuedTenant: 0,
    admitted: 0,
    started: 0,
    heapGrowthMiB: 0,
    rssGrowthMiB: 0,
    bIdle: [1],
    bLoad: [1],
    bIdlePost: [1],
    bLoadPost: [1],
    timeline: [],
  };
  // tenant B alone, once, before any overload: the baseline for both the capped build and the control
  const idle = skipBurst ? { e2e: [1], post: [1] } : await bLoop(API_PORT, engMain);
  if (!skipBurst) await sleep(DECL.investigationMs);
  const capped = skipBurst ? emptyBurst : await burst(API_PORT, app, engMain, idle);
  const aOk = judgeA(capped, DECL.maxRunningPerTenant, bounds);
  const bOk = judgeB(capped, DECL.otherTenantP95Factor);
  const bIdleStats = stats(capped.bIdle);
  const bLoadStats = stats(capped.bLoad);
  const bPostStats = { idle: stats(capped.bIdlePost), underOverload: stats(capped.bLoadPost) };

  // ---- negative control: no per-tenant cap
  const ctl = skipBurst ? emptyBurst : await burst(API_PORT_CTL, appCtl, engCtl, idle);
  const ctlA = judgeA(ctl, DECL.maxRunningPerTenant, bounds);
  const ctlB = judgeB(ctl, DECL.otherTenantP95Factor);

  // ---- (c): 300 SSE clients, 20 slow
  const base = Number(
    (
      await db.admin.query("SELECT coalesce(max(seq),0) AS m FROM workspace_events WHERE workspace_id=$1", [
        wsA,
      ])
    ).rows[0]!.m,
  );
  const sseBefore = app!.overload.sse.stats();
  const heapSse0 = process.memoryUsage().heapUsed;
  // Browsers arrive over time (loopback accept queue is 128 on macOS): connect in batches of 25.
  const clients: ReturnType<typeof rawSse>[] = [];
  for (let i = 0; i < LOAD.sseClients; i += 25) {
    const batch = Array.from({ length: Math.min(25, LOAD.sseClients - i) }, (_, j) =>
      rawSse(API_PORT, wsA, `c-${i + j}`, base, DECL.commands + 8),
    );
    clients.push(...batch);
    await until(() => batch.every((c) => c.status !== 0), 10_000);
  }
  const slowResume = clients.slice(0, LOAD.slowClients / 2);
  const stuck = clients.slice(LOAD.slowClients / 2, LOAD.slowClients);
  const healthy = clients.slice(LOAD.slowClients);
  // per-browser limit: the 7th stream of one client id is refused 429
  const dup = Array.from({ length: 7 }, () => rawSse(API_PORT, wsA, "dup", base, 8));
  await until(() => dup.every((c) => c.status !== 0), 10_000);
  await until(() => dup[dup.length - 1]!.status !== 0, 10_000);
  const dupStatuses = dup.map((c) => c.status);
  dup.forEach((c) => c.sock.destroy());
  for (const c of [...slowResume, ...stuck]) c.sock.pause();
  let peakHeapSse = heapSse0;
  const memT = setInterval(() => (peakHeapSse = Math.max(peakHeapSse, process.memoryUsage().heapUsed)), 25);
  const big = "x".repeat(3900);
  const issued: number[] = [];
  const v0 = (await db.admin.query("SELECT version FROM workspaces WHERE id = $1", [wsA])).rows[0]!
    .version as number;
  let burstStart: number | null = null;
  let resumed = false;
  for (let i = 0; i < DECL.commands; i++) {
    issued.push(performance.now());
    await k.commands.execute(sA, wsA, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "workspace.update_objective",
      payload: { objective: `${i}-${big}` },
      expectedVersion: v0 + i,
    });
    // The late readers wake near the end of the burst: blocked since the socket buffers filled, long enough to count as slow
    // (500 ms) and shorter than the drain timeout, so they resume and are served an aggregate instead of the backlog.
    if (i === DECL.pacedCommands) burstStart = performance.now();
    if (!resumed && burstStart !== null && performance.now() - burstStart >= DECL.lateReadAfterMs) {
      resumed = true;
      slowResume.forEach((c) => c.sock.resume());
    }
    if (i < DECL.pacedCommands) {
      const wait = DECL.commandSpacingMs - (performance.now() - issued[i]!);
      if (wait > 0) await sleep(wait);
    }
  }
  if (!resumed) slowResume.forEach((c) => c.sock.resume());
  const head = Number(
    (await db.admin.query("SELECT max(seq) AS m FROM workspace_events WHERE workspace_id=$1", [wsA])).rows[0]!
      .m,
  );
  await until(() => healthy.every((c) => c.ids.includes(head)), 180_000);
  await until(() => slowResume.some((c) => c.coalesced > 0), 15_000);
  await until(
    () => app!.overload.sse.stats().slowDropped >= sseBefore.slowDropped + 1,
    DECL.slowDrainTimeoutMs + 20_000,
  );
  clearInterval(memT);
  const sse = app!.overload.sse.stats();
  const seqs = (
    await db.admin.query("SELECT seq FROM workspace_events WHERE workspace_id=$1 AND seq > $2 ORDER BY seq", [
      wsA,
      base,
    ])
  ).rows.map((r) => Number(r.seq));
  const lat: number[] = [];
  let missing = 0;
  let unordered = 0;
  seqs.forEach((seq, i) => {
    for (const c of healthy) {
      const t = c.at[seq - base];
      if (t === undefined || t < 0) missing++;
      else if (i < DECL.pacedCommands) lat.push(t - issued[i]!);
    }
  });
  for (const c of healthy) {
    const only = c.ids.filter((x) => x > base);
    if (only.some((x, i) => i > 0 && x <= only[i - 1]!)) unordered++;
  }
  const latStats = stats(lat);
  const sseHeapMiB = Math.round(((peakHeapSse - heapSse0) / MiB) * 10) / 10;
  const slowCoalesced = slowResume.filter((c) => c.coalesced > 0).length;
  const openOk = healthy.filter((c) => c.status === 200).length; // every healthy stream is established and carrying events
  const sseOk =
    openOk === healthy.length &&
    dupStatuses.filter((s) => s === 429).length === 1 &&
    missing === 0 &&
    unordered === 0 &&
    latStats.p95 < DECL.ssePropagationP95Ms &&
    slowCoalesced > 0 &&
    sse.coalescedFrames > sseBefore.coalescedFrames &&
    sse.slowDropped > sseBefore.slowDropped &&
    sse.peakBufferedBytes < DECL.sseBufferBoundBytes &&
    sseHeapMiB <= DECL.heapGrowthBoundMiB &&
    sse.peakOpen >= LOAD.sseClients &&
    sse.slowDropped - sseBefore.slowDropped === stuck.length; // exactly the clients that never read, no healthy or late one
  clients.forEach((c) => c.sock.destroy());

  // ---- (d): 5,000,000-row chart request through the max-rows rule (rows are produced lazily, never held)
  const N = LOAD.chartRows;
  const SPIKE = 3_333_333;
  const GAP = 1_234_567;
  const y = (i: number): number | null => (i === GAP ? null : i === SPIKE ? 1e9 : Math.sin(i / 1000));
  const heapChart0 = process.memoryUsage().heapUsed;
  const tc = performance.now();
  const bounded = boundChartRows({ count: N, rowAt: (i) => [i, y(i)] as [number, number | null], yAt: y });
  const chartMs = performance.now() - tc;
  const chartHeapMiB = Math.round(((process.memoryUsage().heapUsed - heapChart0) / MiB) * 10) / 10;
  const trunc = ResultTruncation.safeParse(bounded.truncation);
  const chartOk =
    bounded.rows.length <= DEFAULT_MAX_CHART_ROWS &&
    trunc.success &&
    trunc.data.truncated === true &&
    trunc.data.reason === "MAX_ROWS" &&
    trunc.data.requestedRows === N &&
    trunc.data.returnedRows === bounded.rows.length &&
    bounded.downsampling.method === "min_max_bucket" &&
    bounded.rows.some((r) => r[0] === SPIKE) &&
    bounded.rows.some((r) => r[1] === null) &&
    ChartData.safeParse({
      panelId: randomUUID(),
      queryHash: "a".repeat(64),
      dataRevision: 1,
      columns: [
        { name: "x", unit: null },
        { name: "y", unit: null },
      ],
      rows: bounded.rows,
      downsampling: bounded.downsampling,
      truncation: bounded.truncation,
      freshness: "fresh",
      sourceWatermark: null,
    }).success &&
    chartHeapMiB <= DECL.heapGrowthBoundMiB;

  // ---- (e): degraded source
  let now = Date.parse("2026-11-12T12:00:00Z");
  const OPEN_MS = DECL.breakerOpenMs;
  const burstN = DECL.probeBurst;
  const rows: WatermarkRow[] = [
    { providerId: "near-explorer", newestEventTime: "2026-11-10 00:00:00.000", state: "fresh", version: 1 },
  ];
  const published: WatermarkEvent[] = [];
  const deps: FeederDeps = {
    now: () => now,
    readWatermarks: async (after) => rows.filter((r) => r.version > after),
    metricIdsFor: () => ["live.swaps"],
    metricValue: async () => 7,
    enqueue: async (e) => {
      published.push(e);
      return { enqueued: true };
    },
  };
  const guard = new DegradationGuard<Record<string, number>>({
    openMs: OPEN_MS,
    maxOpenMs: 60_000,
    now: () => now,
  });
  const feeder = new MonitorFeeder({ ...deps, degradation: guard });
  const SRC = "near-explorer";
  await feeder.pollOnce(); // healthy: published, finalized values kept as the snapshot
  const healthyPublished = published.length;
  rows.push({ providerId: SRC, newestEventTime: null, state: "unavailable", version: 2 });
  rows.push({ providerId: SRC, newestEventTime: "2026-11-11 00:00:00.000", state: "late", version: 3 });
  const blocked1 = await feeder.pollOnce();
  const shown = guard.lastFinalized(SRC)!;
  let blockedThrows = false;
  try {
    guard.assertCanPublishCurrent(SRC);
  } catch (e) {
    blockedThrows = (e as { reasonCode?: string }).reasonCode === "STALE_PUBLICATION_BLOCKED";
  }
  const served = await guard.read(SRC, async () => {
    throw new Error("upstream 503");
  });
  let noSnapshotRefused = false;
  try {
    await new DegradationGuard<number>({ now: () => now }).read("empty", async () => {
      throw new Error("down");
    });
  } catch (e) {
    noSnapshotRefused = (e as { reasonCode?: string }).reasonCode === "SOURCE_UNAVAILABLE_NO_SNAPSHOT";
  }
  // restored but inside the open interval: nothing is probed or published
  rows.push({ providerId: SRC, newestEventTime: "2026-11-11 00:00:00.000", state: "fresh", version: 4 });
  const blocked2 = await feeder.pollOnce();
  const publishedDuringDegradation = published.length - healthyPublished;
  const probesInsideInterval = Array.from({ length: burstN }, () => guard.tryProbe(SRC)).filter(
    Boolean,
  ).length;
  // interval passed: a burst of concurrent callers, exactly one becomes the probe
  now += OPEN_MS;
  const probers = await Promise.all(Array.from({ length: burstN }, async () => guard.tryProbe(SRC)));
  const singleProbe = probers.filter(Boolean).length;
  guard.markUnhealthy(SRC); // that probe failed: the breaker re-opens with a doubled interval
  now += OPEN_MS;
  const probesInDoubled = Array.from({ length: burstN }, () => guard.tryProbe(SRC)).filter(Boolean).length;
  now += OPEN_MS; // twice the base interval since the failed probe
  // the feeder itself is the next probe: it publishes once and its success closes the breaker
  rows.push({ providerId: SRC, newestEventTime: "2026-11-11 00:00:00.000", state: "fresh", version: 5 });
  const recovered = await feeder.pollOnce();
  const probeCount = guard.breakerOf(SRC).probeCount;
  // 401/403 never probe: the failure arrives through the real read path (statusOf), not a timer
  const g401 = new DegradationGuard<number>({
    openMs: OPEN_MS,
    now: () => now,
    statusOf: (e) => (e as { status?: number }).status,
  });
  g401.recordFinalized("s", 1, "2026-11-10T00:00:00Z");
  await g401.read("s", async () => {
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  });
  now += 100 * OPEN_MS;
  const authProbes = Array.from({ length: burstN }, () => g401.tryProbe("s")).filter(Boolean).length;
  const authNeedsIntervention = g401.breakerOf("s").requiresIntervention;
  const degradeOk =
    healthyPublished === 1 &&
    blocked1.blockedDegraded === 1 &&
    blocked2.blockedDegraded === 1 &&
    publishedDuringDegradation === 0 &&
    shown.value["live.swaps"] === 7 &&
    shown.serve.servedFrom === "last_finalized_snapshot" &&
    shown.serve.currentPublicationAllowed === false &&
    !!shown.serve.warning &&
    served.serve.servedFrom === "last_finalized_snapshot" &&
    served.serve.currentPublicationAllowed === false &&
    served.serve.warning?.code !== undefined &&
    blockedThrows &&
    noSnapshotRefused &&
    probesInsideInterval === 0 &&
    singleProbe === 1 &&
    probesInDoubled === 0 &&
    recovered.blockedDegraded === 0 &&
    published.length === healthyPublished + 1 &&
    probeCount === 2 &&
    authNeedsIntervention &&
    !guard.isDegraded(SRC) &&
    authProbes === 0;

  if (DRYRUN)
    process.stderr.write(
      "DRYRUN " +
        JSON.stringify({
          capped: { ...capped, timeline: capped.timeline.length, bIdle: bIdleStats, bLoad: bLoadStats },
          control: {
            ...ctl,
            timeline: ctl.timeline.length,
            bIdle: stats(ctl.bIdle),
            bLoad: stats(ctl.bLoad),
          },
          verdict: { aOk, bOk, ctlA, ctlB, sseOk, chartOk, degradeOk },
          slowDiag: {
            late: slowResume.map((c) => ({
              bytes: c.bytes,
              closed: c.closed,
              n: c.ids.length,
              co: c.coalesced,
            })),
            stuck: stuck.map((c) => ({ bytes: c.bytes, closed: c.closed, n: c.ids.length })),
          },
          sse: {
            openOk,
            dupStatuses,
            missing,
            unordered,
            lat: latStats,
            slowCoalesced,
            sseHeapMiB,
            stats: sse,
            before: sseBefore,
          },
          chart: { rows: bounded.rows.length, chartMs, chartHeapMiB, trunc: bounded.truncation },
          degrade: {
            healthyPublished,
            blocked1,
            blocked2,
            published: published.length,
            singleProbe,
            probeCount,
            probesInsideInterval,
            probesInDoubled,
            authProbes,
            recovered,
          },
        }) +
        "\n",
    );
  if (!skipBurst) {
    expect(ctlA).toBe(false); // no cap: (a) fails
    expect(ctlB).toBe(false); // no cap: (b) fails
    expect(aOk).toBe(true);
    expect(bOk).toBe(true);
  }
  expect(sseOk).toBe(true);
  expect(chartOk).toBe(true);
  expect(degradeOk).toBe(true);
  if (DRYRUN) return;

  observe({
    testId: "PERF09",
    observed: `(a) ${LOAD.investigations} concurrent investigations from one tenant (cap ${DECL.maxRunningPerTenant}, queue ${DECL.maxQueuedPerTenant}/tenant ${DECL.maxQueuedGlobal} global): statuses ${JSON.stringify(capped.status)} reasons ${JSON.stringify(capped.reasons)}, every 429 carried Retry-After and a structured body, 0 server errors; max running ${capped.maxRunningEngine} (engine) / ${capped.maxRunningDb} (runtime schema, 20 ms samples); peak queue ${capped.peakQueuedTenant} tenant / ${capped.peakQueuedGlobal} global; heap growth ${capped.heapGrowthMiB} MiB (bound ${DECL.heapGrowthBoundMiB}). (b) other tenant run completion (submission to COMPLETE, worker pool ${DECL.workerPool} x ${DECL.investigationMs} ms) p50 ${bIdleStats.p50} -> ${bLoadStats.p50} ms, p95 ${bIdleStats.p95} -> ${bLoadStats.p95} ms, p99 ${bIdleStats.p99} -> ${bLoadStats.p99} ms idle -> under overload (declared factor <= ${DECL.otherTenantP95Factor}x); start request p95 ${bPostStats.idle.p95} -> ${bPostStats.underOverload.p95} ms. (c) ${LOAD.sseClients} streams opened (server peak ${sse.peakOpen}; ${openOk}/${healthy.length} healthy streams carrying events), per-browser limit: of 7 streams of one client id exactly ${dupStatuses.filter((s) => s === 429).length} was refused 429; ${LOAD.slowClients} slow clients: ${slowCoalesced}/${slowResume.length} late readers received coalesced aggregates (${sse.coalescedFrames - sseBefore.coalescedFrames} coalesced frames), ${sse.slowDropped - sseBefore.slowDropped} stuck clients dropped after ${DECL.slowDrainTimeoutMs} ms; peak unflushed bytes on a connection ${sse.peakBufferedBytes} (bound ${DECL.sseBufferBoundBytes}), heap growth ${sseHeapMiB} MiB; ${healthy.length} healthy clients: ${missing} missing frames, ${unordered} out of order, commit to client p50 ${latStats.p50} ms, p95 ${latStats.p95} ms, p99 ${latStats.p99} ms. (d) ${N} rows requested: ${bounded.rows.length} returned (max ${DEFAULT_MAX_CHART_ROWS}), truncation label ${JSON.stringify(bounded.truncation)}, spike and gap preserved, ${Math.round(chartMs)} ms, heap +${chartHeapMiB} MiB. (e) degraded source: last finalized snapshot served with ${shown.serve.warning?.code} warning, current publication blocked (feeder published ${publishedDuringDegradation} during degradation; STALE_PUBLICATION_BLOCKED raised), no snapshot means refusal not invention; ${singleProbe} probe among ${burstN} callers after the interval, failed probe doubled the interval (${probesInDoubled} probes inside it, then the feeder's probe published ${published.length - healthyPublished} and closed the breaker after ${probeCount} probes), 401/403 probes ${authProbes}. Negative control (cap off): max running ${ctl.maxRunningEngine}, other tenant p95 ${stats(ctl.bLoad).p95} ms vs idle ${stats(ctl.bIdle).p95} ms, (a) ${ctlA ? "PASS" : "FAIL"}, (b) ${ctlB ? "PASS" : "FAIL"}, judged FAIL as required`,
    fixtureHash,
    evidence: {
      ...evidenceBase(g, {
        dataset: { id: "perf09 fixture spec", sha256: fixtureHash },
        concurrency: {
          investigations: LOAD.investigations,
          sseClients: LOAD.sseClients,
          slowClients: LOAD.slowClients,
        },
        cacheState: "n/a (fresh database)",
      }),
      declaredBounds: DECL,
      agentCap: {
        capped: { ...capped, bIdle: undefined, bLoad: undefined, timeline: undefined },
        timeline: capped.timeline,
      },
      otherTenant: { idle: bIdleStats, underOverload: bLoadStats, startRequest: bPostStats },
      sse: {
        stats: sse,
        before: sseBefore,
        healthyLatency: latStats,
        missing,
        unordered,
        slowCoalesced,
        dupStatuses,
        heapGrowthMiB: sseHeapMiB,
      },
      chart: {
        requestedRows: N,
        returnedRows: bounded.rows.length,
        truncation: bounded.truncation,
        downsampling: bounded.downsampling,
        ms: Math.round(chartMs),
        heapGrowthMiB: chartHeapMiB,
      },
      degradation: {
        served: shown.serve,
        probes: {
          insideInterval: probesInsideInterval,
          afterInterval: singleProbe,
          insideDoubled: probesInDoubled,
          afterDoubled: probeCount,
          authFailure: authProbes,
        },
      },
      negativeControl: {
        maxRunning: ctl.maxRunningEngine,
        status: ctl.status,
        otherTenant: {
          idle: stats(ctl.bIdle),
          underOverload: stats(ctl.bLoad),
          startRequest: { idle: stats(ctl.bIdlePost), underOverload: stats(ctl.bLoadPost) },
        },
        judgedFail: { a: !ctlA, b: !ctlB },
      },
      screenshots:
        "none (no browser surface in this harness); the degraded-mode state is the ServedRead record above",
    },
  });
}, 900_000);
