import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { OutboxPublisher } from "../../src/index.ts";
import type { Kernel, Session } from "../../src/index.ts";
import { createTestDb, createWs, loginSession, runCmd, seedOrg, testKernel } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  await db.admin.query(
    "CREATE TABLE consumer_effects(consumer text, event_id uuid, applied_at timestamptz DEFAULT now())",
  );
  await db.admin.query("GRANT SELECT, INSERT ON consumer_effects TO nearesis_app");
  k = testKernel(db);
  const org = await seedOrg(db.admin, "k09", { alice: "owner" });
  s = await loginSession(k, org.users.alice!.subject);
});
afterAll(async () => db?.drop());

it("K09: duplicate outbox delivery produces exactly one logical effect per consumer", async () => {
  const pub = new OutboxPublisher(db.app);
  pub.register("projector", async ({ tx, event }) => {
    await tx.query("INSERT INTO consumer_effects(consumer, event_id) VALUES ('projector', $1)", [
      event.eventId,
    ]);
  });
  pub.register("notifier", async ({ tx, event }) => {
    await tx.query("INSERT INTO consumer_effects(consumer, event_id) VALUES ('notifier', $1)", [
      event.eventId,
    ]);
  });

  const { workspaceId, version } = await createWs(k, s);
  await runCmd(k, s, workspaceId, "workspace.update_objective", { objective: "changed" }, version);
  const events = (
    await db.admin.query("SELECT event_id FROM workspace_events WHERE workspace_id=$1 ORDER BY seq", [
      workspaceId,
    ])
  ).rows.map((r) => r.event_id as string);
  expect(events).toHaveLength(2);

  // Delivery 1.
  const r1 = await pub.runOnce();
  expect(r1).toEqual({ delivered: 2, failed: 0 });
  const effects = async () =>
    (
      await db.admin.query(
        "SELECT consumer, count(*)::int n FROM consumer_effects GROUP BY consumer ORDER BY consumer",
      )
    ).rows;
  expect(await effects()).toEqual([
    { consumer: "notifier", n: 2 },
    { consumer: "projector", n: 2 },
  ]);

  // Forced duplicate delivery: the broker "lost" the ack, so every row is re-published.
  await db.admin.query("UPDATE outbox SET published_at = NULL");
  const r2 = await pub.runOnce();
  expect(r2.delivered).toBe(2);
  // Direct duplicate deliveries of the same event, including concurrently.
  const ev = (
    await k.db.tx({ orgId: s.principal.orgId, userId: s.userId }, (tx) => k.journal.read(tx, workspaceId))
  )[0]!;
  const dup = await Promise.all([pub.deliver(ev), pub.deliver(ev), pub.deliver(ev)]);
  expect(dup).toEqual([0, 0, 0]);

  // Two publishers racing over fresh work: SKIP LOCKED + receipts => still one effect each.
  await runCmd(k, s, workspaceId, "workspace.update_objective", { objective: "again" }, version + 1);
  const pub2 = new OutboxPublisher(db.app);
  pub2.register("projector", async ({ tx, event }) => {
    await tx.query("INSERT INTO consumer_effects(consumer, event_id) VALUES ('projector', $1)", [
      event.eventId,
    ]);
  });
  await Promise.all([pub.runOnce(), pub2.runOnce()]);

  const final = await effects();
  const perEvent = (
    await db.admin.query(
      "SELECT consumer, event_id, count(*)::int n FROM consumer_effects GROUP BY 1,2 HAVING count(*) > 1",
    )
  ).rows;
  expect(perEvent).toEqual([]);
  expect(final).toEqual([
    { consumer: "notifier", n: 3 },
    { consumer: "projector", n: 3 },
  ]);
  const outbox = (
    await db.admin.query(
      "SELECT attempts, published_at IS NOT NULL AS published FROM outbox ORDER BY created_at",
    )
  ).rows;
  expect(outbox.every((o) => o.published)).toBe(true);
  expect(outbox.slice(0, 2).every((o) => o.attempts >= 2)).toBe(true);
  const receipts = (await db.admin.query("SELECT count(*)::int n FROM consumer_receipts")).rows[0].n;
  expect(receipts).toBe(6);

  observe({
    testId: "K09",
    observed: `3 events, 2 consumers; first events were delivered twice via outbox re-publish (attempts>=2) and 3 more times directly/concurrently, plus 2 racing publishers: effect rows per consumer = ${JSON.stringify(final)}, duplicate (consumer,event) effect rows = ${perEvent.length}, receipts = ${receipts}`,
    evidence: { effects: final, duplicates: perEvent.length, receipts, outbox },
  });
});
