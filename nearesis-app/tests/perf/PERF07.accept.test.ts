/**
 * PERF07: monitor trigger to task record p95 < 10 s after the ingestion watermark, and SSE propagation p95 < 1 s after
 * commit (ch.13). Real kernel + Postgres + API. 100 enabled rules (10 workspaces x 10) on one source, 200 watermark
 * events published at a steady 2/s into the inbox and consumed by the production scheduler loop (2 s scan interval, the
 * monitoring route's default); 20 SSE clients (the web EventStore on the real /events stream) on one workspace while
 * 500 commands commit there (the last 100 unpaced, as a burst). Both trigger timestamps come from the database clock
 * (inbox row recorded_at, task visible at a count poll); the SSE timestamps are all taken in this process, so no clock
 * offset enters either figure (the DB/host offset is measured and reported anyway).
 * Negative control: the same loop scanning every 15 s must FAIL the trigger-latency judgement.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { PanelSpec } from "../../packages/contracts/src/index.ts";
import { buildApp } from "../../apps/api/src/index.ts";
import { EventStore, SseParser } from "../../apps/web/src/lib/event-store.ts";
import {
  createTestDb,
  createWs,
  loginSession,
  runCmd,
  seedOrg,
  testKernel,
} from "../../packages/kernel/test/helpers/index.ts";
import type { TestDb } from "../../packages/kernel/test/helpers/index.ts";
import type { Kernel, Session } from "../../packages/kernel/src/index.ts";
import { DRYRUN, percentile, sha256Text, stats } from "./_reference.ts";
import { evidenceBase, gateB, histogram, referenceB, thr } from "./_b.ts";

const th = thr("PERF07");
const WORKSPACES = 10;
const RULES_PER_WS = 10;
const SOURCE = "perf07.source";
const API_PORT = 4757;
const SCAN_MS = 2000; // monitoring route default (apps/api monitoring-routes background.intervalMs)
const WM_RATE_MS = 500; // 2 watermarks per second
const CMD_RATE_MS = 100; // 10 commands per second, then the burst
const BURST = 100;
const wm = (i: number) => new Date(Date.UTC(2026, 9, 28, 0, 0, i)).toISOString();
export const FIXTURE_SPEC = {
  rules: th.rules,
  workspaces: WORKSPACES,
  watermarks: th.watermarks,
  watermarkRateMs: WM_RATE_MS,
  scanIntervalMs: SCAN_MS,
  sseClients: th.sseClients,
  commands: th.commands,
  commandRateMs: CMD_RATE_MS,
  burstTail: BURST,
  coalesceMsClient: 250,
  condition: { kind: "compare", metricId: "queue_depth", op: "gt", value: 0 },
  controlScanMs: 15000,
};

/** The judgement functions are pure so the negative control runs the very same code as the real run. */
export const triggerPasses = (ms: number[], boundMs: number) =>
  ms.length > 0 &&
  percentile(
    [...ms].sort((a, b) => a - b),
    95,
  ) < boundMs;
export const ssePasses = (ms: number[], boundMs: number) =>
  ms.length > 0 &&
  percentile(
    [...ms].sort((a, b) => a - b),
    95,
  ) < boundMs;

let db: TestDb;
let k: Kernel;
let s: Session;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let token = "";
let subject = "";
const g = gateB(import.meta.url);
beforeAll(async () => {
  if (!g.ok && !DRYRUN) return;
  db = await createTestDb();
  k = testKernel(db);
  await k.boot();
  k.outbox.start();
  const org = await seedOrg(db.admin, "perf07", { alice: "owner" });
  subject = org.users.alice!.subject;
  s = await loginSession(k, subject);
  token = await k.devAuth!.login(subject);
  app = await buildApp({ kernel: k, nodeEnv: "test" }); // default SSE poll (250 ms)
  await app.listen({ host: "127.0.0.1", port: API_PORT });
}, 120_000);
afterAll(async () => {
  k?.outbox.stop?.();
  await app?.close();
  await db?.drop();
}, 60_000);

