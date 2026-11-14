/**
 * PERF11: chaos, component failure under load with idempotent recovery (ch.13 "Reliability design", ch.16b 6.2).
 * Runs ONLY against the isolated fault-injection stack (compose project `nearesis-chaos`, ports 64xxx, own volumes;
 * scripts/chaos/stack.sh), never the shared `nearesis` stack, so live collection is untouched.
 *
 * Load during every fault: real Temporal investigations (10 per fault, scenario "basic", spawned worker processes),
 * a side-effect pipeline of 10 jobs per fault (idempotent paid API call + mock chain write through the production
 * side-effect ledger, in two killable worker processes), a command writer on the real kernel + API (journal and outbox
 * under test), and blackbox probes of the API, Redis, ClickHouse and Cube every 250 ms.
 * Faults, one at a time then combined: SIGKILL worker, restart API, restart Redis, ClickHouse, Cube, Temporal and
 * Postgres, a sustained Postgres connection reset, a 5 s network partition to Temporal (container pause).
 * Judged: (a) every investigation COMPLETE within the declared recovery time; (b) every idempotent effect accepted exactly
 * once, inference duplicates disclosed; (c) journal seq contiguous, outbox consumers one effect per event, panel
 * revisions consistent; (d) availability and error-budget burn per fault recorded, and every fault that made a probed
 * component unavailable produces an alert DELIVERED to the notification sink (a notification.created journal event
 * in the notification store, also received by a subscriber on the real SSE stream), with a fault-scoped dedupe key and an
 * isolated alert window per fault so correct de-duplication across faults cannot mask delivery; (e) no chain write broadcast twice, pending writes resolved by lookup.
 * Negative controls: (1) an alert sink that accepts and drops every alert must FAIL the delivery judge; (2) the same jobs with identical injected crashes under a worker that retries without idempotency keys
 * (fresh key per attempt, rebroadcast without lookup) must FAIL (b) and (e) through the same judge functions.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { DRYRUN, percentile, sha256Text } from "./_reference.ts";
import { evidenceBase, gateB, referenceB, thr } from "./_b.ts";
import {
  CH_URL,
  CUBE_URL,
  ISOLATED,
  judgeEffects,
  judgeAlertDelivery,
  judgeJournal,
  type DeliveredNotification,
  sleep,
  stack,
  stackAsync,
  stackHealthy,
  startMockProvider,
  until,
  useIsolatedEnv,
  type LedgerRow,
  type MockProvider,
} from "./_chaos.ts";
import { claimJob, finishJob, paidKeyFor, processJob, seedJobs, txHashFor } from "./_chaos-fx.ts";

useIsolatedEnv();

const th = thr("PERF11");
const API_PORT = 4781;
const STEP_DELAY_MS = 700;
const POLICY = { heartbeatTimeoutMs: 3000 };
export const FAULTS = [
  "kill_worker",
  "restart_api",
  "restart_redis",
  "restart_clickhouse",
  "restart_cube",
  "restart_temporal",
  "restart_postgres",
  "reset_pg_connections",
  "partition_temporal",
  "combined",
] as const;
type Fault = (typeof FAULTS)[number];
export const FIXTURE_SPEC = {
  faults: FAULTS,
  investigationsPerFault: th.investigationsPerFault,
  effectJobsPerFault: th.effectJobsPerFault,
  scenario: "basic",
  stepDelayMs: STEP_DELAY_MS,
  workerPolicy: POLICY,
  partitionMs: th.partitionMs,
  recoveryDeadlineMs: th.recoveryDeadlineMs,
  probeIntervalMs: 250,
  writer: "canvas.apply_patch addPanel with retry on the same commandId",
  effects: ["paid_api (idempotent by key)", "chain_write (lookup before rebroadcast)"],
  control: "same jobs, same injected crashes, fresh idempotency key per attempt, no lookup",
};

const g = gateB(import.meta.url, [
  fileURLToPath(new URL("./_chaos.ts", import.meta.url)),
  fileURLToPath(new URL("./_chaos-fx.ts", import.meta.url)),
  fileURLToPath(new URL("./_chaos-fx-worker.ts", import.meta.url)),
  fileURLToPath(new URL("../../infrastructure/compose/chaos.yml", import.meta.url)),
  fileURLToPath(new URL("../../scripts/chaos/stack.sh", import.meta.url)),
]);

/* eslint-disable @typescript-eslint/no-explicit-any -- dynamically imported harness handles */
let env: any; // workflow harness environment (runtime DB on the isolated Postgres, Temporal client)
let kdb: any; // kernel test database (isolated Postgres)
let k: any;
let session: any;
let app: any = null;
let token = "";
let mock: MockProvider;
let h: any; // workflow harness module
let blocked: string | null = null;
const procs: ChildProcess[] = [];
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeAll(async () => {
  if (!g.ok && !DRYRUN) return;
  let st = await stackHealthy();
  if (!st.ok) {
    stack("up");
    st = await stackHealthy();
  }
  if (!st.ok) {
    blocked = `isolated stack not healthy: ${st.down.join(", ")}`;
    return;
  }
  h = await import("../../packages/workflow/test/helpers/harness.ts");
  const kt = await import("../../packages/kernel/test/helpers/index.ts");
  const { buildApp } = await import("../../apps/api/src/index.ts");
  const { SloRecorder } = await import("../../packages/agent-runtime/src/index.ts");
  const wf = await import("../../packages/workflow/src/db.ts");
  env = await h.makeEnv();
  kdb = await kt.createTestDb();
  await wf.migrate(wf.makePool(kdb.adminUrl, 2)); // runtime schema (slo_buckets, ops_alerts) beside the kernel schema
  const org = await kt.seedOrg(kdb.admin, "perf11", { alice: "owner" });
  k = kt.testKernel(kdb);
  await k.boot();
  k.outbox.register(
    "perf11.effect",
    async ({
      tx,
      event,
    }: {
      tx: { query(t: string, p?: unknown[]): Promise<unknown> };
      event: { eventId: string };
    }) => {
      await tx.query("INSERT INTO perf11_consumer_effects (event_id) VALUES ($1)", [event.eventId]);
    },
  );
  await kdb.admin.query(
    "CREATE TABLE IF NOT EXISTS perf11_consumer_effects (event_id uuid NOT NULL, at timestamptz NOT NULL DEFAULT now()); GRANT INSERT, SELECT ON perf11_consumer_effects TO nearesis_app",
  );
  k.outbox.start();
  session = await kt.loginSession(k, org.users.alice.subject);
  token = await k.devAuth.login(org.users.alice.subject);
  slo = new SloRecorder(kdb.app.pool);
  slo.start(2000);
  const mk = async () => {
    const a = await buildApp({ kernel: k, nodeEnv: "test", sloRecorder: slo });
    await a.listen({ host: "127.0.0.1", port: API_PORT });
    return a;
  };
  buildApi = mk;
  app = await mk();
  mock = await startMockProvider();
}, 300_000);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let slo: any;
let buildApi: () => Promise<unknown>;

