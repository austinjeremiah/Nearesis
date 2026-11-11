import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { createTestDb, createWs, loginSession, runCmd, seedOrg, testKernel } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";
import type { Kernel, Session } from "../../src/index.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  s = await loginSession(k, (await seedOrg(db.admin, "m05", { alice: "owner" })).users.alice!.subject);
});
afterAll(async () => db?.drop());

it("M05: a repetitive anomaly yields one notification per cooldown window, deduped by watermark", async () => {
  const { workspaceId } = await createWs(k, s);
  const sourceId = `quotes.${randomUUID().slice(0, 8)}`;
  const ruleId = randomUUID();
  await runCmd(
    k,
    s,
    workspaceId,
    "monitor.rule_create",
    {
      ruleId,
      name: "Quote failure rate",
      sourceId,
      condition: { kind: "compare", metricId: "failure_rate", op: "gt", value: 0.2 },
      debounceSeconds: 120,
      cooldownSeconds: 3600,
    },
    (await k.workspaces.get(s, workspaceId)).version,
  );
  const sch = k.monitorScheduler();
  const at = (min: number) => new Date(Date.UTC(2026, 9, 28, 0, min)).toISOString();

  // 45 consecutive minutes of breach (first hour window), each at a distinct watermark; the same minute is also redelivered.
  const outcomes: string[] = [];
  for (let m = 0; m < 45; m++) {
    const e = { sourceId, watermark: at(m), mode: "live" as const, values: { failure_rate: 0.35 } };
    outcomes.push((await sch.processEvent(e))[0]!.outcome);
    if (m % 10 === 0) outcomes.push((await sch.processEvent(e))[0]!.outcome);
  }
  const firstWindow = (
    await db.admin.query("SELECT count(*)::int n FROM notifications WHERE rule_id=$1", [ruleId])
  ).rows[0].n;
  expect(firstWindow).toBe(1);
  expect(outcomes.filter((o) => o === "fired")).toHaveLength(1);
  expect(outcomes.filter((o) => o === "debounced")).toHaveLength(2); // minutes 0 and 1 (the 120 s debounce)
  expect(outcomes.filter((o) => o === "duplicate").length).toBe(5); // redeliveries at minutes 0,10,20,30,40
  expect(outcomes.filter((o) => o === "cooldown").length).toBe(45 - 3);

  // Inside the window: no new notification. After it elapses the still-breaching anomaly notifies once more.
  const after = (
    await sch.processEvent({ sourceId, watermark: at(59), mode: "live", values: { failure_rate: 0.4 } })
  )[0]!.outcome;
  const next = (
    await sch.processEvent({ sourceId, watermark: at(125), mode: "live", values: { failure_rate: 0.4 } })
  )[0]!.outcome;
  const total = (await db.admin.query("SELECT count(*)::int n FROM notifications WHERE rule_id=$1", [ruleId]))
    .rows[0].n;
  expect([after, next]).toEqual(["cooldown", "fired"]);
  expect(total).toBe(2);

  observe({
    testId: "M05",
    observed: `45 breaching minutes (+5 redeliveries) with debounce 120s and cooldown 3600s: 1 notification in the first window (2 debounced, ${outcomes.filter((o) => o === "cooldown").length} cooldown, 5 duplicate); minute 59 still in cooldown; minute 125 produced the second window's single notification (total 2)`,
    evidence: {
      firstWindowNotifications: firstWindow,
      totalNotifications: total,
      outcomes: Object.fromEntries(
        [...new Set(outcomes)].map((o) => [o, outcomes.filter((x) => x === o).length]),
      ),
    },
  });
});
