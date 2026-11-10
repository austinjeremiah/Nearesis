import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { KernelError } from "../../src/index.ts";
import type { Kernel, Session } from "../../src/index.ts";
import { createTestDb, createWs, loginSession, runCmd, seedOrg, testKernel } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  const org = await seedOrg(db.admin, "k02", { alice: "owner" });
  s = await loginSession(k, org.users.alice!.subject);
});
afterAll(async () => db?.drop());

async function snapshot(wsId: string) {
  const w = (await db.admin.query("SELECT version, objective FROM workspaces WHERE id=$1", [wsId])).rows[0];
  const ev = (
    await db.admin.query("SELECT count(*)::int n FROM workspace_events WHERE workspace_id=$1", [wsId])
  ).rows[0].n;
  const cm = (await db.admin.query("SELECT count(*)::int n FROM commands WHERE workspace_id=$1", [wsId]))
    .rows[0].n;
  const ob = (await db.admin.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1", [wsId]))
    .rows[0].n;
  return {
    version: w.version as number,
    objective: w.objective as string,
    events: ev as number,
    commands: cm as number,
    outbox: ob as number,
  };
}

it("K02: stale expected version returns 409 STALE_VERSION and performs no second mutation", async () => {
  const { workspaceId, version } = await createWs(k, s, "initial");
  expect(version).toBe(1);

  const first = await runCmd(
    k,
    s,
    workspaceId,
    "workspace.update_objective",
    { objective: "first writer" },
    1,
  );
  expect(first.workspaceVersion).toBe(2);
  const afterFirst = await snapshot(workspaceId);

  // Second writer still holds version 1.
  let err: unknown;
  try {
    await runCmd(k, s, workspaceId, "workspace.update_objective", { objective: "stale writer" }, 1);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(KernelError);
  const ke = err as KernelError;
  expect(ke.code).toBe("STALE_VERSION");
  expect(ke.opts.lastStableRevision).toBe(2);
  const afterStale = await snapshot(workspaceId);
  expect(afterStale).toEqual(afterFirst);
  expect(afterStale.objective).toBe("first writer");

  // Concurrent race at the same expected version: exactly one wins.
  const race = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) =>
      runCmd(k, s, workspaceId, "workspace.update_objective", { objective: `racer ${i}` }, 2),
    ),
  );
  const won = race.filter((r) => r.status === "fulfilled").length;
  const stale = race.filter(
    (r) => r.status === "rejected" && (r.reason as KernelError).code === "STALE_VERSION",
  ).length;
  expect(won).toBe(1);
  expect(stale).toBe(5);
  const afterRace = await snapshot(workspaceId);
  expect(afterRace.version).toBe(3);
  expect(afterRace.events).toBe(afterFirst.events + 1);
  expect(afterRace.commands).toBe(afterFirst.commands + 1);

  observe({
    testId: "K02",
    observed: `stale write -> ${ke.code}/${ke.reasonCode} (lastStableRevision=${ke.opts.lastStableRevision}); state identical before/after (version ${afterStale.version}, events ${afterStale.events}, commands ${afterStale.commands}, outbox ${afterStale.outbox}); 6-way race at same version: ${won} won, ${stale} STALE_VERSION, events +1`,
    fixtureHash: null,
    evidence: { afterFirst, afterStale, afterRace, race: { won, stale } },
  });
});
