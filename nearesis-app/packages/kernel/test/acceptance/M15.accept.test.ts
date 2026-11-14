import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { createTestDb, loginSession, seedOrg } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";
import type { Kernel, Session } from "../../src/index.ts";
import { ScriptedRunPort, cmd, monitoringKernel, rejected, sha256, workspaceWithPanel } from "./m-helpers.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = monitoringKernel(db);
  s = await loginSession(k, (await seedOrg(db.admin, "m15", { alice: "owner" })).users.alice!.subject);
});
afterAll(async () => db?.drop());

const DAY = 86_400_000;
const day = (i: number) => new Date(Date.UTC(2026, 8, 1) + i * DAY).toISOString(); // 2026-09-01 + i days

/** Independent reference z-score (sample sd, n-1), written out here rather than imported from the code under test. */
function refZ(x: number, hist: number[]): number {
  const n = hist.length;
  const mean = hist.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return (x - mean) / sd;
}

it("M15: rules accept only the declared deterministic grammar, evaluate reproducibly, and gate AI work behind finality, run caps and a zero-model-call evaluation", async () => {
  const { workspaceId, panelId } = await workspaceWithPanel(k, db, s);
  const markerId = randomUUID();
  await cmd(k, db, s, workspaceId, "marker.create", {
    panelId,
    markerId,
    anchor: { kind: "threshold", metricId: "vol", op: "gt", value: 1 },
  });
  const sourceId = `m15.series.${randomUUID().slice(0, 8)}`;
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await db.admin.query(text, params)).rows as T[];
  const ruleCount = async () =>
    (
      await q<{ n: number }>("SELECT count(*)::int n FROM monitor_rules WHERE workspace_id=$1", [workspaceId])
    )[0]!.n;

  // Step 1: invalid rules. None executes code (the strings below would set a global if anything evaluated them).
  const g = globalThis as unknown as { __m15?: number };
  const base = { name: "bad", sourceId, markerId, action: "investigate" };
  const cmp = (metricId: string, value: unknown) => ({ kind: "compare", metricId, op: "gt", value });
  const invalid: Array<{ name: string; payload: Record<string, unknown>; code: string }> = [
    {
      name: "eval string as condition",
      payload: { ...base, condition: "(globalThis.__m15 = 1)" },
      code: "INVALID_PAYLOAD",
    },
    {
      name: "eval string as a comparison value",
      payload: { ...base, condition: cmp("vol", "(globalThis.__m15 = 1)") },
      code: "INVALID_PAYLOAD",
    },
    {
      name: "SQL fragment as metric id",
      payload: { ...base, condition: cmp("vol; DROP TABLE monitor_rules", 1) },
      code: "INVALID_PAYLOAD",
    },
    {
      name: "SQL fragment as an extra field",
      payload: { ...base, condition: cmp("vol", 1), where: "1=1; DROP TABLE x" },
      code: "INVALID_PAYLOAD",
    },
    {
      name: "unknown condition kind",
      payload: { ...base, condition: { kind: "script", source: "globalThis.__m15 = 1" } },
      code: "INVALID_PAYLOAD",
    },
    {
      name: "unknown metric",
      payload: { ...base, condition: cmp("not_in_catalog", 1) },
      code: "UNKNOWN_METRIC",
    },
    {
      name: "semantic version not in the catalog",
      payload: { ...base, condition: cmp("vol", 1), semanticVersion: "9.9.9" },
      code: "UNKNOWN_SEMANTIC_VERSION",
    },
  ];
  const rejections: Array<{ name: string; status: number; reasonCode: string }> = [];
  for (const v of invalid) {
    const e = await rejected(cmd(k, db, s, workspaceId, "monitor.rule_create", v.payload));
    expect(e.status, v.name).toBe(422);
    expect(e.reasonCode, v.name).toBe(v.code);
    rejections.push({ name: v.name, status: e.status, reasonCode: e.reasonCode });
  }
  expect(await ruleCount()).toBe(0); // (a) no row
  expect(g.__m15).toBeUndefined(); // none executed code

  // Step 2: the valid rule
  const ruleId = randomUUID();
  await cmd(k, db, s, workspaceId, "monitor.rule_create", {
    ruleId,
    name: "swap volume z-score",
    markerId,
    sourceId,
    action: "investigate",
    condition: { kind: "zscore", metricId: "vol", windowDays: 30, absoluteGt: 3 },
    dataMaturity: "finalized_only",
    maxRunsPerDay: 2,
  });

  // fx.monitor.series-zscore (SYNTHETIC): 30 baseline days alternating 1000 +/- 10, then a 4-sigma day, then a 2-sigma day
  const baseline = Array.from({ length: 30 }, (_, i) => 1000 + (i % 2 === 0 ? 10 : -10));
  const sd30 = Math.sqrt(
    baseline.reduce((a, b) => a + (b - baseline.reduce((x, y) => x + y, 0) / 30) ** 2, 0) / 29,
  );
  const mean30 = baseline.reduce((a, b) => a + b, 0) / 30;
  const spike4 = mean30 + 4 * sd30; // day 30 (2026-10-01): z = +4 against days 0..29
  const window2 = [...baseline.slice(1), spike4]; // the 30 days before day 31
  const mean2 = window2.reduce((a, b) => a + b, 0) / 30;
  const sd2 = Math.sqrt(window2.reduce((a, b) => a + (b - mean2) ** 2, 0) / 29);
  const mild2 = mean2 + 2 * sd2; // day 31: z = +2 against days 1..30
  const series = [
    ...baseline.map((v, i) => ({ watermark: day(i), vol: v, maturity: "final" as const })),
    { watermark: day(30), vol: spike4, maturity: "final" as const },
    { watermark: day(31), vol: mild2, maturity: "final" as const },
    { watermark: day(32), vol: spike4 * 3, maturity: "provisional" as const }, // would qualify, but is not final
  ];
  const ev = (e: (typeof series)[number], mode: "live" | "replay") => ({
    sourceId,
    watermark: e.watermark,
    mode,
    maturity: e.maturity,
    values: { vol: e.vol },
  });
  const port = new ScriptedRunPort();
  const sch = k.monitorScheduler();
  const run = async (mode: "live" | "replay") => {
    for (const e of series) await sch.processEvent(ev(e, mode));
  };
  const evalOutputs = async (mode: string) =>
    (
      await q<{ watermark: Date; status: string; evaluated_value: unknown }>(
        "SELECT watermark, status, evaluated_value FROM monitor_evaluations WHERE rule_id=$1 AND mode=$2 ORDER BY watermark",
        [ruleId, mode],
      )
    ).map((r) => JSON.stringify([r.watermark.toISOString(), r.status, r.evaluated_value]));

  await run("live");
  await run("replay");
  const live1 = await evalOutputs("live");
  const replay1 = await evalOutputs("replay");
  await run("live"); // a second pass over the same series: every event is a duplicate, outputs unchanged
  const live2 = await evalOutputs("live");

  // (b) 4-sigma day triggers, 2-sigma does not; replays byte-equal
  const byWm = async (mode: string) =>
    Object.fromEntries(
      (
        await q<{ watermark: Date; status: string; evaluated_value: { stats?: { vol?: { z: number } } } }>(
          "SELECT watermark, status, evaluated_value FROM monitor_evaluations WHERE rule_id=$1 AND mode=$2",
          [ruleId, mode],
        )
      ).map((r) => [r.watermark.toISOString(), r]),
    );
  const liveRows = await byWm("live");
  const d30 = liveRows[day(30)]!;
  const d31 = liveRows[day(31)]!;
  expect(d30.status).toBe("fired");
  expect(d30.evaluated_value.stats!.vol!.z).toBeCloseTo(refZ(spike4, baseline), 9);
  expect(refZ(spike4, baseline)).toBeCloseTo(4, 9);
  expect(d31.status).toBe("condition_false");
  expect(Math.abs(d31.evaluated_value.stats!.vol!.z)).toBeCloseTo(2, 9);
  expect(d31.evaluated_value.stats!.vol!.z).toBeCloseTo(refZ(mild2, window2), 9);
  expect(live1).toEqual(replay1); // two replays of the series: byte-equal evaluation outputs
  expect(live1).toEqual(live2);
  expect(live1.every((x) => typeof x === "string")).toBe(true);
  // not enough history for the first days: unknown, never zero
  expect(liveRows[day(0)]!.status).toBe("no_data");

  // (c) the provisional watermark never triggers under finalized_only, and is recorded not_final
  const d32 = liveRows[day(32)]!;
  expect(d32.status).toBe("not_final");
  expect(
    (
      await q<{ n: number }>(
        "SELECT count(*)::int n FROM monitor_triggers WHERE rule_id=$1 AND watermark=$2",
        [ruleId, day(32)],
      )
    )[0]!.n,
  ).toBe(0);
  expect(
    (
      await q<{ n: number }>("SELECT count(*)::int n FROM notifications WHERE rule_id=$1 AND mode='live'", [
        ruleId,
      ])
    )[0]!.n,
  ).toBe(1); // only day 30

  // (d) run cap: 4 qualifying events inside one UTC day, maxRunsPerDay 2. Values grow 100x so each stays a >3-sigma outlier.
  const capDay = Date.UTC(2026, 9, 5);
  const capEvents = [1e5, 1e7, 1e9, 1e11].map((vol, i) => ({
    sourceId,
    watermark: new Date(capDay + (i + 1) * 3_600_000).toISOString(),
    mode: "live" as const,
    values: { vol },
  }));
  const tasksBefore = (
    await q<{ n: number }>("SELECT count(*)::int n FROM marker_tasks WHERE marker_id=$1", [markerId])
  )[0]!.n;
  for (const e of capEvents) await sch.processEvent(e);
  const capRows = await q<{ status: string; task_id: string | null }>(
    "SELECT status, task_id FROM monitor_evaluations WHERE rule_id=$1 AND mode='live' AND watermark >= $2::date AND watermark < ($2::date + 1) ORDER BY watermark",
    [ruleId, new Date(capDay).toISOString().slice(0, 10)],
  );
  expect(capRows.map((r) => r.status)).toEqual([
    "fired",
    "fired",
    "suppressed_run_cap",
    "suppressed_run_cap",
  ]);
  const capTasks =
    (await q<{ n: number }>("SELECT count(*)::int n FROM marker_tasks WHERE marker_id=$1", [markerId]))[0]!
      .n - tasksBefore;
  expect(capTasks).toBe(2); // only 2 agent tasks enqueued
  expect(capRows.filter((r) => r.task_id).length).toBe(2);
  // the deterministic evaluation ran for all 4 and made 0 model or paid calls: nothing was dispatched during evaluation
  expect(port.starts).toHaveLength(0);
  const pendingOnly = await q<{ status: string }>(
    "SELECT DISTINCT status FROM marker_tasks WHERE marker_id=$1 AND mode='live'",
    [markerId],
  );
  expect(pendingOnly.map((r) => r.status)).toEqual(["PENDING"]);

  // (e) every trigger record stores rule id, rule version, semantic version, watermark and the evaluated value
  const all = await q<{
    rule_id: string;
    rule_version: number;
    semantic_version: string | null;
    watermark: Date | null;
    evaluated_value: { values?: unknown };
  }>(
    "SELECT rule_id, rule_version, semantic_version, watermark, evaluated_value FROM monitor_evaluations WHERE rule_id=$1",
    [ruleId],
  );
  expect(all.length).toBeGreaterThan(60);
  expect(
    all.every(
      (r) =>
        r.rule_id === ruleId &&
        r.rule_version >= 1 &&
        r.semantic_version === "1.0.0" &&
        r.watermark &&
        r.evaluated_value.values !== undefined,
    ),
  ).toBe(true);

  // Negative control: the verdict over cap rows detects an ignored cap (all four would be "fired" with 4 tasks)
  const capOk = (rows: string[], tasks: number) =>
    tasks === 2 && rows.filter((r) => r === "suppressed_run_cap").length === 2;
  expect(
    capOk(
      capRows.map((r) => r.status),
      capTasks,
    ),
  ).toBe(true);
  expect(capOk(["fired", "fired", "fired", "fired"], 4)).toBe(false);

  observe({
    testId: "M15",
    observed: `${invalid.length} invalid rules (eval strings, SQL fragments, unknown kind, unknown metric, unknown semantic version) all rejected 422 with 0 rows and no code executed. Valid z-score rule (window 30d, |z|>3, maxRunsPerDay 2, finalized_only): the +4 sigma day fired (z=${d30.evaluated_value.stats!.vol!.z.toFixed(6)} vs an independent reference), the +2 sigma day did not (z=${d31.evaluated_value.stats!.vol!.z.toFixed(6)}); live and replay passes over the 33-event series produced byte-equal evaluation outputs (${live1.length} rows) and a second pass changed nothing; the provisional watermark was recorded not_final with 0 triggers; 4 qualifying events in one UTC day enqueued exactly 2 tasks (2 suppressed_run_cap) with 0 run-port calls during evaluation; all ${all.length} evaluation records carry rule id, rule version, semantic version 1.0.0, watermark and evaluated value`,
    fixtureHash: sha256({ fixture: "fx.monitor.series-zscore", series, capEvents }),
    evidence: {
      rejections,
      zscores: { plus4: d30.evaluated_value.stats!.vol, plus2: d31.evaluated_value.stats!.vol },
      outputsHash: sha256(live1),
      replayHash: sha256(replay1),
      secondPassHash: sha256(live2),
      capStatuses: capRows.map((r) => r.status),
      capTasks,
      runPortCallsDuringEvaluation: port.starts.length,
      catalog: "SYNTHETIC fixture catalog injected through KernelConfig.monitoring",
    },
  });
}, 120_000);