const panel = () =>
  PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: "Queue depth",
    queryRef: { hash: "c".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["day", "v"], units: { v: "count" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "day", y: ["v"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "on_watermark" },
    provenanceRequired: true,
  });

interface Client {
  store: EventStore;
  recv: Map<number, number>;
  applied: Map<number, number>;
  batches: number[];
  stop: () => void;
  done: Promise<void>;
  reloads: string[];
}
function sseClient(url: string): Client {
  const recv = new Map<number, number>();
  const applied = new Map<number, number>();
  const batches: number[] = [];
  const reloads: string[] = [];
  const store = new EventStore({
    coalesceMs: 250,
    maxPending: 1000,
    onBatch: (b) => {
      const t = performance.now();
      batches.push(b.length);
      for (const e of b) applied.set(e.seq, t);
    },
    onReloadRequired: (r) => reloads.push(r.reason),
  });
  const ctrl = new AbortController();
  const done = (async () => {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", "last-event-id": "0" },
      signal: ctrl.signal,
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) return;
        for (const f of parser.push(value)) {
          if (f.id) recv.set(Number(f.id), performance.now());
          store.handleFrame(f);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") throw e;
    }
  })();
  return { store, recv, applied, batches, reloads, stop: () => ctrl.abort(), done };
}

it("PERF07: monitor trigger to task p95 < 10 s and SSE commit to client p95 < 1 s under load", async () => {
  if (!g.ok && !DRYRUN) {
    observe({ testId: "PERF07", observed: "not executed", blocked: g.reason });
    return;
  }
  const fixtureHash = sha256Text(JSON.stringify(FIXTURE_SPEC));
  if (DRYRUN) process.stderr.write(`FIXTUREHASH PERF07 ${fixtureHash}\n`);
  if (g.ok) expect(referenceB().fixtures.PERF07).toBe(fixtureHash);
  const q = async <T>(text: string, params: unknown[] = []) =>
    (await db.admin.query(text, params)).rows as T[];
  const ver = async (ws: string) => (await k.workspaces.get(s, ws)).version;

  // ---- seed: 10 workspaces x 10 enabled rules; workspace 0 doubles as the SSE workspace
  const wsIds: string[] = [];
  let ruleCount = 0;
  let streamPanel!: PanelSpec;
  for (let w = 0; w < WORKSPACES; w++) {
    const { workspaceId } = await createWs(k, s, `perf07 ${w}`);
    wsIds.push(workspaceId);
    const p = panel();
    if (w === 0) streamPanel = p;
    await runCmd(
      k,
      s,
      workspaceId,
      "canvas.apply_patch",
      {
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: randomUUID(),
        expectedRevision: 0,
        operations: [{ op: "addPanel", panel: p }],
      },
      await ver(workspaceId),
    );
    const markerId = randomUUID();
    await runCmd(
      k,
      s,
      workspaceId,
      "marker.create",
      { panelId: p.panelId, markerId, anchor: { kind: "time_point", at: wm(0) }, question: "queue depth" },
      await ver(workspaceId),
    );
    for (let r = 0; r < RULES_PER_WS; r++) {
      await runCmd(
        k,
        s,
        workspaceId,
        "monitor.rule_create",
        {
          ruleId: randomUUID(),
          name: `rule ${w}.${r}`,
          markerId,
          sourceId: SOURCE,
          condition: FIXTURE_SPEC.condition,
          action: "investigate",
          debounceSeconds: 0,
          cooldownSeconds: 0,
        },
        await ver(workspaceId),
      );
      ruleCount++;
    }
  }
  expect(ruleCount).toBe(th.rules);
  const sseWs = wsIds[0]!;
  const sseUrl = `http://127.0.0.1:${API_PORT}/v1/workspaces/${sseWs}/events`;

  // clock: DB clock vs this process (reported; the trigger figures use the DB clock only)
  const offs: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = Date.now();
    const r = (
      await q<{ ms: number }>("SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms")
    )[0]!;
    const t1 = Date.now();
    offs.push(r.ms - (t0 + t1) / 2);
  }
  offs.sort((a, b) => a - b);
  const clockOffsetMs = Math.round(offs[Math.floor(offs.length / 2)]! * 10) / 10;

  // ---- 20 SSE clients
  const clients = Array.from({ length: th.sseClients! }, () => sseClient(sseUrl));

  // ---- trigger side: scheduler loop + count poller
  const complete = new Map<string, number>(); // watermark iso -> DB-clock ms when all its tasks were visible
  const runTriggerPhase = async (first: number, count: number, scanMs: number) => {
    const sched = k.monitorScheduler();
    sched.start(scanMs);
    const producer = k.monitorScheduler();
    const wms = Array.from({ length: count }, (_, i) => wm(first + i));
    let stop = false;
    const poller = (async () => {
      while (!stop) {
        const pending = wms.filter((w) => !complete.has(w));
        if (pending.length) {
          const rows = await q<{ wm: Date; c: number; now: number }>(
            `SELECT tr.watermark AS wm, count(*)::int AS c, (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now
               FROM marker_tasks mt JOIN monitor_triggers tr ON tr.id = mt.trigger_id
              WHERE tr.watermark >= $1 GROUP BY tr.watermark`,
            [pending[0]],
          );
          for (const r of rows)
            if (r.c >= th.rules! && !complete.has(r.wm.toISOString()))
              complete.set(r.wm.toISOString(), r.now);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    for (let i = 0; i < count; i++) {
      const t0 = Date.now();
      await producer.enqueue({
        sourceId: SOURCE,
        watermark: wms[i]!,
        mode: "live",
        values: { queue_depth: 10 + first + i },
        maturity: "final",
      });
      const wait = WM_RATE_MS - (Date.now() - t0);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    const deadline = Date.now() + 120_000;
    while (wms.some((w) => !complete.has(w)) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 200));
    stop = true;
    await poller;
    await sched.stop();
    return wms;
  };

  // ---- command side: sequential commits, 10/s, the last BURST unpaced
  const issued: number[] = [];
  const acked: number[] = [];
  const commandPhase = (async () => {
    let doc = await k.canvas.get(s, sseWs);
    let revision = doc.documentRevision;
    for (let i = 0; i < th.commands!; i++) {
      const t0 = performance.now();
      issued.push(t0);
      await runCmd(
        k,
        s,
        sseWs,
        "canvas.apply_patch",
        {
          schemaVersion: 1,
          type: "workspace.patch",
          operationId: randomUUID(),
          expectedRevision: revision,
          operations: [
            { op: "movePanel", panelId: streamPanel.panelId, layout: { ...streamPanel.layout, x: i % 6 } },
          ],
        },
        await ver(sseWs),
      );
      revision += 1;
      acked.push(performance.now());
      if (i < th.commands! - BURST) {
        const wait = CMD_RATE_MS - (performance.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }
    doc = await k.canvas.get(s, sseWs);
    return doc;
  })();

  const wms = await runTriggerPhase(0, th.watermarks!, SCAN_MS);
  await commandPhase;
  // let every client catch up to the journal head
  const head = Number(
    (
      await q<{ m: string }>("SELECT coalesce(max(seq),0) m FROM workspace_events WHERE workspace_id=$1", [
        sseWs,
      ])
    )[0]!.m,
  );
  const catchUp = Date.now() + 30_000;
  while (clients.some((c) => c.store.lastSeq < head) && Date.now() < catchUp)
    await new Promise((r) => setTimeout(r, 100));
  for (const c of clients) c.store.flush();
  clients.forEach((c) => c.stop());
  await Promise.all(clients.map((c) => c.done));

  // ---- trigger latency (DB clock on both ends)
  const events = await q<{ wm: Date; rec: number }>(
    "SELECT watermark AS wm, (extract(epoch FROM recorded_at) * 1000)::float8 AS rec FROM source_watermark_events WHERE source_id=$1",
    [SOURCE],
  );
  const recAt = new Map(events.map((e) => [e.wm.toISOString(), e.rec]));
  const perEvent = wms.map((w) => complete.get(w)! - recAt.get(w)!);
  const trig = perEvent.flatMap((x) => Array.from({ length: th.rules! }, () => x)); // each of the event's triggers: <= the event-complete time
  const createdLat = (
    await q<{ ms: number }>(
      `SELECT (extract(epoch FROM (mt.created_at - w.recorded_at)) * 1000)::float8 AS ms
         FROM marker_tasks mt JOIN monitor_triggers tr ON tr.id = mt.trigger_id
         JOIN source_watermark_events w ON w.watermark = tr.watermark AND w.mode = tr.mode AND w.source_id = $1`,
      [SOURCE],
    )
  ).map((r) => r.ms);
  const trigStats = stats(trig);
  const taskStart = stats(createdLat);
  const tasks = Number((await q<{ n: number }>("SELECT count(*)::int n FROM marker_tasks"))[0]!.n);
  const dupTasks = Number(
    (
      await q<{ n: number }>(
        "SELECT count(*)::int n FROM (SELECT trigger_id FROM marker_tasks GROUP BY 1 HAVING count(*) > 1) x",
      )
    )[0]!.n,
  );

  // ---- SSE: map the k-th canvas.patched event after the seed patch to the k-th command
  const patched = (
    await q<{ seq: string }>(
      "SELECT seq FROM workspace_events WHERE workspace_id=$1 AND event_type='canvas.patched' ORDER BY seq",
      [sseWs],
    )
  ).map((r) => Number(r.seq));
  const cmdSeqs = patched.slice(1); // first one is the seed addPanel
  expect(cmdSeqs.length).toBe(th.commands);
  const upper: number[] = [];
  const lower: number[] = [];
  const applyDelay: number[] = [];
  for (const c of clients) {
    cmdSeqs.forEach((seq, i) => {
      const r = c.recv.get(seq);
      if (r === undefined) return;
      upper.push(r - issued[i]!); // includes the command's own execution
      lower.push(r - acked[i]!); // after the command returned
    });
    for (const [seq, at] of c.applied) applyDelay.push(at - (c.recv.get(seq) ?? at));
  }
  const upperStats = stats(upper);
  const lowerStats = stats(lower);
  const delayStats = stats(applyDelay);
  const ordered = clients.map((c) => {
    const seqs = c.store.appliedSeqs;
    return seqs.length === head && seqs.every((v, i) => v === i + 1);
  });
  const maxPending = Math.max(...clients.map((c) => c.store.maxPendingObserved));
  const coalescedBatches = clients.flatMap((c) => c.batches);
  const multi = coalescedBatches.filter((n) => n > 1).length;
  const missing = clients.reduce((n, c) => n + cmdSeqs.filter((s2) => !c.recv.has(s2)).length, 0);

  // ---- negative control: the same loop scanning every 15 s must fail the trigger judgement
  const ctlFirst = th.watermarks!;
  const ctlWms = await runTriggerPhase(ctlFirst, 30, 15_000);
  const ctlEvents = await q<{ wm: Date; rec: number }>(
    "SELECT watermark AS wm, (extract(epoch FROM recorded_at) * 1000)::float8 AS rec FROM source_watermark_events WHERE source_id=$1 AND watermark >= $2",
    [SOURCE, wm(ctlFirst)],
  );
  const ctlRec = new Map(ctlEvents.map((e) => [e.wm.toISOString(), e.rec]));
  const ctl = ctlWms.map((w) => complete.get(w)! - ctlRec.get(w)!);
  const controlFails = !triggerPasses(ctl, th.triggerToTaskP95Ms!);

  if (DRYRUN)
    process.stderr.write(
      "DRYRUN " +
        JSON.stringify({
          trigger: trigStats,
          taskStart,
          upper: upperStats,
          lower: lowerStats,
          delay: delayStats,
          ordered: ordered.every(Boolean),
          head,
          maxPending,
          multi,
          missing,
          tasks,
          dupTasks,
          clockOffsetMs,
          control: stats(ctl),
          controlFails,
        }) +
        "\n",
    );
  expect(controlFails).toBe(true);
  expect(dupTasks).toBe(0);
  expect(tasks).toBe(th.watermarks! * th.rules!); // counted before the control run
  expect(missing).toBe(0);
  expect(ordered.every(Boolean)).toBe(true);
  expect(clients.flatMap((c) => c.reloads)).toEqual([]);
  expect(maxPending).toBeLessThanOrEqual(1000);
  expect(multi).toBeGreaterThan(0); // the burst coalesced into multi-event batches
  expect(delayStats.max).toBeLessThanOrEqual(1000); // applied within the ch.09 coalescing window ceiling
  if (DRYRUN) return;
  expect(triggerPasses(trig, th.triggerToTaskP95Ms!)).toBe(true);
  expect(ssePasses(upper, th.sseP95Ms!)).toBe(true);

  observe({
    testId: "PERF07",
    observed: `${th.rules} enabled rules, ${th.watermarks} watermarks at a steady ${1000 / WM_RATE_MS}/s consumed by the ${SCAN_MS} ms scan loop: trigger to visible task record p50 ${trigStats.p50} ms, p95 ${trigStats.p95} ms, p99 ${trigStats.p99} ms (bound p95 < ${th.triggerToTaskP95Ms} ms; event-complete time used for every trigger of the event); task created_at based p95 ${taskStart.p95} ms; ${tasks} tasks, ${dupTasks} duplicates. ${th.sseClients} SSE clients, ${th.commands} commands (last ${BURST} unpaced): commit to client frame p50 ${upperStats.p50} ms, p95 ${upperStats.p95} ms, p99 ${upperStats.p99} ms measured from command issue (bound p95 < ${th.sseP95Ms} ms; ${lowerStats.p95} ms from command return); all clients applied seq 1..${head} in order exactly once, missing frames ${missing}; burst coalesced (${multi} multi-event batches, apply delay max ${delayStats.max} ms <= 1000 ms), client buffer max ${maxPending} (bound 1000). Clock: trigger times from the DB clock only; DB-to-process offset ${clockOffsetMs} ms. Negative control (15 s scan): trigger p95 ${stats(ctl).p95} ms, judged FAIL as required`,
    fixtureHash,
    evidence: {
      ...evidenceBase(g, {
        dataset: { id: "perf07 fixture spec", sha256: fixtureHash },
        concurrency: {
          rules: th.rules,
          sseClients: th.sseClients,
          watermarkRatePerS: 1000 / WM_RATE_MS,
          commandRatePerS: 1000 / CMD_RATE_MS,
        },
        cacheState: "n/a (fresh database)",
      }),
      trigger: {
        stats: trigStats,
        histogram: histogram(perEvent),
        createdAtBased: taskStart,
        perEventMs: perEvent.map((x) => Math.round(x)),
      },
      sse: {
        fromIssue: upperStats,
        fromReturn: lowerStats,
        histogram: histogram(upper),
        applyDelay: delayStats,
        maxClientBuffer: maxPending,
        batches: stats(coalescedBatches),
        multiEventBatches: multi,
      },
      ordering: { head, allClientsInOrder: ordered.every(Boolean), missingFrames: missing },
      clock: {
        source: "database clock for trigger times; process clock for SSE",
        dbToProcessOffsetMs: clockOffsetMs,
      },
      negativeControl: { scanMs: 15000, trigger: stats(ctl), judgedFail: controlFails },
      counts: { tasks, dupTasks },
    },
  });
}, 1_200_000);
