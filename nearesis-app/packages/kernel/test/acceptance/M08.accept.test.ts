import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { createTestDb, loginSession, runCmd, seedOrg, testKernel } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";
import type { Kernel, Session } from "../../src/index.ts";
import { ScriptedRunPort, cmd, rejected, sha256, workspaceWithPanel, wsVersion } from "./m-helpers.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  s = await loginSession(k, (await seedOrg(db.admin, "m08", { alice: "owner" })).users.alice!.subject);
});
afterAll(async () => db?.drop());

const STATES = [
  "DRAFT",
  "ACTIVE",
  "INVESTIGATING",
  "REVIEW_REQUIRED",
  "RESOLVED",
  "MONITORING",
  "DISMISSED",
] as const;
type St = (typeof STATES)[number];
// The legal set is transcribed from ch.09 "Marker state machine" (DRAFT -> ACTIVE -> INVESTIGATING -> REVIEW_REQUIRED ->
// RESOLVED | MONITORING | DISMISSED), deliberately NOT imported from the implementation under test.
const LEGAL = new Set([
  "DRAFT>ACTIVE",
  "ACTIVE>INVESTIGATING",
  "INVESTIGATING>REVIEW_REQUIRED",
  "REVIEW_REQUIRED>RESOLVED",
  "REVIEW_REQUIRED>MONITORING",
  "REVIEW_REQUIRED>DISMISSED",
]);

