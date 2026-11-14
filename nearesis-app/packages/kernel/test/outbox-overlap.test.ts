import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Kernel, Session } from "../src/index.ts";
import { createTestDb, createWs, loginSession, seedOrg, testKernel } from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
let ws: string;

beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  await k.boot();
  const a = await seedOrg(db.admin, "outboxoverlap", { alice: "owner" });
  s = await loginSession(k, a.users.alice!.subject);
  ws = (await createWs(k, s, "outbox overlap")).workspaceId;
});
afterAll(async () => {
  k?.outbox.stop();
  await db?.drop();
});

/**
 * Regression: the publisher polled on a timer with no re-entrancy guard. A backlog that took longer than the interval made
 * polls overlap; each held a connection for its batch and needed a second one per delivery, so the pool (8 here, 10 in
 * production) filled with polls waiting for a connection and delivery stopped for good.
 */
it("a slow consumer and a backlog do not exhaust the pool: polls never overlap and every event is delivered", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  k.outbox.register("slow-effect", async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 120));
    inFlight--;
  });
  k.outbox.start(10); // far shorter than one batch takes: ticks must be skipped, not stacked
  for (let i = 0; i < 24; i++) {
    // events keep arriving while earlier polls are still delivering, so every poll has something to claim
    const v = (await k.workspaces.get(s, ws)).version;
    await k.commands.execute(s, ws, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "workspace.update_objective",
      payload: { objective: `o${i}` },
      expectedVersion: v,
    });
    await new Promise((r) => setTimeout(r, 30));
  }
  const deadline = Date.now() + 60_000;
  let pending = 1;
  while (pending > 0 && Date.now() < deadline) {
    pending = Number(
      (await db.admin.query("SELECT count(*)::int n FROM outbox WHERE published_at IS NULL")).rows[0]!.n,
    );
    await new Promise((r) => setTimeout(r, 200));
  }
  k.outbox.stop();
  expect(pending).toBe(0);
  expect(maxInFlight).toBe(1); // deliveries were strictly sequential: one poll at a time
}, 120_000);
