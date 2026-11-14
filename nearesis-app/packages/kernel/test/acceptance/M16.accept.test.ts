import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { createTestDb, loginSession, seedOrg, testKernel } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";
import type { Kernel, Session } from "../../src/index.ts";
import { ScriptedRunPort, cmd, sha256, workspaceWithPanel } from "./m-helpers.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  s = await loginSession(k, (await seedOrg(db.admin, "m16", { alice: "owner" })).users.alice!.subject);
});
afterAll(async () => db?.drop());

// Text fields may say a replay is "not live data"; they may never label it live. Any other use of the word is a defect.
const labelsAsLive = (t: string): boolean => /(?<!not )\blive\b/i.test(t);

it("M16: a replayed event is flagged replay through trigger, task, notification, marker, SSE event and export, is never counted as live, and a second replay creates no new task", async () => {
  const { workspaceId, panelId } = await workspaceWithPanel(k, db, s);
  const sourceId = `m16.explorer.${randomUUID().slice(0, 8)}`;
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await db.admin.query(text, params)).rows as T[];

  // fx.monitor.replay-oct27: SYNTHETIC stand-in for recorded events around the 2026-10-27 regime change
  const replayEvents = [
    { watermark: "2026-10-26T00:00:00.000Z", values: { swaps: 900 } },
    { watermark: "2026-10-27T00:00:00.000Z", values: { swaps: 4100 } },
    { watermark: "2026-10-28T00:00:00.000Z", values: { swaps: 4300 } },
  ].map((e) => ({ sourceId, mode: "replay" as const, ...e }));
  // the live event has the SAME watermark as a replayed one, to prove the two are keyed separately
  const liveEvent = {
    sourceId,
    mode: "live" as const,
    watermark: "2026-10-27T00:00:00.000Z",
    values: { swaps: 4100 },
  };

  const markerId = randomUUID();
  await cmd(k, db, s, workspaceId, "marker.create", {
    panelId,
    markerId,
    anchor: { kind: "threshold", metricId: "swaps", op: "gt", value: 1000 },
    question: "What changed on 2026-10-27?",
  });
  const ruleId = randomUUID();
  await cmd(k, db, s, workspaceId, "monitor.rule_create", {
    ruleId,
    name: "swap surge",
    markerId,
    sourceId,
    action: "investigate",
    condition: { kind: "compare", metricId: "swaps", op: "gt", value: 1000 },
  });
  // a marker anchored to a replayed source event
  await k.monitorScheduler().enqueue(replayEvents[2]!);
  const replayMarkerId = randomUUID();
  await cmd(k, db, s, workspaceId, "marker.create", {
    panelId,
    markerId: replayMarkerId,
    anchor: { kind: "source_event", sourceId, eventId: "oct28-batch", at: replayEvents[2]!.watermark },
  });
  const liveMarkerId = randomUUID();
  await cmd(k, db, s, workspaceId, "marker.create", {
    panelId,
    markerId: liveMarkerId,
    anchor: { kind: "time_point", at: "2026-10-30T00:00:00Z" },
  });

  const sch = k.monitorScheduler();
  const port = new ScriptedRunPort();
  const dispatcher = k.markerTasks(port);
  // Step 1: replay the fixture events, then emit one live event for the same rule
  for (const e of replayEvents) await sch.processEvent(e);
  const liveRes = await sch.processEvent(liveEvent);
  expect(liveRes[0]!.outcome).toBe("fired"); // not deduped against the replay of the same watermark
  const tasks1 = await k.monitoring.listTasks(s, workspaceId, markerId);
  const countsBefore = await k.monitoring.triggerCounters(s, workspaceId);
  await dispatcher.dispatchOpen();

  // Step 3: replay the same events a second time
  const again = (await Promise.all(replayEvents.map((e) => sch.processEvent(e)))).flat();
  expect(again.every((r) => r.outcome === "duplicate")).toBe(true);
  const tasks2 = await k.monitoring.listTasks(s, workspaceId, markerId);
  expect(tasks2.map((t) => t.taskId).sort()).toEqual(tasks1.map((t) => t.taskId).sort()); // (c) 0 new tasks

  // Step 2: every artefact derived from a replayed event carries mode=replay; the live one carries mode=live
  const triggers = await k.monitoring.listTriggers(s, workspaceId, ruleId);
  const notifs = await k.monitoring.listNotifications(s, workspaceId);
  const markers = await k.monitoring.listMarkers(s, workspaceId);
  const stream = await k.stream.read(s, workspaceId, 0, false);
  expect(stream.status).toBe("ok");
  const events = stream.status === "ok" ? stream.events : [];
  const modeOf = <T extends { mode: string }>(xs: T[]) => xs.map((x) => x.mode).sort();

  const firedTriggers = triggers.filter((t) => t.outcome === "fired");
  expect(modeOf(firedTriggers)).toEqual(["live", "replay", "replay"]);
  expect(triggers.every((t) => t.mode === "replay" || t.mode === "live")).toBe(true);
  expect(modeOf(notifs)).toEqual(["live", "replay", "replay"]);
  expect(modeOf(tasks2)).toEqual(["live", "replay", "replay"]);
  expect(markers.find((m) => m.markerId === replayMarkerId)!.mode).toBe("replay");
  expect(markers.find((m) => m.markerId === liveMarkerId)!.mode).toBe("live");
  const sse = events.filter((e) => ["monitor.triggered", "notification.created"].includes(e.type));
  expect(sse).toHaveLength(6); // 3 fired triggers x (monitor.triggered + notification.created)
  expect(sse.every((e) => e.data.mode === "replay" || e.data.mode === "live")).toBe(true);
  expect(sse.filter((e) => e.data.mode === "replay")).toHaveLength(4);
  const sseLinks = events.filter((e) => e.type === "marker.assigned" && e.data.origin === "rule");
  expect(sseLinks.map((e) => e.data.mode).sort()).toEqual(["live", "replay", "replay"]);
  const markerCreated = events.filter((e) => e.type === "marker.created");
  expect(markerCreated.find((e) => e.data.markerId === replayMarkerId)!.data.mode).toBe("replay");

  // (b) the live event's artefacts say live; counters include only the live event
  const live = {
    trigger: firedTriggers.find((t) => t.mode === "live")!,
    notif: notifs.find((n) => n.mode === "live")!,
  };
  expect(live.trigger.watermark).toBe(liveEvent.watermark);
  expect(live.notif.triggerId).toBe(live.trigger.triggerId);
  expect(countsBefore).toMatchObject({ live: 1, replay: 2 });
  const counters = await k.monitoring.triggerCounters(s, workspaceId);
  expect(counters).toMatchObject({ live: 1, replay: 2 });

  // (d) replay notifications are in-app only and never labelled live in any text field
  const eligibility = await q<{ mode: string; external_eligible: boolean; title: string; body: string }>(
    "SELECT mode, external_eligible, title, body FROM notifications WHERE workspace_id=$1",
    [workspaceId],
  );
  expect(eligibility.filter((n) => n.mode === "replay").every((n) => n.external_eligible === false)).toBe(
    true,
  );
  expect(eligibility.filter((n) => n.mode === "live").every((n) => n.external_eligible === true)).toBe(true);
  for (const n of eligibility.filter((x) => x.mode === "replay")) {
    expect(labelsAsLive(n.title)).toBe(false);
    expect(labelsAsLive(n.body)).toBe(false);
    expect(n.title.startsWith("[REPLAY]")).toBe(true);
  }
  for (const t of tasks2.filter((x) => x.mode === "replay")) expect(t.mode).toBe("replay");
  expect(
    port.starts.filter((st) => st.mode === "replay").every((st) => st.question.startsWith("[REPLAY")),
  ).toBe(true);
  expect(port.starts.filter((st) => st.mode === "replay").length).toBe(2);

  // (e) the exported history labels replay rows and the report contains the text REPLAY
  const exp = await k.monitoring.exportTriggerHistory(s, workspaceId);
  expect(exp.rows.filter((r) => r.mode === "replay").every((r) => r.label === "REPLAY")).toBe(true);
  expect(exp.rows.filter((r) => r.mode === "live").every((r) => r.label === "LIVE")).toBe(true);
  expect(exp.report).toContain("REPLAY");
  expect(
    exp.csv
      .split("\n")
      .filter((l) => l.includes(",replay,"))
      .every((l) => l.includes(",REPLAY,")),
  ).toBe(true);

  // Negative control: stripping the flag in a serializer must be caught by the same check
  const stripped = notifs.map((n) => ({ ...n, mode: "live" as const }));
  expect(modeOf(stripped)).not.toEqual(["live", "replay", "replay"]);

  observe({
    testId: "M16",
    observed: `3 replayed events (2 breach the threshold; fixture standing in for recorded 2026-10-27 events) plus 1 live event at the same watermark as one of them: trigger rows ${modeOf(firedTriggers).join("/")}, notifications ${modeOf(notifs).join("/")}, tasks ${modeOf(tasks2).join("/")}, SSE payloads (monitor.triggered, notification.created, marker.assigned) and marker.created for a replay-anchored marker all carry mode; the live counter is ${counters.live} and the replay counter ${counters.replay}; replay and live of the same (rule, watermark) are separate keys; a second replay of all 3 events was 3 duplicates and created 0 tasks; replay notifications are external_eligible=false and none labels itself live; the export labels the REPLAY rows and the report contains REPLAY`,
    fixtureHash: sha256({ fixture: "fx.monitor.replay-oct27", replayEvents, liveEvent }),
    evidence: {
      counters,
      triggerModes: modeOf(firedTriggers),
      notificationModes: modeOf(notifs),
      taskModes: modeOf(tasks2),
      sseModes: sse.map((e) => `${e.type}:${String(e.data.mode)}`),
      secondReplayOutcomes: again.map((r) => r.outcome),
      exportReport: exp.report.split("\n")[0],
      fixtureLabel: "SYNTHETIC (no recorded Explorer events for 2026-10-27 are committed)",
    },
  });
}, 60_000);