it("M08: marker transitions follow exactly the six specified edges with optimistic concurrency, one event per transition, and recurring monitor triggers need no seventh edge", async () => {
  const { workspaceId, panelId } = await workspaceWithPanel(k, db, s);
  const orgId = (await db.admin.query("SELECT org_id FROM workspaces WHERE id=$1", [workspaceId])).rows[0]
    .org_id;

  // fx.workspace.marker-baseline: a rule attached to the fixture markers (MONITORING needs one), a second tenant.
  const baseRuleMarker = randomUUID();
  await cmd(k, db, s, workspaceId, "marker.create", {
    panelId,
    markerId: baseRuleMarker,
    anchor: { kind: "time_point", at: "2026-10-01T00:00:00Z" },
  });
  const baseRule = randomUUID();
  await cmd(k, db, s, workspaceId, "monitor.rule_create", {
    ruleId: baseRule,
    name: "baseline",
    markerId: baseRuleMarker,
    sourceId: "m08.baseline",
    condition: { kind: "compare", metricId: "v", op: "gt", value: 1 },
  });
  const insertMarker = async (status: St): Promise<string> => {
    const id = randomUUID();
    await db.admin.query(
      `INSERT INTO markers(id, org_id, workspace_id, panel_id, anchor_json, status, monitor_rule_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        orgId,
        workspaceId,
        panelId,
        JSON.stringify({ kind: "time_point", at: "2026-10-01T00:00:00Z" }),
        status,
        baseRule,
      ],
    );
    return id;
  };
  const snap = async (markerId: string) => {
    const m = (await db.admin.query("SELECT status, version FROM markers WHERE id=$1", [markerId])).rows[0];
    const ev = (
      await db.admin.query("SELECT count(*)::int n FROM workspace_events WHERE workspace_id=$1", [
        workspaceId,
      ])
    ).rows[0].n as number;
    const ob = (
      await db.admin.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1", [workspaceId])
    ).rows[0].n as number;
    return {
      status: m.status as string,
      version: m.version as number,
      events: ev,
      outbox: ob,
      ws: await wsVersion(db, workspaceId),
    };
  };
  const payloadFor = (markerId: string, to: St) => ({
    markerId,
    to,
    ...(to === "RESOLVED" || to === "DISMISSED" ? { resolution: "reviewed by fixture" } : {}),
  });

  // (1) all 49 ordered pairs with the correct expected version.
  const matrix: Array<{ from: St; to: St; legal: boolean; result: string; code: number }> = [];
  const idemCase: { markerId: string; commandId: string; first: string; to: St } = {
    markerId: "",
    commandId: "",
    first: "",
    to: "ACTIVE",
  };
  let legalSucceeded = 0;
  for (const from of STATES) {
    for (const to of STATES) {
      const markerId = await insertMarker(from);
      const before = await snap(markerId);
      const legal = LEGAL.has(`${from}>${to}`);
      if (legal) {
        const commandId = randomUUID();
        const acc = await runCmd(
          k,
          s,
          workspaceId,
          "marker.transition",
          payloadFor(markerId, to),
          before.ws,
          commandId,
        );
        const after = await snap(markerId);
        // (d) exactly one marker.* event and one outbox row with the same seq; version +1
        expect(after.status).toBe(to);
        expect(after.version).toBe(before.version + 1);
        expect(after.events).toBe(before.events + 1);
        expect(after.outbox).toBe(before.outbox + 1);
        const ev = (
          await db.admin.query(
            `SELECT e.event_type, e.seq, (SELECT count(*)::int FROM outbox o WHERE o.event_id = e.event_id) outbox_rows
               FROM workspace_events e WHERE e.workspace_id=$1 AND e.seq=$2`,
            [workspaceId, acc.eventSeq],
          )
        ).rows[0];
        expect(ev).toMatchObject({ event_type: "marker.transitioned", seq: acc.eventSeq, outbox_rows: 1 });
        legalSucceeded++;
        if (!idemCase.markerId)
          Object.assign(idemCase, { markerId, commandId, first: acc.resultFingerprint, to });
        matrix.push({ from, to, legal, result: "ok", code: 200 });
      } else {
        const e = await rejected(
          runCmd(k, s, workspaceId, "marker.transition", payloadFor(markerId, to), before.ws),
        );
        expect(e.status).toBe(422); // (b)
        expect(e.reasonCode).toBe("INVALID_MARKER_TRANSITION");
        expect(await snap(markerId)).toEqual(before); // row, version, journal, outbox, workspace version unchanged
        matrix.push({ from, to, legal, result: e.reasonCode, code: e.status });
      }
    }
  }
  // Negative control: the same verdict logic applied to a matrix where DRAFT->RESOLVED was accepted, or the recurring
  // trigger moved the marker, must report a violation (otherwise the test could not detect either defect).
  const violations = (m: typeof matrix) =>
    m.filter((x) => (x.result === "ok") !== LEGAL.has(`${x.from}>${x.to}`));
  expect(violations(matrix)).toHaveLength(0);
  const broken = matrix.map((x) =>
    x.from === "DRAFT" && x.to === "RESOLVED" ? { ...x, result: "ok", code: 200 } : x,
  );
  expect(violations(broken)).toHaveLength(1);
  expect(matrix).toHaveLength(49);
  expect(legalSucceeded).toBe(6);
  expect(matrix.filter((m) => m.legal)).toHaveLength(6);

  // (c) stale expected version on every legal pair: 409, no second mutation
  const stale: number[] = [];
  for (const edge of LEGAL) {
    const [from, to] = edge.split(">") as [St, St];
    const markerId = await insertMarker(from);
    const before = await snap(markerId);
    const e = await rejected(
      runCmd(k, s, workspaceId, "marker.transition", payloadFor(markerId, to), before.ws - 1),
    );
    expect(e.status).toBe(409);
    expect(await snap(markerId)).toEqual(before);
    stale.push(e.status);
  }
  expect(stale).toEqual([409, 409, 409, 409, 409, 409]);

  // (e) idempotent replay returns the original fingerprint and adds no event
  const beforeReplay = await snap(idemCase.markerId);
  const replay = await runCmd(
    k,
    s,
    workspaceId,
    "marker.transition",
    payloadFor(idemCase.markerId, idemCase.to),
    beforeReplay.ws - 5, // stale on purpose: a retry after success must replay, not look stale
    idemCase.commandId,
  );
  expect(replay.resultFingerprint).toBe(idemCase.first);
  expect(await snap(idemCase.markerId)).toEqual(beforeReplay);

  // (f) recurring monitor triggers on a MONITORING marker: linked investigation tasks, no status change, no 7th edge.
  const markerId = randomUUID();
  await cmd(k, db, s, workspaceId, "marker.create", {
    panelId,
    markerId,
    anchor: { kind: "threshold", metricId: "vol", op: "gt", value: 100 },
    question: "Why does volume keep crossing 100?",
  });
  const sourceId = `m08.vol.${randomUUID().slice(0, 8)}`;
  const ruleId = randomUUID();
  await cmd(k, db, s, workspaceId, "monitor.rule_create", {
    ruleId,
    name: "recurring vol breach",
    markerId,
    sourceId,
    action: "investigate",
    condition: { kind: "compare", metricId: "vol", op: "gt", value: 100 },
  });
  for (const to of ["ACTIVE", "INVESTIGATING", "REVIEW_REQUIRED"] as const)
    await cmd(k, db, s, workspaceId, "marker.transition", { markerId, to });
  await cmd(k, db, s, workspaceId, "marker.transition", { markerId, to: "MONITORING" });
  const mk = async () => (await k.monitoring.listMarkers(s, workspaceId, markerId))[0]!;
  expect(await mk()).toMatchObject({ status: "MONITORING" });
  const versionBefore = (await mk()).version;

  const sch = k.monitorScheduler();
  const at = (h: number) => new Date(Date.UTC(2026, 9, 28, h)).toISOString();
  const eventsBefore = (
    await db.admin.query(
      "SELECT count(*)::int n FROM workspace_events WHERE workspace_id=$1 AND event_type='marker.transitioned'",
      [workspaceId],
    )
  ).rows[0].n as number;
  const r1 = await sch.processEvent({ sourceId, watermark: at(1), mode: "live", values: { vol: 500 } });
  const r2 = await sch.processEvent({ sourceId, watermark: at(2), mode: "live", values: { vol: 600 } });
  const again = await sch.processEvent({ sourceId, watermark: at(1), mode: "live", values: { vol: 500 } });
  expect(again.map((r) => r.outcome)).toEqual(["duplicate"]);
  const tasks = await k.monitoring.listTasks(s, workspaceId, markerId);
  expect(tasks).toHaveLength(2); // one per distinct (rule, watermark); the replay of at(1) created none
  expect(new Set(tasks.map((t) => t.triggerId)).size).toBe(2);
  expect(tasks.every((t) => t.origin === "rule")).toBe(true);
  const links = (
    await db.admin.query(
      "SELECT payload FROM workspace_events WHERE workspace_id=$1 AND event_type='marker.assigned' AND payload->>'markerId'=$2 AND payload->>'origin'='rule'",
      [workspaceId, markerId],
    )
  ).rows.map((r) => r.payload as { taskId: string; triggerId: string });
  expect(links).toHaveLength(2); // one link event per task, each carrying markerId + triggerId
  expect(new Set(links.map((l) => l.taskId))).toEqual(new Set(tasks.map((t) => t.taskId)));
  expect(new Set(links.map((l) => l.triggerId))).toEqual(new Set([r1[0]!.triggerId, r2[0]!.triggerId]));

  // task lifecycle (queued, running, completed) with its own status; output attached as evidence, marker unchanged
  const port = new ScriptedRunPort();
  const dispatcher = k.markerTasks(port);
  const lifecycle: string[] = [];
  const statusOf = async () =>
    (await k.monitoring.listTasks(s, workspaceId, markerId)).map((t) => t.status).join("/");
  lifecycle.push(await statusOf());
  await dispatcher.dispatchOpen();
  lifecycle.push(await statusOf());
  await dispatcher.dispatchOpen();
  lifecycle.push(await statusOf());
  expect(lifecycle).toEqual(["PENDING/PENDING", "RUNNING/RUNNING", "COMPLETE/COMPLETE"]);
  const done = await mk();
  expect(done.status).toBe("MONITORING");
  expect(done.version).toBe(versionBefore + 2); // only the two evidence-link bumps, never a transition
  expect(done.linkedEvidenceIds).toHaveLength(2);
  const eventsAfter = (
    await db.admin.query(
      "SELECT count(*)::int n FROM workspace_events WHERE workspace_id=$1 AND event_type='marker.transitioned'",
      [workspaceId],
    )
  ).rows[0].n as number;
  expect(eventsAfter).toBe(eventsBefore); // no marker.transitioned event for any trigger or task
  // direct MONITORING -> INVESTIGATING is still illegal (the six-edge set is unchanged)
  const direct = await rejected(
    cmd(k, db, s, workspaceId, "marker.transition", { markerId, to: "INVESTIGATING" }),
  );
  expect(direct.status).toBe(422);
  expect(direct.reasonCode).toBe("INVALID_MARKER_TRANSITION");

  observe({
    testId: "M08",
    observed: `49 ordered pairs submitted with the correct expected version: exactly the 6 ch.09 edges succeeded (each +1 marker version, exactly 1 marker.transitioned event and 1 outbox row with the same seq); the other 43 returned 422 INVALID_MARKER_TRANSITION with marker, journal, outbox and workspace version unchanged; 6 stale-version attempts returned 409 with no mutation; idempotent replay added no event. On a MONITORING marker, 2 distinct monitor triggers created 2 linked investigation tasks (1 marker.assigned link event each with markerId+triggerId, a redelivered watermark created none); tasks ran PENDING->RUNNING->COMPLETE, 2 evidence nodes attached, marker stayed MONITORING with 0 marker.transitioned events; direct MONITORING->INVESTIGATING returned 422`,
    fixtureHash: sha256({
      fixture: "fx.workspace.marker-baseline",
      states: STATES,
      legal: [...LEGAL].sort(),
    }),
    evidence: {
      matrix,
      staleStatuses: stale,
      recurring: {
        tasks: tasks.map((t) => ({ taskId: t.taskId, triggerId: t.triggerId, origin: t.origin })),
        lifecycle,
        linkedEvidence: done.linkedEvidenceIds.length,
        markerStatus: done.status,
        runtime: "scripted RunPort (deterministic stand-in for the investigation runtime)",
      },
    },
  });
});
