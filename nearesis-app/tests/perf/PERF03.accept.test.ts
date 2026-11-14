/**
 * PERF03: a 100-rule monitor storm. PASS: no duplicate tasks and bounded queues (ch.13: trigger to task p95 < 10 s).
 * Real kernel + Postgres: 10 workspaces x 10 investigate-rules on one source, 20 watermarks delivered at once, each
 * processed by 4 competing scheduler instances and redelivered in shuffled order, plus the inbox path (enqueue + tick
 * from two instances). Half of the rules carry a per-day run cap of 3.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { PanelSpec } from "../../packages/contracts/src/index.ts";
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
import { DRYRUN, conditions, gate, reference, sha256Text, stats } from "./_reference.ts";

const WORKSPACES = 10;
const RULES_PER_WS = 10;
const WATERMARKS = 20;
const CAP = 3;
const SOURCE = "perf03.source";
const wm = (i: number) => new Date(Date.UTC(2026, 9, 28, 0, i)).toISOString();
export const FIXTURE_SPEC = {
  workspaces: WORKSPACES,
  rulesPerWorkspace: RULES_PER_WS,
  watermarks: Array.from({ length: WATERMARKS }, (_, i) => wm(i)),
  cappedEveryOther: CAP,
  competingSchedulers: 4,
  redeliveries: 1,
  condition: { kind: "compare", metricId: "queue_depth", op: "gt", value: 0 },
  action: "investigate",
};

let db: TestDb;
let k: Kernel;
let s: Session;
const g = gate(import.meta.url);
beforeAll(async () => {
  if (!g.ok && !DRYRUN) return;
  db = await createTestDb();
  k = testKernel(db);
  s = await loginSession(k, (await seedOrg(db.admin, "perf03", { alice: "owner" })).users.alice!.subject);
}, 120_000);
afterAll(async () => db?.drop());

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

it("PERF03: 100 rules under a watermark storm create no duplicate tasks and keep queues bounded", async () => {
  if (!g.ok && !DRYRUN) {
    observe({ testId: "PERF03", observed: "not executed", blocked: g.reason });
    return;
  }
  const th = reference().thresholds.PERF03!;
  const fixtureHash = sha256Text(JSON.stringify(FIXTURE_SPEC));
  if (DRYRUN) process.stderr.write(`FIXTUREHASH PERF03 ${fixtureHash}\n`);
  if (g.ok) expect(reference().fixtures.PERF03).toBe(fixtureHash);

  // ---- seed: workspaces, panel, marker, 10 rules each (even rules capped)
  const ver = async (ws: string) => (await k.workspaces.get(s, ws)).version;
  const ruleIds: string[] = [];
  const capped = new Set<string>();
  for (let w = 0; w < WORKSPACES; w++) {
    const { workspaceId } = await createWs(k, s, `perf03 ${w}`);
    const p = panel();
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
      {
        panelId: p.panelId,
        markerId,
        anchor: { kind: "time_point", at: wm(0) },
        question: "queue depth",
      },
      await ver(workspaceId),
    );
    for (let r = 0; r < RULES_PER_WS; r++) {
      const ruleId = randomUUID();
      const cap = r % 2 === 0;
      await runCmd(
        k,
        s,
        workspaceId,
        "monitor.rule_create",
        {
          ruleId,
          name: `rule ${w}.${r}`,
          markerId,
          sourceId: SOURCE,
          condition: FIXTURE_SPEC.condition,
          action: "investigate",
          debounceSeconds: 0,
          cooldownSeconds: 0,
          ...(cap ? { maxRunsPerDay: CAP } : {}),
        },
        await ver(workspaceId),
      );
      ruleIds.push(ruleId);
      if (cap) capped.add(ruleId);
    }
  }
  expect(ruleIds.length).toBe(th.rules);

  // ---- storm
  const sched = Array.from({ length: 4 }, () => k.monitorScheduler());
  const events = Array.from({ length: WATERMARKS }, (_, i) => ({
    sourceId: SOURCE,
    watermark: wm(i),
    mode: "live" as const,
    values: { queue_depth: 10 + i },
    maturity: "final" as const,
  }));
  const shuffled = [...events, ...events].sort(
    (a, b) => ((a.values.queue_depth * 7919) % 13) - ((b.values.queue_depth * 7919) % 13),
  );
  const stormStart = Date.now();
  // inbox path: two ticking instances consume what is enqueued
  for (const e of events) await sched[0]!.enqueue(e);
  let maxOpen = 0;
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      const n = (
        await db.admin.query("SELECT count(*)::int n FROM marker_tasks WHERE status IN ('PENDING','RUNNING')")
      ).rows[0].n as number;
      maxOpen = Math.max(maxOpen, n);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  const ticks = [sched[0]!, sched[1]!].map(async (sc) => {
    for (let i = 0; i < 40; i++) {
      const r = await sc.tick();
      if (r.owner && r.events === 0) break;
      if (!r.owner) await new Promise((res) => setTimeout(res, 50));
    }
  });
  // direct competing evaluation: every event by every scheduler, twice, shuffled
  const direct = sched.map(async (sc, i) => {
    for (const e of shuffled) await sc.processEvent(e);
    return i;
  });
  await Promise.all([...ticks, ...direct]);
  const drainMs = Date.now() - stormStart;
  // final drain of the inbox (the lease holder may have changed)
  for (let i = 0; i < 20; i++) {
    const r = await sched[0]!.tick();
    if (r.owner && r.events === 0) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  stop = true;
  await sampler;
  await sched[0]!.releaseLease();
  await sched[1]!.releaseLease();

  // ---- verdict inputs
  const q = async <T>(text: string, params: unknown[] = []) =>
    (await db.admin.query(text, params)).rows as T[];
  const expectedTasks = (ruleIds.length - capped.size) * WATERMARKS + capped.size * CAP;
  const tasks = (await q<{ n: number }>("SELECT count(*)::int n FROM marker_tasks"))[0]!.n;
  const dupTriggers = (
    await q<{ n: number }>(
      "SELECT count(*)::int n FROM (SELECT trigger_id FROM marker_tasks GROUP BY trigger_id HAVING count(*) > 1) x",
    )
  )[0]!.n;
  const dupEvalKeys = (
    await q<{ n: number }>(
      "SELECT count(*)::int n FROM (SELECT rule_id, watermark, mode FROM monitor_triggers GROUP BY 1,2,3 HAVING count(*) > 1) x",
    )
  )[0]!.n;
  const triggers = (await q<{ n: number }>("SELECT count(*)::int n FROM monitor_triggers"))[0]!.n;
  const notifications = (await q<{ n: number }>("SELECT count(*)::int n FROM notifications"))[0]!.n;
  const overCap = (
    await q<{ n: number }>(
      "SELECT count(*)::int n FROM (SELECT t.rule_id FROM monitor_triggers t JOIN marker_tasks mt ON mt.trigger_id = t.id WHERE t.rule_id = ANY($1) GROUP BY t.rule_id HAVING count(*) > $2) x",
      [[...capped], CAP],
    )
  )[0]!.n;
  const pendingInbox = (
    await q<{ n: number }>(
      "SELECT count(*)::int n FROM source_watermark_events e WHERE e.id > (SELECT cursor_id FROM monitor_scheduler_lease WHERE name = 'monitor')",
    )
  )[0]!.n;
  // trigger -> task latency: task creation time minus the moment the storm began delivering that watermark's event
  const lat = await q<{ ms: number }>(
    `SELECT (extract(epoch FROM (mt.created_at - to_timestamp($1::double precision / 1000.0))) * 1000)::float8 AS ms
       FROM marker_tasks mt`,
    [stormStart],
  );
  const l = stats(lat.map((x) => x.ms));
  const maxPerRuleWatermark = (
    await q<{ n: number }>(
      "SELECT coalesce(max(c),0)::int n FROM (SELECT count(*) c FROM marker_tasks mt JOIN monitor_triggers t ON t.id = mt.trigger_id GROUP BY t.rule_id, t.watermark) x",
    )
  )[0]!.n;

  expect(dupTriggers).toBe(th.maxDuplicateTasks);
  expect(dupEvalKeys).toBe(0);
  expect(maxPerRuleWatermark).toBeLessThanOrEqual(1);
  expect(tasks).toBe(expectedTasks);
  expect(triggers).toBe(ruleIds.length * WATERMARKS);
  expect(overCap).toBe(0);
  expect(pendingInbox).toBe(th.maxPendingInboxAfterDrain);
  expect(maxOpen).toBeLessThanOrEqual(expectedTasks);
  if (DRYRUN) return;
  expect(l.p95).toBeLessThan(th.triggerToTaskP95Ms!);

  observe({
    testId: "PERF03",
    observed: `${ruleIds.length} rules (${capped.size} with a run cap of ${CAP}/day) x ${WATERMARKS} simultaneous watermarks, each evaluated by 4 competing schedulers (+ shuffled redelivery + inbox ticks from 2 instances): ${triggers} triggers, ${notifications} notifications, ${tasks} tasks (expected exactly ${expectedTasks}); duplicate tasks per trigger ${dupTriggers}; duplicate (rule, watermark) triggers ${dupEvalKeys}; capped rules over cap ${overCap}; open-task queue peak ${maxOpen} (bound ${expectedTasks}); inbox pending after drain ${pendingInbox}; storm drained in ${drainMs} ms; trigger to task latency p50 ${l.p50} ms, p95 ${l.p95} ms, p99 ${l.p99} ms (SLO p95 < ${th.triggerToTaskP95Ms} ms)`,
    fixtureHash,
    evidence: {
      environment: "reference",
      profile: g.ok ? g.fingerprint : null,
      referenceSha256: g.ok ? g.referenceSha256 : null,
      adrSha256: g.ok ? g.adrSha256 : null,
      conditions: conditions(),
      dataset: { id: "perf03 fixture spec", sha256: fixtureHash },
      concurrency: { schedulers: 4, tickers: 2, workspaces: WORKSPACES },
      cacheState: "n/a (database state fresh per run)",
      counts: {
        rules: ruleIds.length,
        triggers,
        notifications,
        tasks,
        expectedTasks,
        dupTriggers,
        dupEvalKeys,
        overCap,
        pendingInbox,
        maxOpen,
      },
      drainMs,
      latencyMs: l,
    },
  });
}, 900_000);
