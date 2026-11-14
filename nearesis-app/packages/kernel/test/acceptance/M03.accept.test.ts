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
  s = await loginSession(k, (await seedOrg(db.admin, "m03", { alice: "owner" })).users.alice!.subject);
});
afterAll(async () => db?.drop());

it("M03: the same source watermark delivered to competing workers triggers each rule exactly once", async () => {
  const { workspaceId } = await createWs(k, s);
  const sourceId = `explorer.swaps.${randomUUID().slice(0, 8)}`;
  const ruleIds: string[] = [];
  for (const name of ["spike-a", "spike-b", "spike-c"]) {
    const ruleId = randomUUID();
    ruleIds.push(ruleId);
    await runCmd(
      k,
      s,
      workspaceId,
      "monitor.rule_create",
      { ruleId, name, sourceId, condition: { kind: "compare", metricId: "swaps", op: "gt", value: 1000 } },
      (await k.workspaces.get(s, workspaceId)).version,
    );
  }
  const event = {
    sourceId,
    watermark: "2026-10-28T06:00:00.000Z",
    mode: "live" as const,
    values: { swaps: 4200 },
  };

  // 8 independent workers (separate scheduler instances, no lease between them) race on the identical event, and the
  // collector re-delivers it twice.
  const workers = Array.from({ length: 8 }, (_, i) => k.monitorScheduler({ holder: `w${i}` }));
  const results = (
    await Promise.all([
      ...workers.map((w) => w.processEvent(event)),
      workers[0]!.processEvent(event),
      workers[1]!.processEvent(event),
    ])
  ).flat();

  const triggers = (
    await db.admin.query("SELECT rule_id, mode, outcome FROM monitor_triggers WHERE source_id=$1", [sourceId])
  ).rows;
  const notifs = (
    await db.admin.query("SELECT rule_id FROM notifications WHERE workspace_id=$1", [workspaceId])
  ).rows;
  const events = (
    await db.admin.query(
      "SELECT payload FROM workspace_events WHERE workspace_id=$1 AND event_type='monitor.triggered'",
      [workspaceId],
    )
  ).rows;
  const perRule = ruleIds.map((id) => triggers.filter((t) => t.rule_id === id).length);
  const fired = results.filter((r) => r.outcome === "fired").length;
  const dup = results.filter((r) => r.outcome === "duplicate").length;

  expect(perRule).toEqual([1, 1, 1]);
  expect(triggers.every((t) => t.outcome === "fired" && t.mode === "live")).toBe(true);
  expect(notifs).toHaveLength(3);
  expect(events).toHaveLength(3);
  expect(fired).toBe(3);
  expect(dup).toBe(results.length - 3);

  // A different watermark is a new event (negative case: dedupe is per watermark, not per rule).
  const next = await workers[2]!.processEvent({ ...event, watermark: "2026-10-28T07:00:00.000Z" });
  expect(next.map((r) => r.outcome).sort()).toEqual(["fired", "fired", "fired"]);

  observe({
    testId: "M03",
    observed: `${results.length} concurrent evaluations (8 workers + 2 redeliveries) of one watermark over 3 rules produced ${triggers.length} trigger rows (${perRule.join("/")} per rule), ${notifs.length} notifications, ${events.length} monitor.triggered events; ${fired} fired, ${dup} reported duplicate; a new watermark fired all 3 again`,
    evidence: {
      evaluations: results.length,
      triggerRows: triggers.length,
      notifications: notifs.length,
      journalEvents: events.length,
      duplicates: dup,
    },
  });
});
