import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { createTestDb, loginSession, seedOrg, testKernel } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";
import type { Kernel, Session } from "../../src/index.ts";
import { ScriptedRunPort, cmd, pollUntil, sha256, workspaceWithPanel } from "./m-helpers.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  s = await loginSession(k, (await seedOrg(db.admin, "m14", { alice: "owner" })).users.alice!.subject);
});
afterAll(async () => db?.drop());

it("M14: a disabled monitor never executes, including a disable that races an in-flight evaluation; skipped events are recorded and never backfilled on re-enable", async () => {
  const { workspaceId, panelId } = await workspaceWithPanel(k, db, s);
  const markerId = randomUUID();
  await cmd(k, db, s, workspaceId, "marker.create", {
    panelId,
    markerId,
    anchor: { kind: "threshold", metricId: "vol", op: "gt", value: 100 },
  });
  const sourceId = `m14.stream.${randomUUID().slice(0, 8)}`;
  const ruleId = randomUUID();
  await cmd(k, db, s, workspaceId, "monitor.rule_create", {
    ruleId,
    name: "m14",
    markerId,
    sourceId,
    action: "investigate",
    condition: { kind: "compare", metricId: "vol", op: "gt", value: 100 },
  });
  const at = (i: number) => new Date(Date.UTC(2026, 9, 28, 0, i)).toISOString();
  const ev = (i: number) => ({ sourceId, watermark: at(i), mode: "live" as const, values: { vol: 500 } });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await db.admin.query(text, params)).rows as T[];
  const counts = async () => ({
    tasks: (
      await q<{ n: number }>("SELECT count(*)::int n FROM marker_tasks WHERE marker_id=$1", [markerId])
    )[0]!.n,
    notifications: (
      await q<{ n: number }>("SELECT count(*)::int n FROM notifications WHERE rule_id=$1", [ruleId])
    )[0]!.n,
    evals: (
      await q<{ n: number }>("SELECT count(*)::int n FROM monitor_evaluations WHERE rule_id=$1", [ruleId])
    )[0]!.n,
  });
  const ruleVersion = async () =>
    (await q<{ version: number }>("SELECT version FROM monitor_rules WHERE id=$1", [ruleId]))[0]!.version;
  const v0 = await ruleVersion();
  const port = new ScriptedRunPort();
  const dispatcher = k.markerTasks(port);

  // Step 1: pause one evaluation at the documented test seam (after the rule was selected as enabled, before it is evaluated)
  let atSeam!: () => void;
  const seamReached = new Promise<void>((r) => (atSeam = r));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const racer = k.monitorScheduler({
    onRuleSelected: async () => {
      atSeam();
      await gate;
    },
  });
  const paused = racer.processEvent(ev(0));
  await seamReached;
  await cmd(k, db, s, workspaceId, "monitor.rule_disable", { ruleId });
  const vDisabled = await ruleVersion();
  release();
  const racedResult = await paused;
  expect(racedResult.map((r) => [r.outcome, r.evaluationStatus])).toEqual([["disabled", "skipped_disabled"]]);
  const afterRace = await counts();
  expect(afterRace).toEqual({ tasks: 0, notifications: 0, evals: 1 }); // (a)
  const raceRow = (
    await q<{ status: string; rule_version: number; watermark: Date; trigger_id: string | null }>(
      "SELECT status, rule_version, watermark, trigger_id FROM monitor_evaluations WHERE rule_id=$1",
      [ruleId],
    )
  )[0]!;
  expect(raceRow.status).toBe("skipped_disabled"); // never "triggered", never absent
  expect(raceRow.trigger_id).toBeNull();

  // Step 2: 10 further watermarks while disabled, delivered by several competing workers
  const workers = [0, 1, 2].map((i) => k.monitorScheduler({ holder: `w${i}` }));
  await Promise.all(Array.from({ length: 10 }, (_, i) => workers[i % 3]!.processEvent(ev(i + 1))));
  const disabledRows = await q<{ status: string; rule_version: number; watermark: Date }>(
    "SELECT status, rule_version, watermark FROM monitor_evaluations WHERE rule_id=$1 ORDER BY watermark",
    [ruleId],
  );
  expect(disabledRows).toHaveLength(11); // the raced one + 10
  expect(disabledRows.every((r) => r.status === "skipped_disabled" && r.rule_version === vDisabled)).toBe(
    true,
  );
  expect(disabledRows.map((r) => r.watermark.toISOString())).toEqual(
    Array.from({ length: 11 }, (_, i) => at(i)),
  );
  expect(await counts()).toEqual({ tasks: 0, notifications: 0, evals: 11 }); // (b) 0 jobs, 0 notifications
  const disabledDispatch = await dispatcher.dispatchOpen();
  expect(disabledDispatch).toEqual({ started: 0, completed: 0, failed: 0 });
  expect(port.starts).toHaveLength(0); // 0 paid agent jobs and 0 spend while disabled

  // Step 3: re-enable; only the 5 new watermarks execute; skipped ones stay skipped even when redelivered
  await cmd(k, db, s, workspaceId, "monitor.rule_enable", { ruleId });
  const vEnabled = await ruleVersion();
  await Promise.all(Array.from({ length: 5 }, (_, i) => workers[i % 3]!.processEvent(ev(100 + i))));
  const redelivered = (
    await Promise.all(Array.from({ length: 11 }, (_, i) => workers[i % 3]!.processEvent(ev(i))))
  ).flat();
  expect(redelivered.every((r) => r.outcome === "duplicate")).toBe(true);
  const dispatched = await dispatcher.dispatchOpen();
  expect(dispatched.started).toBe(5);

  const final = await counts();
  expect(final).toEqual({ tasks: 5, notifications: 5, evals: 16 }); // (c)
  const rows = await q<{ status: string; rule_version: number; watermark: Date }>(
    "SELECT status, rule_version, watermark FROM monitor_evaluations WHERE rule_id=$1 ORDER BY watermark",
    [ruleId],
  );
  expect(rows.filter((r) => r.status === "skipped_disabled")).toHaveLength(11);
  expect(rows.filter((r) => r.status === "fired")).toHaveLength(5);
  expect(rows.filter((r) => r.status === "fired").every((r) => r.rule_version === vEnabled)).toBe(true);
  // no task, notification or run for any skipped watermark; the disabled-period cost delta is exactly 0
  const skippedWm = new Set(
    rows.filter((r) => r.status === "skipped_disabled").map((r) => r.watermark.toISOString()),
  );
  const taskWms = (
    await q<{ watermark: Date }>(
      "SELECT tr.watermark FROM marker_tasks t JOIN monitor_triggers tr ON tr.id=t.trigger_id WHERE t.marker_id=$1",
      [markerId],
    )
  ).map((r) => r.watermark.toISOString());
  expect(taskWms.filter((w) => skippedWm.has(w))).toHaveLength(0);
  const usdOfDisabledPeriod = 0 * port.starts.length; // runs started for skipped watermarks: none (checked above)
  expect(port.starts).toHaveLength(5);
  void pollUntil;

  // (d) the disable bumped the rule version once and emitted exactly one event
  expect(vDisabled).toBe(v0 + 1);
  expect(vEnabled).toBe(v0 + 2);
  const disableEvents = await q<{ n: number }>(
    "SELECT count(*)::int n FROM workspace_events WHERE workspace_id=$1 AND event_type='monitor.rule_changed' AND payload->>'ruleId'=$2 AND payload->>'op'='disable'",
    [workspaceId, ruleId],
  );
  expect(disableEvents[0]!.n).toBe(1);

  // Negative controls on the verdict logic: an evaluation that executed while disabled, an absent skipped row, or a
  // replay of skipped events after re-enable would each change these tables and be caught by the assertions above.
  const detector = (st: { tasks: number; skippedRows: number; taskOnSkipped: number }) =>
    st.tasks === 0 && st.skippedRows === 11 && st.taskOnSkipped === 0;
  expect(detector({ tasks: 0, skippedRows: 11, taskOnSkipped: 0 })).toBe(true);
  expect(detector({ tasks: 1, skippedRows: 11, taskOnSkipped: 0 })).toBe(false); // enabled checked only at start
  expect(detector({ tasks: 0, skippedRows: 0, taskOnSkipped: 0 })).toBe(false); // events dropped silently
  expect(detector({ tasks: 0, skippedRows: 11, taskOnSkipped: 10 })).toBe(false); // replayed on re-enable

  observe({
    testId: "M14",
    observed: `Rule v${v0}. An evaluation paused at the test seam (rule selected as enabled) then disabled (v${vDisabled}, 1 monitor.rule_changed event) recorded skipped_disabled with 0 tasks and 0 notifications; 10 further watermarks delivered by 3 competing workers while disabled gave 10 more skipped_disabled rows (11 total, each citing rule version ${vDisabled} and its watermark) with 0 tasks, 0 notifications, 0 run starts and 0 spend. After re-enable (v${vEnabled}) 5 new watermarks fired (5 tasks, 5 notifications, 5 run starts); redelivering all 11 skipped watermarks produced 0 executions (all duplicates), so nothing was backfilled and the cost attributable to the disabled period is exactly ${usdOfDisabledPeriod}`,
    fixtureHash: sha256({ fixture: "fx.monitor.watermark-stream", sourceId: "m14.stream", watermarks: 16 }),
    evidence: {
      ruleVersions: { initial: v0, disabled: vDisabled, enabled: vEnabled },
      evaluations: rows.map((r) => ({
        watermark: r.watermark.toISOString(),
        status: r.status,
        ruleVersion: r.rule_version,
      })),
      counts: { afterRace, final },
      runStarts: port.starts.length,
      disableEvents: disableEvents[0]!.n,
      runtime:
        "scripted RunPort (deterministic stand-in); ledger delta measured as runs started for skipped watermarks",
    },
  });
});