afterAll(async () => {
  for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  stack("unpause", "temporal");
  await slo?.stop?.();
  await app?.close();
  k?.outbox.stop?.();
  await mock?.close();
  await env?.stop?.();
  await kdb?.drop?.();
}, 120_000);

const workerLogs = new Map<string, string>();
async function spawnW(id: string) {
  const w = await h.spawnWorkerProcess(env, id, { policy: POLICY, stepDelayMs: STEP_DELAY_MS });
  w.proc.stderr?.on("data", (d: Buffer) =>
    workerLogs.set(id, `${workerLogs.get(id) ?? ""}${d}`.slice(-1500)),
  );
  return w;
}

function startFxWorker(id: string): ChildProcess {
  const p = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("./_chaos-fx-worker.ts", import.meta.url))],
    {
      env: {
        ...process.env,
        FX_DB_URL: env.db.appUrl,
        FX_TENANT: env.tenantId,
        FX_PROVIDER: mock.url,
        FX_WORKER: id,
        FX_LEASE_MS: "3000",
      },
      stdio: "ignore",
    },
  );
  procs.push(p);
  return p;
}

interface Probe {
  at: number;
  api: boolean;
  redis: boolean;
  clickhouse: boolean;
  cube: boolean;
}
const probes: Probe[] = [];
let probing = true;

/** Redis probe over raw RESP (no client library): SET with expiry, expects +OK within the timeout. */
async function redisProbe(): Promise<boolean> {
  const net = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const s = net.connect(ISOLATED.redis, "127.0.0.1");
    let buf = "";
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(1500, () => done(false));
    s.once("error", () => done(false));
    s.once("connect", () =>
      s.write("*5\r\n$3\r\nSET\r\n$12\r\nperf11:probe\r\n$1\r\n1\r\n$2\r\nEX\r\n$2\r\n60\r\n"),
    );
    s.on("data", (d) => {
      buf += String(d);
      if (buf.includes("\r\n")) done(buf.startsWith("+OK"));
    });
  });
}

async function probeLoop(): Promise<void> {
  const to = (u: string, init: RequestInit = {}) => fetch(u, { ...init, signal: AbortSignal.timeout(1500) });
  while (probing) {
    const t0 = Date.now();
    // a probe that does not answer within 2.5 s counts as failed (it never stalls the loop)
    const [api, rd, ch, cube] = await Promise.race([
      Promise.all([
        to(`http://127.0.0.1:${API_PORT}/v1/workspaces`, {
          headers: { authorization: `Bearer ${token}` },
        }).then(
          (r) => (r.status >= 500 ? false : r.ok),
          () => {
            slo.record("api_availability", false); // blackbox failure the server could not observe
            return false;
          },
        ),
        redisProbe(),
        to(`${CH_URL}/?query=${encodeURIComponent("SELECT 1")}`, {
          headers: { "x-clickhouse-user": "nearesis", "x-clickhouse-key": "nearesis" },
        }).then(
          (r) => r.ok,
          () => false,
        ),
        to(`${CUBE_URL}/readyz`).then(
          (r) => r.ok,
          () => false,
        ),
      ]),
      sleep(2500).then(() => [false, false, false, false] as boolean[]),
    ]);
    probes.push({ at: t0, api, redis: rd, clickhouse: ch, cube });
    await sleep(Math.max(0, 250 - (Date.now() - t0)));
  }
}

