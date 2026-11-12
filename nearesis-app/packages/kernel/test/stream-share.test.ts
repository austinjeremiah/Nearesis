import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kernel, Session } from "../src/index.ts";
import { createTestDb, createWs, loginSession, seedOrg, testKernel } from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";

let db: TestDb;
let k: Kernel;
let s: Session;
let outsider: Session;
let ws: string;

beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db, {}, { stream: { headCacheMs: 150, maxLag: 50, batch: 20 } });
  await k.boot();
  const a = await seedOrg(db.admin, "streamshare", { alice: "owner" });
  const b = await seedOrg(db.admin, "streamshare2", { eve: "owner" });
  s = await loginSession(k, a.users.alice!.subject);
  outsider = await loginSession(k, b.users.eve!.subject);
  ws = (await createWs(k, s, "stream share")).workspaceId;
});
afterAll(async () => db?.drop());

const update = async (n: number) => {
  for (let i = 0; i < n; i++) {
    const v = (await k.workspaces.get(s, ws)).version;
    await k.commands.execute(s, ws, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "workspace.update_objective",
      payload: { objective: `o-${Date.now()}-${i}` },
      expectedVersion: v,
    });
  }
};

describe("shared journal window (headCacheMs)", () => {
  it("many subscribers polling one workspace cost about one read per window, and every one sees every event once, in order", async () => {
    await update(3);
    const subs = Array.from({ length: 60 }, () => ({ cursor: 0, seqs: [] as number[], first: true }));
    const txSpy = vi.spyOn(k.db, "tx");
    const stop = Date.now() + 1500;
    let produced = 0;
    const producer = (async () => {
      while (Date.now() < stop) {
        await update(1);
        produced++;
        await new Promise((r) => setTimeout(r, 40));
      }
    })();
    let reads = 0;
    await Promise.all(
      subs.map(async (sub, i) => {
        await new Promise((r) => setTimeout(r, i * 3));
        while (Date.now() < stop + 400) {
          const r = await k.stream.read(s, ws, sub.cursor, sub.first);
          sub.first = false;
          reads++;
          if (r.status === "ok") {
            for (const e of r.events) {
              sub.seqs.push(e.seq);
              sub.cursor = e.seq;
            }
          } else if (r.status === "coalesced") sub.cursor = r.aggregate.toSeq;
          await new Promise((res) => setTimeout(res, 20));
        }
      }),
    );
    await producer;
    // one drain read each so that a window that closed just before the end does not hide the tail
    await new Promise((r) => setTimeout(r, 200));
    for (const sub of subs) {
      const r = await k.stream.read(s, ws, sub.cursor, false);
      if (r.status === "ok")
        for (const e of r.events) {
          sub.seqs.push(e.seq);
          sub.cursor = e.seq;
        }
    }
    const head = Number(
      (await db.admin.query("SELECT max(seq) m FROM workspace_events WHERE workspace_id=$1", [ws])).rows[0]!
        .m,
    );
    expect(produced).toBeGreaterThan(10);
    for (const sub of subs) {
      expect(sub.seqs).toEqual([...sub.seqs].sort((a, b) => a - b));
      expect(new Set(sub.seqs).size).toBe(sub.seqs.length); // exactly once
      expect(sub.cursor).toBe(head); // caught up: nothing missed
    }
    // the database was read far less often than the subscribers polled
    const dbReads = txSpy.mock.calls.length;
    expect(reads).toBeGreaterThan(1000);
    expect(dbReads).toBeLessThan(reads / 4);
    txSpy.mockRestore();
  }, 60_000);

  it("a subscriber from another tenant never gets the cached window: its first read is refused", async () => {
    await expect(k.stream.read(outsider, ws, 0, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // and a non-first read from the outsider does not hit the other tenant's cache entry (keyed by org)
    await k.stream.read(s, ws, 0, true);
    await expect(k.stream.read(outsider, ws, 0, false)).rejects.toBeDefined();
  });
});
