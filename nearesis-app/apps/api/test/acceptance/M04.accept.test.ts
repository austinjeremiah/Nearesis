import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { PanelSpec } from "@nearesis/contracts";
import { connectClient } from "@nearesis/workflow";
import { createWs, loginSession, runCmd } from "@nearesis/kernel/testing";
import type { Session } from "@nearesis/kernel";
import { apiFixture, seedOrg } from "../helpers.ts";
import type { ApiFixture } from "../helpers.ts";
import { RunsService } from "../../src/runs.ts";
import type { InvestigationEngine } from "../../src/runs.ts";
import { runsPort } from "../../src/marker-run-port.ts";
import { temporalEngine } from "../../src/temporal-engine.ts";

const taskQueue = `m1-m04-${randomUUID()}`;
let f: ApiFixture | undefined;
let reachable = false;
let s: Session;
const started: string[] = [];
beforeAll(async () => {
  try {
    const c = await connectClient();
    await c.connection.close();
    reachable = true;
  } catch {
    return;
  }
  f = await apiFixture({ runtime: true });
  s = await loginSession(
    f.kernel,
    (await seedOrg(f.db.admin, "m04", { alice: "owner" })).users.alice!.subject,
  );
});
afterAll(async () => {
  if (started.length) {
    const c = await connectClient();
    for (const id of started)
      await c.workflow
        .getHandle(id)
        .terminate("test cleanup")
        .catch(() => undefined);
    await c.connection.close();
  }
  await f?.close();
});

it("M04: after a monitor is disabled, future source updates cause 0 agent runs (including an in-flight race)", async (ctx) => {
  if (!reachable || !f) {
    observe({
      testId: "M04",
      observed: "Temporal not reachable at 127.0.0.1:57233; agent-run counting needs the real engine",
      blocked: "temporal unavailable",
    });
    ctx.skip();
    return;
  }
  const k = f.kernel;
  // Counting wrapper over the REAL Temporal engine: every start() is a real workflow on a private task queue.
  const real = temporalEngine({ taskQueue });
  const engine: InvestigationEngine = {
    start: async (i) => {
      const r = await real.start(i);
      started.push(r.workflowId);
      return r;
    },
    signal: (...a) => real.signal(...a),
  };
  const tasks = k.markerTasks(runsPort(new RunsService(k, engine)));

  const { workspaceId } = await createWs(k, s);
  const panel = PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: "Vol",
    queryRef: { hash: "a".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["ts", "vol"], units: { vol: "USD" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "ts", y: ["vol"] },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
  });
  const ver = async () => (await k.workspaces.get(s, workspaceId)).version;
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
      operations: [{ op: "addPanel", panel }],
    },
    await ver(),
  );
  const markerId = randomUUID();
  await runCmd(
    k,
    s,
    workspaceId,
    "marker.create",
    {
      panelId: panel.panelId,
      markerId,
      anchor: { kind: "threshold", metricId: "vol", op: "gt", value: 100 },
      question: "What pushed volume over the threshold?",
    },
    await ver(),
  );
  const sourceId = `bq.prices.${randomUUID().slice(0, 8)}`;
  const ruleId = randomUUID();
  await runCmd(
    k,
    s,
    workspaceId,
    "monitor.rule_create",
    {
      ruleId,
      name: "Vol breach",
      markerId,
      sourceId,
      action: "investigate",
      condition: { kind: "compare", metricId: "vol", op: "gt", value: 100 },
    },
    await ver(),
  );

  const at = (h: number) => new Date(Date.UTC(2026, 9, 28, h)).toISOString();
  const ev = (h: number) => ({ sourceId, watermark: at(h), mode: "live" as const, values: { vol: 500 } });
  const sch = k.monitorScheduler();
  const counts = async () => ({
    triggers: (
      await f!.db.admin.query("SELECT count(*)::int n FROM monitor_triggers WHERE rule_id=$1", [ruleId])
    ).rows[0].n as number,
    tasks: (
      await f!.db.admin.query("SELECT count(*)::int n FROM marker_tasks WHERE marker_id=$1", [markerId])
    ).rows[0].n as number,
  });

  // Control: while enabled, an update fires and one real agent run starts.
  await sch.processEvent(ev(1));
  const enabledDispatch = await tasks.dispatchOpen();
  const enabled = { ...(await counts()), engineStarts: started.length };
  expect(enabled).toEqual({ triggers: 1, tasks: 1, engineStarts: 1 });
  expect(enabledDispatch.started).toBe(1);

  // Disable. Then in-flight race: the scheduler selected the rule as enabled, and the disable commits before evaluation.
  const racer = k.monitorScheduler({
    onRuleSelected: async () => {
      await runCmd(k, s, workspaceId, "monitor.rule_disable", { ruleId }, await ver());
    },
  });
  const raced = await racer.processEvent(ev(2));
  expect(raced.map((r) => r.outcome)).toEqual(["disabled"]);

  // Future updates after the disable, delivered by several workers and via the inbox: nothing runs.
  const workers = Array.from({ length: 4 }, (_, i) => k.monitorScheduler({ holder: `w${i}` }));
  await Promise.all([3, 4, 5, 6, 7, 8].map((h, i) => workers[i % 4]!.processEvent(ev(h))));
  await sch.enqueue(ev(9));
  await sch.enqueue(ev(10));
  await db_clearLease(f);
  const tick = await k.monitorScheduler({ holder: "inbox" }).tick();
  const dispatch = await tasks.dispatchOpen();
  const after = { ...(await counts()), engineStarts: started.length };

  expect(after).toEqual({ triggers: 1, tasks: 1, engineStarts: 1 });
  expect(dispatch.started).toBe(0);
  const wf = await connectClient();
  let temporalCount = 0;
  for await (const _w of wf.workflow.list({ query: `TaskQueue = "${taskQueue}"` })) temporalCount++;
  await wf.connection.close();
  expect(temporalCount).toBe(1);

  // Negative control: re-enabling resumes execution, so the zero above is due to the disable.
  await runCmd(k, s, workspaceId, "monitor.rule_enable", { ruleId }, await ver());
  await sch.processEvent(ev(11));
  await tasks.dispatchOpen();
  const resumed = { ...(await counts()), engineStarts: started.length };
  expect(resumed).toEqual({ triggers: 2, tasks: 2, engineStarts: 2 });

  observe({
    testId: "M04",
    observed: `enabled: 1 update -> 1 trigger, 1 task, 1 real Temporal workflow. Disabled (incl. a disable that committed between rule selection and evaluation -> outcome "disabled"): 8 further updates over 4 workers and the inbox tick (${tick.events} events) -> triggers ${after.triggers}, tasks ${after.tasks}, engine starts ${after.engineStarts}, Temporal workflows on the queue ${temporalCount}. Re-enabled: next update ran (2 workflows)`,
    evidence: {
      enabled,
      afterDisable: after,
      resumed,
      raced: raced.map((r) => r.outcome),
      temporalWorkflowsAfterDisable: temporalCount,
    },
  });
});

async function db_clearLease(fx: ApiFixture): Promise<void> {
  await fx.db.admin.query("DELETE FROM monitor_scheduler_lease");
}