const acked = new Set<string>();
let writerStop = false;
let writerPanelId = "";
async function writerLoop(workspaceId: string): Promise<void> {
  const { runCmd } = await import("../../packages/kernel/test/helpers/index.ts");
  let revision = 1; // the panel was added at revision 1 before the load started
  while (!writerStop) {
    const commandId = randomUUID();
    const payload = {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: randomUUID(),
      expectedRevision: revision,
      operations: [
        { op: "movePanel", panelId: writerPanelId, layout: { x: revision % 6, y: 0, w: 6, h: 4 } },
      ],
    };
    for (;;) {
      if (writerStop) return;
      try {
        const version = (await k.workspaces.get(session, workspaceId)).version;
        await runCmd(k, session, workspaceId, "canvas.apply_patch", payload, version, commandId);
        acked.add(commandId);
        revision++;
        break;
      } catch {
        // A failure after the commit (lost acknowledgement) is confirmed by the command id before retrying it.
        const r = await kdb.admin.query("SELECT 1 FROM commands WHERE id = $1", [commandId]).then(
          (x: { rowCount: number }) => x.rowCount,
          () => -1,
        );
        if (r === 1) {
          acked.add(commandId);
          revision++;
          break;
        }
        await sleep(300);
      }
    }
    await sleep(120);
  }
}

async function seedWriterPanel(workspaceId: string): Promise<void> {
  const { PanelSpec } = await import("../../packages/contracts/src/index.ts");
  const { runCmd } = await import("../../packages/kernel/test/helpers/index.ts");
  writerPanelId = randomUUID();
  const panel = PanelSpec.parse({
    panelId: writerPanelId,
    schemaVersion: 1,
    kind: "timeSeries",
    title: "chaos",
    queryRef: { hash: "d".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["day", "v"], units: { v: "count" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "day", y: ["v"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "on_watermark" },
    provenanceRequired: true,
  });
  const version = (await k.workspaces.get(session, workspaceId)).version;
  await runCmd(
    k,
    session,
    workspaceId,
    "canvas.apply_patch",
    {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: randomUUID(),
      expectedRevision: 0,
      operations: [{ op: "addPanel", panel }],
    },
    version,
  );
}

async function applyFault(
  f: Fault,
  workers: { w: Array<{ kill(): Promise<void>; stop(): Promise<void> }>; fx: ChildProcess[] },
) {
  const replace = async () => {
    await sleep(2500);
    workers.w.push(await spawnW(`wr-${Date.now()}`));
    workers.fx.push(startFxWorker(`fxr-${Date.now()}`));
  };
  const pgReset = async () => {
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      await kdb.admin
        .query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'nearesis_app' AND pid <> pg_backend_pid()",
        )
        .catch(() => undefined);
      await env.db.admin
        .query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'nearesis_app' AND pid <> pg_backend_pid()",
        )
        .catch(() => undefined);
      await sleep(200);
    }
  };
  const killWorkers = async () => {
    await workers.w.shift()?.kill();
    workers.fx.shift()?.kill("SIGKILL");
  };
  switch (f) {
    case "kill_worker":
      await killWorkers();
      await replace();
      break;
    case "restart_api":
      await app.close();
      await sleep(1500);
      app = await buildApi();
      break;
    case "restart_redis":
      await stackAsync("restart", "redis");
      break;
    case "restart_clickhouse":
      await stackAsync("restart", "clickhouse");
      break;
    case "restart_cube":
      await stackAsync("restart", "cube");
      break;
    case "restart_temporal":
      await stackAsync("restart", "temporal");
      break;
    case "restart_postgres":
      await stackAsync("restart", "postgres");
      break;
    case "reset_pg_connections":
      await pgReset();
      break;
    case "partition_temporal":
      await stackAsync("pause", "temporal");
      await sleep(th.partitionMs!);
      await stackAsync("unpause", "temporal");
      break;
    case "combined":
      await killWorkers();
      await stackAsync("restart", "redis");
      await stackAsync("restart", "clickhouse");
      await stackAsync("pause", "temporal");
      await sleep(th.partitionMs!);
      await stackAsync("unpause", "temporal");
      await replace();
      break;
  }
}

/** The Temporal result long-poll can time out while a component is down: retry the poll, never the workflow. */
async function resultWithRetry(r: { result(): Promise<{ state: string }> }, since: number) {
  for (;;) {
    try {
      return await r.result();
    } catch (e) {
      const transient =
        (e as Error).name === "ServiceError" || /DEADLINE_EXCEEDED|UNAVAILABLE/.test(String(e));
      if (!transient || Date.now() - since > th.recoveryDeadlineMs!) throw e;
      await sleep(1000);
    }
  }
}

const pct = (xs: number[], p: number) =>
  xs.length
    ? percentile(
        [...xs].sort((a, b) => a - b),
        p,
      )
    : 0;

