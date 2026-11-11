import { randomUUID } from "node:crypto";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { PanelSpec } from "@nearesis/contracts";
import { createTestDb, createWs, loginSession, runCmd, seedOrg, testKernel } from "@nearesis/kernel/testing";
import type { TestDb } from "@nearesis/kernel/testing";
import type { Kernel, Session } from "@nearesis/kernel";
import {
  CorrectionWorkflow,
  kernelMonitorPort,
  PublicationFrozenError,
  buildCapsule,
  canonicalSha256,
  treeHashOf,
  verifyCapsule,
} from "../../src/index.ts";
import { SNAPSHOT, tmp } from "../helpers.ts";

let db: TestDb;
let kernel: Kernel;
let session: Session;
beforeAll(async () => {
  db = await createTestDb();
  kernel = testKernel(db);
  session = await loginSession(
    kernel,
    (await seedOrg(db.admin, "v18", { alice: "owner" })).users.alice!.subject,
  );
});
afterAll(async () => db?.drop());

const wsVersion = async (ws: string): Promise<number> =>
  (await db.admin.query("SELECT version FROM workspaces WHERE id=$1", [ws])).rows[0].version as number;
const kcmd = async (ws: string, type: Parameters<typeof runCmd>[3], payload: Record<string, unknown>) =>
  runCmd(kernel, session, ws, type, payload, await wsVersion(ws));

/** A real kernel workspace with one investigate rule (and its marker) per entry: returns rule and marker ids. */
async function kernelRules(specs: Array<{ key: string; sourceId: string }>) {
  const { workspaceId } = await createWs(kernel, session);
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
  await kcmd(workspaceId, "canvas.apply_patch", {
    schemaVersion: 1,
    type: "workspace.patch",
    operationId: randomUUID(),
    expectedRevision: 0,
    operations: [{ op: "addPanel", panel }],
  });
  const out: Record<string, { ruleId: string; markerId: string; sourceId: string }> = {};
  for (const sp of specs) {
    const markerId = randomUUID();
    const ruleId = randomUUID();
    await kcmd(workspaceId, "marker.create", {
      panelId: panel.panelId,
      markerId,
      anchor: { kind: "threshold", metricId: "vol", op: "gt", value: 100 },
    });
    await kcmd(workspaceId, "monitor.rule_create", {
      ruleId,
      name: sp.key,
      markerId,
      sourceId: sp.sourceId,
      action: "investigate",
      condition: { kind: "compare", metricId: "vol", op: "gt", value: 100 },
    });
    out[sp.key] = { ruleId, markerId, sourceId: sp.sourceId };
  }
  return { workspaceId, rules: out };
}

function snapshotVariant(id: string): string {
  const d = tmp(`v18-snap-${id}-`);
  cpSync(SNAPSHOT, d, { recursive: true });
  const p = join(d, "snapshot.json");
  const j = JSON.parse(readFileSync(p, "utf8")) as { snapshotId: string };
  j.snapshotId = `corr-${id}`;
  writeFileSync(p, JSON.stringify(j, null, 2));
  return d;
}

