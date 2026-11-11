import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import { createTestDb, createWs, loginSession, runCmd, seedOrg, testKernel } from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";
import type { Kernel, Session } from "../src/index.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  s = await loginSession(k, (await seedOrg(db.admin, "monbatch", { alice: "owner" })).users.alice!.subject);
});
afterAll(async () => db?.drop());

it("one event over many rules of a workspace journals contiguous, hash-correct events with one outbox row each (PERF03 batching)", async () => {
  const { workspaceId } = await createWs(k, s);
  const sourceId = `batch.${randomUUID().slice(0, 8)}`;
  const RULES = 12;
  for (let i = 0; i < RULES; i++)
    await runCmd(
      k,
      s,
      workspaceId,
      "monitor.rule_create",
      {
        ruleId: randomUUID(),
        name: `r${i}`,
        sourceId,
        condition: { kind: "compare", metricId: "swaps", op: "gt", value: i < 8 ? 10 : 99999 },
      },
      (await k.workspaces.get(s, workspaceId)).version,
    );
  const before = (
    await db.admin.query("SELECT coalesce(max(seq),0)::int m FROM workspace_events WHERE workspace_id=$1", [
      workspaceId,
    ])
  ).rows[0].m as number;
  const res = await k
    .monitorScheduler()
    .processEvent({ sourceId, watermark: "2026-10-28T06:00:00.000Z", mode: "live", values: { swaps: 500 } });
  expect(res.filter((r) => r.outcome === "fired")).toHaveLength(8);
  expect(res.filter((r) => r.outcome === "condition_false")).toHaveLength(4);

  const ev = (
    await db.admin.query(
      "SELECT event_id, seq, event_type, payload, payload_hash FROM workspace_events WHERE workspace_id=$1 AND seq > $2 ORDER BY seq",
      [workspaceId, before],
    )
  ).rows;
  expect(ev).toHaveLength(16); // monitor.triggered + notification.created per fired rule
  expect(ev.map((e) => Number(e.seq))).toEqual(Array.from({ length: 16 }, (_, i) => before + 1 + i));
  expect(ev.map((e) => e.event_type)).toEqual(
    Array.from({ length: 8 }, () => ["monitor.triggered", "notification.created"]).flat(),
  );
  for (const e of ev) expect(e.payload_hash).toBe(sha256Hex(canonicalJson(e.payload)));
  const ob = (
    await db.admin.query(
      "SELECT count(*)::int n, count(DISTINCT event_id)::int d FROM outbox WHERE workspace_id=$1 AND event_id = ANY($2::uuid[]) AND topic='workspace.entity.changed.v1'",
      [workspaceId, ev.map((e) => e.event_id)],
    )
  ).rows[0];
  expect(ob).toEqual({ n: 16, d: 16 });

  // Redelivery: all duplicates, nothing new is journaled.
  const again = await k
    .monitorScheduler()
    .processEvent({ sourceId, watermark: "2026-10-28T06:00:00.000Z", mode: "live", values: { swaps: 500 } });
  expect(again.every((r) => r.outcome === "duplicate")).toBe(true);
  const after = (
    await db.admin.query("SELECT max(seq)::int m FROM workspace_events WHERE workspace_id=$1", [workspaceId])
  ).rows[0].m as number;
  expect(after).toBe(before + 16);
});