it("PERF11: every fault recovers with no duplicate side effects and consistent state", async () => {
  if (!g.ok && !DRYRUN) {
    observe({ testId: "PERF11", observed: "not executed", blocked: g.reason });
    return;
  }
  if (blocked) {
    observe({ testId: "PERF11", observed: "not executed", blocked });
    return;
  }
  const fixtureHash = sha256Text(JSON.stringify(FIXTURE_SPEC));
  if (DRYRUN) process.stderr.write(`FIXTUREHASH PERF11 ${fixtureHash}\n`);
  if (g.ok) expect(referenceB().fixtures.PERF11).toBe(fixtureHash);
  const { evaluateAndAlert, kernelAlertSink, emitAlert } =
    await import("../../packages/agent-runtime/src/index.ts");
  const { createWs } = await import("../../packages/kernel/test/helpers/index.ts");
  const q = (sql: string, params: unknown[] = []) => env.db.admin.query(sql, params);
  const sink = kernelAlertSink(k);
  // DELIVERY: the production sink (platform alerts are an audit row) plus a fault-scoped copy delivered to a dedicated
  // workspace as a `notification.created` journal event. `dropAll` makes the sink accept and silently drop (negative control).
  const { workspaceId: alertWs } = await createWs(k, session, "perf11 alerts");
  const orgId = session.principal.orgId;
  let currentFault = "baseline";
  let dropAll = false;
  const deliverySink = {
    async send(a: Parameters<typeof sink.send>[0]) {
      if (dropAll) return;
      await sink.send(a);
      await sink.send({
        ...a,
        tenantId: orgId,
        workspaceId: alertWs,
        key: `${a.key}:${currentFault}`,
        detail: { ...a.detail, fault: currentFault },
      });
    },
  };
  /** Isolated alert window per fault: the duplicate look-back is shorter than the gap between two faults, so a page for an earlier fault never suppresses this one; duplicates inside one fault are still suppressed. */
  const FAULT_ALERT_CAPS = { maxPerWindow: 100, windowSeconds: 3, cooldownSeconds: 0 };
  const storeNotifications = async (): Promise<DeliveredNotification[]> =>
    (
      await kdb.admin.query(
        "SELECT payload FROM workspace_events WHERE workspace_id = $1 AND event_type = 'notification.created' ORDER BY seq",
        [alertWs],
      )
    ).rows.map((r: { payload: { alertKey: string; fault?: string } }) => ({
      alertKey: r.payload.alertKey,
      fault: r.payload.fault ?? "",
    }));
  const subscriberNotifications = async (): Promise<DeliveredNotification[]> => {
    const { SseParser } = await import("../../apps/web/src/lib/event-store.ts");
    const ctrl = new AbortController();
    const out: DeliveredNotification[] = [];
    const res = await fetch(`http://127.0.0.1:${API_PORT}/v1/workspaces/${alertWs}/events`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", "last-event-id": "0" },
      signal: ctrl.signal,
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();
    const stopAt = Date.now() + 4000;
    try {
      while (Date.now() < stopAt) {
        const { value, done } = await Promise.race([
          reader.read(),
          sleep(Math.max(1, stopAt - Date.now())).then(() => ({ value: undefined, done: true })),
        ]);
        if (done) break;
        for (const f of parser.push(value!))
          if (f.event === "notification.created") {
            const d = (JSON.parse(f.data) as { data?: { alertKey?: string; fault?: string } }).data;
            if (d?.alertKey) out.push({ alertKey: d.alertKey, fault: d.fault ?? "" });
          }
      }
    } finally {
      ctrl.abort();
    }
    return out;
  };
  const deliveryVerdicts: Array<{
    fault: string;
    expected: boolean;
    sent: number;
    delivered: number;
    problems: string[];
  }> = [];
  const expectedFaults: string[] = [];

  const { workspaceId } = await createWs(k, session, "perf11 journal");
  await seedWriterPanel(workspaceId);
  const probeP = probeLoop();
  const writerP = writerLoop(workspaceId);
  const workers = {
    w: [await spawnW("w1"), await spawnW("w2")] as Array<{ kill(): Promise<void>; stop(): Promise<void> }>,
    fx: [startFxWorker("fx1"), startFxWorker("fx2")],
  };

  // ---- clean baseline: no SLO alert, all probes healthy
  await sleep(20_000);
  const baseline = await evaluateAndAlert(kdb.app.pool, sink, new Date());
  const baselineProbes = probes.length;
  const baselineBad = probes.filter((p) => !(p.api && p.redis && p.clickhouse && p.cube)).length;
  expect(baseline.sent).toBe(0);

  const timeline: Array<Record<string, unknown>> = [];
  const allJobs: string[] = [];
  const invStats: Array<{
    fault: string;
    runs: number;
    complete: number;
    duplicates: unknown[];
    charges: number;
    inference: number;
    recoveryMs: number;
  }> = [];
  let sloAtPostgresOutage: unknown = null;
  const alertRecords: unknown[] = [];

  const only = DRYRUN && process.env.PERF_ONLY ? process.env.PERF_ONLY.split(",") : null; // harness development only
  for (const fault of FAULTS.filter((f) => !only || only.includes(f))) {
    // order matters only for SLO attribution: the Postgres restart is evaluated on the data of its own window
    const tStart = Date.now();
    const runs = await Promise.all(
      Array.from({ length: th.investigationsPerFault! }, () => h.runInvestigation(env, "basic")),
    );
    const jobIds = Array.from({ length: th.effectJobsPerFault! }, (_, i) => `${fault}-${i}`);
    allJobs.push(...jobIds);
    await seedJobs(env.db.admin, env.tenantId, jobIds);
    await sleep(3500); // work is in flight
    const tFault = Date.now();
    await applyFault(fault, workers);
    const tFaultEnd = Date.now();
    if (DRYRUN)
      for (const [id, log] of workerLogs)
        if (/Error|rror:/.test(log)) process.stderr.write(`DRYRUN worker ${id} stderr: ${log}\n`);
    if (DRYRUN)
      process.stderr.write(
        `DRYRUN workers after ${fault}: ${JSON.stringify(
          [...workers.w, ...workers.fx].map((w) => {
            const p = (w as { proc?: ChildProcess }).proc ?? (w as unknown as ChildProcess);
            return { exit: p.exitCode, signal: p.signalCode };
          }),
        )}\n`,
      );
    // recovery: every probe healthy again for 3 consecutive cycles
    const healthyAgain = await until(async () => {
      const last = probes.slice(-3);
      return (
        last.length === 3 && last.every((p) => p.at > tFaultEnd && p.api && p.redis && p.clickhouse && p.cube)
      );
    }, th.recoveryDeadlineMs!);
    // investigations terminal and jobs done within the declared recovery time
    const remaining = () => Math.max(1000, th.recoveryDeadlineMs! - (Date.now() - tFaultEnd));
    const results = await Promise.race([
      Promise.all(runs.map((r: { result(): Promise<{ state: string }> }) => resultWithRetry(r, tFaultEnd))),
      sleep(remaining()).then(() => null),
    ]);
    const jobsDone = await until(
      async () =>
        Number(
          (
            await q(
              "SELECT count(*)::int AS n FROM runtime.fx_jobs WHERE job_id = ANY($1) AND state = 'done'",
              [jobIds],
            )
          ).rows[0].n,
        ) === jobIds.length,
      remaining(),
      500,
    );
    const recoveryMs = Date.now() - tFaultEnd;
    const window = probes.filter((p) => p.at >= tFault && p.at <= Date.now());
    const total = window.length * 4;
    const failures = window.reduce(
      (n, p) => n + [p.api, p.redis, p.clickhouse, p.cube].filter((x) => !x).length,
      0,
    );
    const apiBad = window.filter((p) => !p.api).length;
    // (d) alert delivery. Production multi-window SLO rules (api_availability) plus one probe alert per component the
    // blackbox probes saw unavailable in this fault's window; every alert goes through the production decision (dedupe,
    // cap) and the delivery sink, under this fault's own dedupe key and isolated window.
    currentFault = fault;
    await slo.flush().catch(() => undefined);
    const evAt = new Date();
    const ev = await evaluateAndAlert(kdb.app.pool, deliverySink, evAt, { caps: FAULT_ALERT_CAPS }).catch(
      (e: Error) => ({ error: e.message }) as never,
    );
    const firing = (ev as { statuses?: Array<{ slo: { id: string }; firing: unknown[] }> }).statuses
      ?.filter((s) => s.firing.length)
      .map((s) => s.slo.id);
    const failedComponents = (["api", "redis", "clickhouse", "cube"] as const).filter((c) =>
      window.some((p) => !p[c]),
    );
    let probeSent = 0;
    let probeDuplicateOk = true;
    for (const c of failedComponents) {
      const alert = {
        tenantId: null,
        workspaceId: null,
        key: `probe:${c}`,
        kind: "probe.component_down",
        severity: "critical" as const,
        title: `Blackbox probe: ${c} unavailable during ${fault}`,
        detail: { component: c, failedProbes: window.filter((p) => !p[c]).length, probes: window.length },
      };
      const r1 = await emitAlert(kdb.app.pool, deliverySink, alert, FAULT_ALERT_CAPS, evAt);
      if (r1.status === "sent") probeSent++;
      // correct de-duplication INSIDE the fault window is preserved: the same alert again is a duplicate
      const r2 = await emitAlert(
        kdb.app.pool,
        deliverySink,
        alert,
        FAULT_ALERT_CAPS,
        new Date(evAt.getTime() + 500),
      );
      if (!(r2.status === "suppressed" && r2.reason === "duplicate")) probeDuplicateOk = false;
    }
    const expectedAlert = failedComponents.length > 0;
    if (expectedAlert) expectedFaults.push(fault);
    const storeNow = (await storeNotifications()).filter((n) => n.fault === fault);
    const sentSlo = (ev as { sent?: number }).sent ?? 0;
    if (fault === "restart_postgres")
      sloAtPostgresOutage = {
        firing,
        sent: sentSlo,
        suppressed: (ev as { suppressed?: number }).suppressed,
        error: (ev as { error?: string }).error,
        deliveredToStore: storeNow.map((n) => n.alertKey),
      };
    alertRecords.push({
      fault,
      expectedAlert,
      failedComponents,
      firing,
      sloSent: sentSlo,
      probeAlertsSent: probeSent,
      probeDuplicateSuppressed: probeDuplicateOk,
      deliveredToStore: storeNow.map((n) => n.alertKey),
    });
    deliveryVerdicts.push({
      fault,
      expected: expectedAlert,
      sent: sentSlo + probeSent,
      delivered: storeNow.length,
      problems: probeDuplicateOk ? [] : [`in-window duplicate of a ${fault} probe alert was not suppressed`],
    });
    // (a)/(b) investigations: all COMPLETE, effects accepted once, charges one per accepted inference
    const complete = results ? results.filter((r: { state: string }) => r.state === "COMPLETE").length : 0;
    const runIds = runs.map((r: { runId: string }) => r.runId);
    const eff = (
      await q(
        "SELECT effect_key, kind, guarantee, provider_calls, status FROM runtime.agent_side_effects WHERE run_id = ANY($1) AND kind <> 'fault'",
        [runIds],
      )
    ).rows as LedgerRow[];
    const inference = eff.filter((e) => e.kind === "inference");
    const charges = (
      await q("SELECT entry_key FROM runtime.budget_ledger WHERE run_id = ANY($1) AND kind='charge'", [
        runIds,
      ])
    ).rows;
    const notDone = eff.filter((e) => e.status !== "done");
    const internalDup = eff.filter((e) => e.guarantee === "internal" && e.provider_calls !== 1);
    invStats.push({
      fault,
      runs: runs.length,
      complete,
      duplicates: inference
        .filter((e) => e.provider_calls > 1)
        .map((e) => ({ key: e.effect_key, providerCalls: e.provider_calls })),
      charges: charges.length,
      inference: inference.length,
      recoveryMs,
    });
    timeline.push({
      fault,
      startedAt: new Date(tFault).toISOString(),
      endedAt: new Date(tFaultEnd).toISOString(),
      faultMs: tFaultEnd - tFault,
      batchMs: Date.now() - tStart,
      probesHealthyAgainMs: healthyAgain,
      recoveryMs,
      declaredRecoveryMs: th.recoveryDeadlineMs,
      investigationsComplete: `${complete}/${runs.length}`,
      jobsDone: jobsDone !== null,
      availability: total ? Math.round(((total - failures) / total) * 100000) / 1000 : null,
      probeFailures: failures,
      apiUnavailableCycles: apiBad,
      errorBudgetBurn: apiBad && window.length ? Math.round((apiBad / window.length / 0.005) * 10) / 10 : 0,
      ledgerNotDone: notDone.length,
      internalEffectsNotExactlyOnce: internalDup.length,
    });
    if (DRYRUN) process.stderr.write(`DRYRUN fault ${JSON.stringify(timeline.at(-1))}\n`);
    expect(
      results,
      `investigations of ${fault} did not all terminate within ${th.recoveryDeadlineMs} ms`,
    ).not.toBeNull();
    expect(complete).toBe(runs.length);
    expect(jobsDone, `effect jobs of ${fault} did not finish`).not.toBeNull();
    expect(healthyAgain, `components not healthy again after ${fault}`).not.toBeNull();
    expect(notDone).toHaveLength(0);
    expect(internalDup).toHaveLength(0);
    expect(charges.length).toBe(inference.length);
    expect(new Set(charges.map((c: { entry_key: string }) => c.entry_key)).size).toBe(charges.length);
    for (const e of inference) expect(e.provider_calls).toBeLessThanOrEqual(2);
  }

  // ---- stop load, drain, reconcile
  writerStop = true;
  await writerP;
  await sleep(1500);
  probing = false;
  await probeP;
  await kdb.admin.query("SELECT 1");
  const drained = await until(
    async () =>
      Number(
        (await kdb.admin.query("SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL")).rows[0].n,
      ) === 0,
    60_000,
    500,
  );
  expect(drained).not.toBeNull();

  // (b)/(e) side-effect ledger of the effect pipeline vs the providers' own records
  const fxLedger = (
    await q(
      "SELECT effect_key, kind, guarantee, provider_calls, status FROM runtime.agent_side_effects WHERE effect_key LIKE 'fx:%'",
    )
  ).rows as LedgerRow[];
  const paidAcceptedByJob = new Map(
    allJobs.map((j) => [
      paidKeyFor(j),
      [...mock.paid.accepted].filter((k2) => k2 === paidKeyFor(j) || k2.startsWith(`${paidKeyFor(j)}:`))
        .length,
    ]),
  );
  const chainByJob = new Map(
    allJobs.map((j) => [txHashFor(j), mock.chain.broadcasts.get(txHashFor(j)) ?? 0]),
  );
  const effects = judgeEffects({
    ledger: fxLedger,
    paidAccepted: paidAcceptedByJob,
    chainBroadcasts: chainByJob,
    expectedPaid: allJobs.map(paidKeyFor),
    expectedChain: allJobs.map(txHashFor),
  });
  const paidRedeliveries = [...mock.paid.deliveries.values()].filter((n) => n > 1).length;
  const chainLookups = [...mock.chain.lookups.values()].reduce((a, b) => a + b, 0);
  const chainBroadcastTotal = [...mock.chain.broadcasts.values()].reduce((a, b) => a + b, 0);
  const claimsRetried = Number(
    (await q("SELECT count(*)::int AS n FROM runtime.fx_jobs WHERE attempts > 1")).rows[0].n,
  );
  expect(effects.problems).toEqual([]);
  expect(chainBroadcastTotal).toBe(allJobs.length);

  // (c) journal, outbox, consumers, panels
  const events = (
    await kdb.admin.query("SELECT seq, event_id FROM workspace_events WHERE workspace_id = $1", [workspaceId])
  ).rows;
  const journal = judgeJournal(events);
  const cmdRows = Number(
    (
      await kdb.admin.query(
        "SELECT count(*)::int AS n FROM commands WHERE workspace_id = $1 AND command_type = 'canvas.apply_patch'",
        [workspaceId],
      )
    ).rows[0].n,
  );
  const dupEffects = Number(
    (
      await kdb.admin.query(
        "SELECT count(*)::int AS n FROM (SELECT event_id FROM perf11_consumer_effects GROUP BY event_id HAVING count(*) > 1) d",
      )
    ).rows[0].n,
  );
  const receipts = Number(
    (
      await kdb.admin.query(
        "SELECT count(*)::int AS n FROM consumer_receipts WHERE consumer = 'perf11.effect'",
      )
    ).rows[0].n,
  );
  const allEvents = Number(
    (await kdb.admin.query("SELECT count(*)::int AS n FROM workspace_events")).rows[0].n,
  );
  const doc = await k.canvas.get(session, workspaceId);
  const panelIds = (doc.panels ?? []).map((p: { panelId: string }) => p.panelId);
  expect(journal.problems).toEqual([]);
  expect(cmdRows).toBe(acked.size + 1); // + the initial addPanel
  expect(acked.size).toBeGreaterThanOrEqual(th.journalCommandsMin!);
  expect(dupEffects).toBe(0);
  expect(receipts).toBe(allEvents);
  expect(panelIds).toEqual([writerPanelId]);
  expect(doc.documentRevision).toBe(acked.size + 1); // initial add + one revision per acknowledged command

  // (d) every fault that made a probed component unavailable produced a DELIVERED alert: a notification.created event in the
  // notification store (journal) and on a subscriber's SSE stream, under that fault's own key
  const storeAll = await storeNotifications();
  const viaSse = await subscriberNotifications();
  const deliveryJudged = deliveryVerdicts.map((v) => ({
    ...v,
    ...judgeAlertDelivery({
      fault: v.fault,
      expected: v.expected,
      delivered: storeAll,
      viaSubscriber: viaSse,
    }),
  }));
  for (const v of deliveryJudged)
    expect(v.problems, `alert delivery for fault ${v.fault}: ${JSON.stringify(v)}`).toEqual([]);
  expect(expectedFaults.length, "at least one fault must have produced an alert").toBeGreaterThan(0);
  if (!only || only.includes("restart_postgres")) expect(expectedFaults).toContain("restart_postgres");
  const sloRows = (
    await kdb.admin.query("SELECT action, subject FROM audit_events WHERE action = 'alert.slo.burn'")
  ).rows;
  // ---- negative control (alert sink broken): the sink accepts and drops every alert => the same judge must FAIL
  const dropFault = "control_dropped_sink";
  currentFault = dropFault;
  dropAll = true;
  const dropAt = new Date(Date.now() + 10_000); // outside every earlier fault's duplicate window
  const dropSent = await emitAlert(
    kdb.app.pool,
    deliverySink,
    {
      tenantId: null,
      workspaceId: null,
      key: "probe:control",
      kind: "probe.component_down",
      severity: "critical",
      title: "control alert into a broken sink",
      detail: {},
    },
    FAULT_ALERT_CAPS,
    dropAt,
  );
  dropAll = false;
  const dropJudge = judgeAlertDelivery({
    fault: dropFault,
    expected: true,
    delivered: await storeNotifications(),
    viaSubscriber: await subscriberNotifications(),
  });
  expect(dropSent.status).toBe("sent"); // the decision layer said "sent": only delivery distinguishes working from broken
  expect(dropJudge.ok, "a broken alert sink must be judged FAIL").toBe(false);
  if (!only || only.includes("restart_postgres")) expect(sloRows.length).toBeGreaterThanOrEqual(1);
  const deliveryControl = {
    decision: dropSent.status,
    judgedFail: !dropJudge.ok,
    problems: dropJudge.problems,
  };

  // ---- negative control: identical injected crashes, no idempotency keys, no lookup => must FAIL (b) and (e)
  const injectOnce = () => {
    let done = false;
    return () => {
      if (!done) {
        done = true;
        throw new Error("injected crash");
      }
    };
  };
  const runControl = async (mode: "idempotent" | "naive", tag: string) => {
    const m2 = await startMockProvider(50);
    const ids = Array.from({ length: 10 }, (_, i) => `${tag}-${i}`);
    // a tenant of its own: the background effect workers only claim jobs of the run's tenant
    const jobs = await seedJobs(env.db.admin, randomUUID(), ids);
    for (const j of jobs) {
      const hooks = { afterPaidSent: injectOnce(), afterChainSent: injectOnce() };
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await processJob(env.db.app, j, m2.url, mode, hooks);
          break;
        } catch (e) {
          /* the crash: the process retries the whole job */
          if (DRYRUN)
            process.stderr.write(
              `DRYRUN control ${mode} ${j.job_id} attempt ${attempt}: ${(e as Error).message}\n`,
            );
        }
      }
    }
    const ledger = (
      await q(
        "SELECT effect_key, kind, guarantee, provider_calls, status FROM runtime.agent_side_effects WHERE effect_key LIKE $1",
        [`fx:${tag}-%`],
      )
    ).rows as LedgerRow[];
    const verdict = judgeEffects({
      ledger: ledger.map((r) => ({ ...r, status: "done" })),
      paidAccepted: new Map(
        ids.map((j) => [
          paidKeyFor(j),
          [...m2.paid.accepted].filter((k2) => k2 === paidKeyFor(j) || k2.startsWith(`${paidKeyFor(j)}:`))
            .length,
        ]),
      ),
      chainBroadcasts: new Map(ids.map((j) => [txHashFor(j), m2.chain.broadcasts.get(txHashFor(j)) ?? 0])),
      expectedPaid: ids.map(paidKeyFor),
      expectedChain: ids.map(txHashFor),
    });
    const lookups = [...m2.chain.lookups.values()].reduce((a, b) => a + b, 0);
    await m2.close();
    void claimJob;
    void finishJob;
    return { verdict, lookups };
  };
  const subject = await runControl("idempotent", "ctlok");
  const control = await runControl("naive", "ctlbad");
  expect(subject.verdict.problems).toEqual([]);
  expect(subject.lookups).toBeGreaterThan(0); // pending writes resolved by lookup
  expect(control.verdict.ok).toBe(false); // the naive worker is detected as duplicating effects
  expect(control.verdict.problems.some((p) => p.startsWith("paid effect"))).toBe(true);
  expect(control.verdict.problems.some((p) => p.startsWith("chain tx"))).toBe(true);

  const worstRecovery = Math.max(...invStats.map((s) => s.recoveryMs));
  if (DRYRUN) {
    process.stderr.write(
      `DRYRUN summary ${JSON.stringify({ baselineProbes, baselineBad, writerAcked: acked.size, worstRecovery, paidRedeliveries, chainLookups, claimsRetried, sloAtPostgresOutage, alertDelivery: deliveryJudged, deliveryControl, controlProblems: control.verdict.problems.slice(0, 3) })}\n`,
    );
    return;
  }
  observe({
    testId: "PERF11",
    observed: `${FAULTS.length} fault cases (${FAULTS.join(", ")}) on the isolated stack, each with ${th.investigationsPerFault} concurrent investigations, ${th.effectJobsPerFault} side-effect jobs and live command/probe load: all investigations COMPLETE within the declared ${th.recoveryDeadlineMs} ms (worst recovery ${worstRecovery} ms); ${allJobs.length} paid API effects accepted exactly once (${paidRedeliveries} idempotent redeliveries deduped by the provider) and ${allJobs.length} chain writes broadcast exactly once (${chainLookups} lookups resolved pending writes, ${chainBroadcastTotal} broadcasts); inference duplicates disclosed per fault; journal ${events.length} events seq 1..n with no gap or duplicate, ${acked.size} acknowledged commands each exactly once, ${allEvents} events with ${receipts} consumer receipts and 0 duplicate logical effects, panel ${writerPanelId.slice(0, 8)} unchanged in identity at revision ${doc.documentRevision} (= ${acked.size} acknowledged commands + the initial add); availability and error-budget burn recorded per fault; SLO burn alert fired for the Postgres outage (${JSON.stringify(sloAtPostgresOutage)}). Negative control (fresh key per attempt, no lookup, identical crashes) FAILED as required: ${control.verdict.problems.slice(0, 2).join("; ")}`,
    fixtureHash,
    evidence: {
      ...evidenceBase(g, {
        dataset: { id: "perf11 fault script (SYNTHETIC)", sha256: fixtureHash, spec: FIXTURE_SPEC },
        concurrency: {
          investigationsPerFault: th.investigationsPerFault,
          effectJobsPerFault: th.effectJobsPerFault,
        },
        cacheState: "warm services, cold restarts per fault",
      }),
      hardware: { cpu: cpus()[0]!.model, cores: cpus().length, ramGiB: Math.round(totalmem() / 2 ** 30) },
      timeline,
      investigations: invStats,
      sloAlerts: alertRecords,
      sloAtPostgresOutage,
      alertDelivery: deliveryJudged,
      alertDeliveryControl: deliveryControl,
      baseline: { probes: baselineProbes, unhealthy: baselineBad, alertsSent: baseline.sent },
      ledger: {
        rows: fxLedger.length,
        paidRedeliveries,
        chainLookups,
        chainBroadcasts: chainBroadcastTotal,
        claimsRetried,
      },
      journal: {
        events: events.length,
        acked: acked.size,
        commandRows: cmdRows,
        receipts,
        allEvents,
        duplicateConsumerEffects: dupEffects,
      },
      control: { problems: control.verdict.problems, lookups: control.lookups },
      p95RecoveryMs: pct(
        invStats.map((s) => s.recoveryMs),
        95,
      ),
    },
  });
}, 3_600_000);