/** V18 (16b): a metric correction freezes publication, finds dependents, halts monitors, emits one event and reruns. */
it("V18: correcting m@1.0.0 blocks its capsules, halts exactly its monitors, appends one correction event, supersedes by rerun and keeps history intact", async () => {
  const root = tmp("v18-");
  // the monitors are real kernel rules; halting goes through the kernel's monitor.rule_disable command
  const uniq = randomUUID().slice(0, 8);
  const srcM = `v18.m.${uniq}`;
  const srcK = `v18.k.${uniq}`;
  const kr = await kernelRules([
    { key: "mon-m-1", sourceId: srcM },
    { key: "mon-m-2", sourceId: srcM },
    { key: "mon-k-1", sourceId: srcK },
  ]);
  const wf = new CorrectionWorkflow(
    join(root, "state"),
    () => new Date(),
    kernelMonitorPort(kernel, session, kr.workspaceId),
  );
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await db.admin.query(text, params)).rows as T[];
  const taskCount = async (key: string) =>
    (
      await q<{ n: number }>("SELECT count(*)::int n FROM marker_tasks WHERE marker_id=$1", [
        kr.rules[key]!.markerId,
      ])
    )[0]!.n;
  const ev = (sourceId: string, i: number) => ({
    sourceId,
    watermark: new Date(Date.UTC(2026, 9, 28, 0, i)).toISOString(),
    mode: "live" as const,
    values: { vol: 500 },
  });
  const scheduler = kernel.monitorScheduler();
  const snaps: Record<string, string> = {};
  // fixture: 2 capsules on m@1.0.0, 1 independent capsule, 2 monitors on m@1.0.0, 1 on another metric
  wf.registerMetric("m", "1.0.0");
  wf.registerMetric("k", "1.0.0");
  const mk = (id: string, mv: Record<string, string>) => {
    snaps[`cap-corr-${id}`] = snapshotVariant(id);
    const dir = join(root, "capsules", `cap-corr-${id}`);
    buildCapsule({ snapshotDir: snaps[`cap-corr-${id}`]!, outDir: dir, metricVersions: mv });
    return wf.indexCapsule(dir);
  };
  const A = mk("a", { m: "1.0.0" });
  const B = mk("b", { m: "1.0.0" });
  const C = mk("c", { k: "1.0.0" });
  wf.registerMonitor("mon-m-1", "m", "1.0.0", kr.rules["mon-m-1"]!.ruleId);
  wf.registerMonitor("mon-m-2", "m", "1.0.0", kr.rules["mon-m-2"]!.ruleId);
  wf.registerMonitor("mon-k-1", "k", "1.0.0", kr.rules["mon-k-1"]!.ruleId);
  // control: before the correction every kernel rule fires and creates its investigation task
  await scheduler.processEvent(ev(srcM, 0));
  await scheduler.processEvent(ev(srcK, 0));
  const tasksBefore = {
    m1: await taskCount("mon-m-1"),
    m2: await taskCount("mon-m-2"),
    k1: await taskCount("mon-k-1"),
  };
  expect(tasksBefore).toEqual({ m1: 1, m2: 1, k1: 1 });
  // control: before the correction all three publish
  for (const c of [A, B, C]) wf.publish(c.capsuleId);
  expect(wf.published().sort()).toEqual([A.capsuleId, B.capsuleId, C.capsuleId].sort());

  const eventsBefore = wf.events();
  const eventLinesBefore = readFileSync(join(wf.dir, "events.jsonl"), "utf8");
  const monBefore = wf.monitors().find((m) => m.id === "mon-k-1")!;
  const treesBefore = Object.fromEntries([A, B, C].map((c) => [c.capsuleId, treeHashOf(c.dir)]));

  // (e) a monitor evaluation for m@1.0.0 is in flight (paused after "condition true", before the task is created)
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let tasks = 0;
  const inFlight = wf.runMonitor(
    "mon-m-1",
    async () => (await gate, true),
    () => tasks++,
  );

  // declare the metric incorrect
  const decl = await wf.declareIncorrect({
    metric: "m",
    version: "1.0.0",
    correctedVersion: "1.0.1",
    reason: "fixture: metric definition was wrong",
  });
  release();
  const inFlightStatus = await inFlight;

  // (a) publication of affected claims is blocked immediately; the independent capsule stays publishable
  for (const c of [A, B]) {
    expect(() => wf.publish(c.capsuleId)).toThrow(PublicationFrozenError);
    expect(wf.publishBlockReason(c.capsuleId)).toContain("m@1.0.0");
  }
  expect(wf.publishBlockReason(C.capsuleId)).toBeNull();
  wf.publish(C.capsuleId);

  // (b) exactly the 2 dependents impacted; exactly the 2 monitors on m@1.0.0 halted; the other is unchanged
  expect(decl.impactedCapsules.sort()).toEqual([A.capsuleId, B.capsuleId].sort());
  expect(decl.haltedMonitors.sort()).toEqual(["mon-m-1", "mon-m-2"]);
  const mons = wf.monitors();
  expect(
    mons
      .filter((m) => m.state === "halted")
      .map((m) => m.id)
      .sort(),
  ).toEqual(["mon-m-1", "mon-m-2"]);
  expect(mons.find((m) => m.id === "mon-k-1")).toEqual(monBefore);

  // (e) the in-flight evaluation created no task and is recorded as skipped; later runs on a halted monitor too
  expect(inFlightStatus).toBe("skipped_halted");
  expect(tasks).toBe(0);
  expect(
    await wf.runMonitor(
      "mon-m-2",
      async () => true,
      () => tasks++,
    ),
  ).toBe("skipped_halted");
  expect(tasks).toBe(0);
  // the unaffected monitor still runs normally
  expect(
    await wf.runMonitor(
      "mon-k-1",
      async () => true,
      () => tasks++,
    ),
  ).toBe("task_created");
  expect(tasks).toBe(1);

  // (e2) the kernel rules themselves are disabled: later watermarks create no task for them and are recorded skipped_disabled
  const enabledNow = Object.fromEntries(
    (await kernel.monitoring.listRules(session, kr.workspaceId)).map((r) => [r.name, r.enabled]),
  );
  expect(enabledNow).toEqual({ "mon-m-1": false, "mon-m-2": false, "mon-k-1": true });
  const afterM = await scheduler.processEvent(ev(srcM, 1));
  await scheduler.processEvent(ev(srcK, 1));
  expect(afterM.map((r) => r.evaluationStatus)).toEqual(["skipped_disabled", "skipped_disabled"]);
  const tasksAfter = {
    m1: await taskCount("mon-m-1"),
    m2: await taskCount("mon-m-2"),
    k1: await taskCount("mon-k-1"),
  };
  expect(tasksAfter).toEqual({ m1: 1, m2: 1, k1: 2 }); // halted rules: 0 new tasks; the unaffected rule keeps working
  const kernelEvals = await q<{ name: string; status: string }>(
    `SELECT r.name, e.status FROM monitor_evaluations e JOIN monitor_rules r ON r.id = e.rule_id
      WHERE e.watermark = $1 ORDER BY r.name`,
    [ev(srcM, 1).watermark],
  );
  expect(kernelEvals).toEqual([
    { name: "mon-k-1", status: "fired" },
    { name: "mon-m-1", status: "skipped_disabled" },
    { name: "mon-m-2", status: "skipped_disabled" },
  ]);
  // a halt the kernel refuses is not swallowed: the monitor stays active in the registry and the call throws
  const bad = new CorrectionWorkflow(join(root, "state-bad"), () => new Date(), {
    disable: () => Promise.reject(new Error("kernel unavailable")),
  });
  bad.registerMetric("z", "1.0.0");
  bad.registerMonitor("mon-z", "z", "1.0.0", randomUUID());
  await expect(
    bad.declareIncorrect({ metric: "z", version: "1.0.0", correctedVersion: "1.0.1", reason: "x" }),
  ).rejects.toThrow("mon-z");
  expect(bad.monitors()[0]!.state).toBe("active");
  expect(bad.events().some((e) => e.type === "monitor.halt_failed")).toBe(true);

  // (c) exactly one correction event with lineage to the originals; original events are byte-intact
  const corrections = wf.events().filter((e) => e.type === "metric.corrected");
  expect(corrections.length).toBe(1);
  const origIds = eventsBefore
    .filter((e) => e.type === "metric.registered" && e.payload.metric === "m")
    .map((e) => e.id);
  for (const id of origIds) expect(corrections[0]!.lineage).toContain(id);
  expect(corrections[0]!.lineage.length).toBeGreaterThanOrEqual(1 + 2 + 2); // registered + 2 indexed + 2 published
  expect(readFileSync(join(wf.dir, "events.jsonl"), "utf8").startsWith(eventLinesBefore)).toBe(true);
  expect(wf.verifyEventChain()).toEqual({ ok: true, brokenAt: null });

  // (d) the rerun from raw snapshots creates new capsules referencing m@1.0.1; old ones are superseded and still verify
  const rerun = wf.rerun({
    metric: "m",
    incorrectVersion: "1.0.0",
    correctedVersion: "1.0.1",
    snapshotDirs: snaps,
    outRoot: join(root, "capsules"),
  });
  expect(rerun.map((r) => r.oldId).sort()).toEqual([A.capsuleId, B.capsuleId].sort());
  for (const r of rerun) {
    const old = [A, B].find((c) => c.capsuleId === r.oldId)!;
    expect(r.newHash).not.toBe(old.capsuleHash);
    expect(r.newId).not.toBe(r.oldId);
    const nm = JSON.parse(readFileSync(join(r.dir, "manifest.json"), "utf8")) as {
      metricVersions: Record<string, string>;
    };
    expect(nm.metricVersions).toEqual({ m: "1.0.1" });
    expect((await verifyCapsule(r.dir, { research: "skip", wasm: "skip" })).status).toBe("reproduced");
    // the old capsule is marked superseded, is byte-unchanged and verifies as its historical self
    const entry = wf.index().find((c) => c.capsuleId === r.oldId)!;
    expect(entry).toMatchObject({ status: "superseded", supersededBy: r.newId });
    expect(treeHashOf(old.dir)).toEqual(treesBefore[old.capsuleId]);
    const oldRep = await verifyCapsule(old.dir, { research: "skip", wasm: "skip" });
    expect(oldRep.status).toBe("reproduced");
    expect(wf.publishBlockReason(r.oldId)).toContain("superseded");
    expect(wf.publishBlockReason(r.newId)).toBeNull(); // new capsules depend on m@1.0.1, which is not frozen
  }
  expect(treeHashOf(C.dir)).toEqual(treesBefore[C.capsuleId]);
  expect(wf.index().find((c) => c.capsuleId === C.capsuleId)!.status).toBe("current");
  expect(wf.historicalIntact()).toEqual({ ok: true, problems: [] });
  expect(wf.verifyEventChain().ok).toBe(true);
  expect(wf.metrics().find((m) => m.metric === "m" && m.version === "1.0.0")).toMatchObject({
    status: "incorrect",
    correctedBy: "1.0.1",
  });

  // negative control: a workflow that deletes the old capsules is caught by the historical check (d)
  rmSync(A.dir, { recursive: true });
  const broken = wf.historicalIntact();
  expect(broken.ok).toBe(false);
  expect(broken.problems[0]).toContain(A.capsuleId);
  observe({
    testId: "V18",
    observed: `Declared m@1.0.0 incorrect: publication of its 2 capsules blocked at once (PublicationFrozenError; reason names m@1.0.0), the independent capsule still published; impacted list is exactly [${decl.impactedCapsules.join(", ")}]; exactly monitors [${decl.haltedMonitors.join(", ")}] halted while the monitor on k@1.0.0 stayed unchanged and ran a task. The in-flight evaluation paused before task creation produced 0 tasks and was recorded skipped_halted (so did a later run). One metric.corrected event with ${corrections[0]!.lineage.length} lineage ids; the original ${eventsBefore.length} event lines are byte-identical and the hash chain verifies. Rerun from raw snapshots created ${rerun.length} new capsules with new hashes and metricVersions {m: 1.0.1}; old capsules marked superseded, byte-unchanged and still verify as reproduced. Negative control: deleting an old capsule is caught. The monitors are real kernel rules halted through the kernel monitor.rule_disable command (kernelMonitorPort): afterwards the two halted rules were disabled in the kernel, a new watermark was recorded skipped_disabled for both with 0 new investigation tasks (tasks before {m1:1,m2:1,k1:1}, after {m1:1,m2:1,k1:2}), and a failing kernel halt is surfaced (monitor stays active, monitor.halt_failed event, declareIncorrect throws). The metric registry and capsule index remain files in this package.`,
    fixtureHash: canonicalSha256(treesBefore),
    evidence: {
      impacted: decl.impactedCapsules,
      halted: decl.haltedMonitors,
      correctionEventId: corrections[0]!.id,
      lineage: corrections[0]!.lineage,
      rerun: rerun.map((r) => ({ oldId: r.oldId, newId: r.newId, newHash: r.newHash })),
      inFlight: inFlightStatus,
      tasksAfterHalt: 0,
      kernelTasksBefore: tasksBefore,
      kernelTasksAfter: tasksAfter,
      kernelEvaluations: kernelEvals,
    },
  });
}, 300_000);
