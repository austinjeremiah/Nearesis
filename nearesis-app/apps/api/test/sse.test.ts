import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, loginSession, seedOrg, testKernel } from "@nearesis/kernel/testing";
import type { TestDb } from "@nearesis/kernel/testing";
import type { Kernel, Session } from "@nearesis/kernel";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";

interface Frame {
  id: string | null;
  event: string;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Minimal SSE client: reads frames until `until` says stop (or the stream ends). */
async function sse(
  base: string,
  path: string,
  token: string,
  opts: { lastEventId?: string; until: (f: Frame[]) => boolean; pauseMs?: number; pauseAfter?: number },
): Promise<{ frames: Frame[]; status: number }> {
  const ac = new AbortController();
  const res = await fetch(base + path, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.lastEventId ? { "last-event-id": opts.lastEventId } : {}),
    },
    signal: ac.signal,
  });
  const frames: Frame[] = [];
  if (res.status !== 200) {
    await res.body?.cancel();
    return { frames, status: res.status };
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (raw.startsWith(":")) continue;
        const f: Frame = { id: null, event: "message", data: {} };
        for (const line of raw.split("\n")) {
          if (line.startsWith("id: ")) f.id = line.slice(4);
          else if (line.startsWith("event: ")) f.event = line.slice(7);
          else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
        }
        frames.push(f);
        if (opts.pauseMs && frames.length === opts.pauseAfter)
          await new Promise((r) => setTimeout(r, opts.pauseMs));
      }
      if (opts.until(frames)) break;
    }
  } finally {
    ac.abort();
  }
  return { frames, status: 200 };
}

type KernelCtor = new (c: ConstructorParameters<typeof Kernel>[0]) => Kernel;

let db: TestDb;
let kernel: Kernel;
let app: FastifyInstance;
let base: string;
let alice: Session;
let aliceTok: string;
let bobTok: string;
let wsId: string;

beforeAll(async () => {
  db = await createTestDb();
  kernel = testKernel(db);
  app = await buildApp({ kernel, nodeEnv: "test", ssePollMs: 30 });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const a = await seedOrg(db.admin, "sse", { alice: "owner" });
  const b = await seedOrg(db.admin, "sse2", { bob: "owner" });
  alice = await loginSession(kernel, a.users.alice!.subject);
  aliceTok = await kernel.devAuth!.login(a.users.alice!.subject);
  bobTok = await kernel.devAuth!.login(b.users.bob!.subject);
  const w = await kernel.workspaces.create(alice, {
    objective: "o",
    networkScope: "fixture-only",
    idempotencyKey: "sse-create-1",
  });
  wsId = w.workspaceId;
  for (let v = 1; v < 30; v++) {
    await kernel.commands.execute(alice, wsId, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "workspace.update_objective",
      payload: { objective: `o${v}` },
      expectedVersion: v,
    });
  }
});
afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe("SSE /v1/workspaces/:id/events", () => {
  it("streams all committed events in order, then live ones", async () => {
    const p = sse(base, `/v1/workspaces/${wsId}/events`, aliceTok, { until: (f) => f.length >= 31 });
    await new Promise((r) => setTimeout(r, 200));
    await kernel.commands.execute(alice, wsId, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "workspace.update_objective",
      payload: { objective: "live" },
      expectedVersion: 30,
    });
    const { frames, status } = await p;
    expect(status).toBe(200);
    expect(frames.map((f) => Number(f.id))).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(frames[0]!.event).toBe("workspace.created");
    expect(frames[30]!.data.data.objective).toBe("live");
  });

  it("reconnects with Last-Event-ID and receives only later events, once", async () => {
    const { frames } = await sse(base, `/v1/workspaces/${wsId}/events`, aliceTok, {
      lastEventId: "20",
      until: (f) => f.length >= 11,
    });
    expect(frames.map((f) => Number(f.id))).toEqual(Array.from({ length: 11 }, (_, i) => i + 21));
  });

  it("expired or invalid cursor => reload_required with current revision", async () => {
    const k2 = testKernel(db);
    const app2 = await buildApp({
      kernel: new (k2.constructor as KernelCtor)({
        db: db.app,
        plugins: k2.plugins.config,
        sessionSecret: "test-session-secret-0123456789abcdef",
        nodeEnv: "test",
        stream: { retainEvents: 5 },
      }),
      nodeEnv: "test",
      ssePollMs: 30,
    });
    // sessions are signed with the secret above, so reuse the same token
    await app2.listen({ host: "127.0.0.1", port: 0 });
    const b2 = `http://127.0.0.1:${(app2.server.address() as { port: number }).port}`;
    const { frames } = await sse(b2, `/v1/workspaces/${wsId}/events`, aliceTok, {
      lastEventId: "3",
      until: (f) => f.length >= 1,
    });
    expect(frames[0]!.event).toBe("reload_required");
    expect(frames[0]!.data).toMatchObject({ reason: "CURSOR_EXPIRED", currentSeq: 31, workspaceVersion: 31 });
    const bad = await sse(b2, `/v1/workspaces/${wsId}/events`, aliceTok, {
      lastEventId: "9999",
      until: (f) => f.length >= 1,
    });
    expect(bad.frames[0]!.event).toBe("reload_required");
    const junk = await sse(b2, `/v1/workspaces/${wsId}/events`, aliceTok, {
      lastEventId: "abc",
      until: (f) => f.length >= 1,
    });
    expect(junk.frames[0]!.data.reason).toBe("INVALID_CURSOR");
    await app2.close();
  });

  it("a lagging subscriber gets one coalesced aggregate instead of the backlog", async () => {
    const k2 = testKernel(db);
    const app2 = await buildApp({
      kernel: new (k2.constructor as KernelCtor)({
        db: db.app,
        plugins: k2.plugins.config,
        sessionSecret: "test-session-secret-0123456789abcdef",
        nodeEnv: "test",
        stream: { maxLag: 10, batch: 5 },
      }),
      nodeEnv: "test",
      ssePollMs: 30,
    });
    await app2.listen({ host: "127.0.0.1", port: 0 });
    const b2 = `http://127.0.0.1:${(app2.server.address() as { port: number }).port}`;
    const { frames } = await sse(b2, `/v1/workspaces/${wsId}/events`, aliceTok, {
      lastEventId: "2",
      until: (f) => f.length >= 1,
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe("coalesced");
    expect(frames[0]!.id).toBe("31");
    expect(frames[0]!.data).toMatchObject({ fromSeq: 3, toSeq: 31, count: 29, workspaceVersion: 31 });
    expect(frames[0]!.data.byType["workspace.updated"]).toBe(29);
    await app2.close();
  });

  it("outsiders and anonymous callers cannot subscribe", async () => {
    expect((await sse(base, `/v1/workspaces/${wsId}/events`, bobTok, { until: () => true })).status).toBe(
      404,
    );
    expect(
      (await sse(base, `/v1/workspaces/${randomUUID()}/events`, bobTok, { until: () => true })).status,
    ).toBe(404);
    expect((await sse(base, `/v1/workspaces/${wsId}/events`, "bad", { until: () => true })).status).toBe(401);
  });
});
