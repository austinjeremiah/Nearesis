import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedOrg, testKernel } from "@nearesis/kernel/testing";
import type { TestDb } from "@nearesis/kernel/testing";
import { DevAuthProvider, Kernel } from "@nearesis/kernel";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";

const SECRET = "test-session-secret-0123456789abcdef";
type KernelCtor = new (c: ConstructorParameters<typeof Kernel>[0]) => Kernel;

let db: TestDb;
let app: FastifyInstance;
let base: string;
let wsId: string;
let shortTok: string;
let revokedTok: string;
let longTok: string;
let revokedUserId: string;
let outsiderTok: string;

/** Reads the stream until it ends or `deadlineMs` passes; reports whether the server closed it. */
async function drain(token: string, deadlineMs: number, stopOn?: (events: string[]) => boolean) {
  const ac = new AbortController();
  const res = await fetch(`${base}/v1/workspaces/${wsId}/events`, {
    headers: { authorization: `Bearer ${token}` },
    signal: ac.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: string[] = [];
  const data: Array<Record<string, unknown>> = [];
  let ended = false;
  const deadline = Date.now() + deadlineMs;
  const timer = setTimeout(() => ac.abort(), deadlineMs);
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(raw)?.[1];
        const d = /^data: (.*)$/m.exec(raw)?.[1];
        if (ev) {
          events.push(ev);
          data.push(d ? (JSON.parse(d) as Record<string, unknown>) : {});
        }
      }
      if (stopOn?.(events)) break;
    }
  } catch {
    /* aborted at the deadline */
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return { events, data, ended };
}

beforeAll(async () => {
  db = await createTestDb();
  const k0 = testKernel(db);
  const kernel = new (k0.constructor as KernelCtor)({
    db: db.app,
    plugins: k0.plugins.config,
    sessionSecret: SECRET,
    nodeEnv: "test",
  });
  app = await buildApp({ kernel, nodeEnv: "test", ssePollMs: 30, sseAuthRecheckMs: 150 });
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const a = await seedOrg(db.admin, "sse-sess", { alice: "owner", rev: "analyst" });
  const b = await seedOrg(db.admin, "sse-sess-b", { bob: "owner" });
  const aliceTok = await kernel.devAuth!.login(a.users.alice!.subject);
  longTok = aliceTok;
  revokedTok = await kernel.devAuth!.login(a.users.rev!.subject);
  revokedUserId = a.users.rev!.userId;
  outsiderTok = await kernel.devAuth!.login(b.users.bob!.subject);
  shortTok = await new DevAuthProvider(db.app, SECRET, "test", 2).login(a.users.alice!.subject);
  const w = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { authorization: `Bearer ${aliceTok}`, "idempotency-key": "sse-sess-ws-0001" },
    payload: { objective: "o", networkScope: "fixture-only" },
  });
  wsId = w.json<{ workspaceId: string }>().workspaceId;
});
afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe("SSE session lifetime", () => {
  it("closes an open stream with a session_expired event once the token lapses", async () => {
    const started = Date.now();
    const r = await drain(shortTok, 15_000, (e) => e.includes("session_expired"));
    expect(r.events).toContain("workspace.created");
    const i = r.events.indexOf("session_expired");
    expect(i).toBeGreaterThan(0);
    expect(r.data[i]).toMatchObject({ reason: "TOKEN_EXPIRED" });
    // never before the token's own `exp` (JWT expiry is whole seconds)
    const exp = JSON.parse(Buffer.from(shortTok.split(".")[1]!, "base64url").toString()).exp as number;
    expect(Date.now()).toBeGreaterThanOrEqual(exp * 1000);
    expect(Date.now() - started).toBeLessThan(10_000);
    // the server ends the stream after the event
    const again = await fetch(`${base}/v1/workspaces/${wsId}/events`, {
      headers: { authorization: `Bearer ${shortTok}` },
    });
    expect(again.status).toBe(401); // a lapsed token cannot reconnect
    await again.body?.cancel();
  }, 30_000);

  it("closes the stream when the membership behind the session is revoked", async () => {
    const probe = await fetch(`${base}/v1/workspaces/${wsId}/events`, {
      headers: { authorization: `Bearer ${revokedTok}` },
    });
    expect(probe.status).toBe(200); // the member can read before revocation
    await probe.body?.cancel();
    const pending = drain(revokedTok, 15_000, (e) => e.includes("session_expired"));
    await new Promise((r) => setTimeout(r, 400));
    await db.admin.query("DELETE FROM memberships WHERE user_id = $1", [revokedUserId]);
    const r = await pending;
    const i = r.events.indexOf("session_expired");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(r.data[i]).toMatchObject({ reason: "SESSION_REVOKED" });
  }, 30_000);

  it("a valid session keeps streaming across several re-checks, and outsiders are still 404", async () => {
    const r = await drain(longTok, 1200);
    expect(r.events).not.toContain("session_expired");
    expect(r.ended).toBe(false);
    const res = await fetch(`${base}/v1/workspaces/${wsId}/events`, {
      headers: { authorization: `Bearer ${outsiderTok}` },
    });
    expect(res.status).toBe(404);
    await res.body?.cancel();
  }, 20_000);
});
