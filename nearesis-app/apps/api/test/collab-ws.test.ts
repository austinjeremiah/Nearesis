import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

// Yjs updates generated once with yjs 13.6.33.
const N1 = "AQGx6JtzACgBBmxheW91dAJuMQF2AgF4fQMBeX0EAA=="; // layout.n1 = {x:3,y:4}
const N2 = "AQGm/q7jDQAoAQZsYXlvdXQCbjIBdgIBeH0HAXl9CQA="; // layout.n2 = {x:7,y:9}
const EVIL_ROOT = "AQGdtaLWDQAoARRldmlkZW5jZV9hdHRhY2htZW50cwFhAXYBBm5vZGVJZHcBeAA="; // foreign root
const POLICY_KEY = "AQHi3KymDwAoAQZsYXlvdXQNYWNjZXNzX3BvbGljeQF2AQRyb2xldwVhZG1pbgA="; // layout.access_policy

let f: ApiFixture;
let base: string;
let ws: string;
let ownerTok: string;
let analystTok: string;
let viewerTok: string;
let outsiderTok: string;
let revokeTok: string;
let revokeUser: string;
let orgId: string;

beforeAll(async () => {
  f = await apiFixture();
  const a = await seedOrg(f.db.admin, "cw", {
    alice: "owner",
    ann: "analyst",
    vic: "viewer",
    rex: "analyst",
  });
  const b = await seedOrg(f.db.admin, "cw2", { bob: "owner" });
  orgId = a.orgId;
  ownerTok = await login(f.app, a.users.alice!.subject);
  analystTok = await login(f.app, a.users.ann!.subject);
  viewerTok = await login(f.app, a.users.vic!.subject);
  revokeTok = await login(f.app, a.users.rex!.subject);
  revokeUser = a.users.rex!.userId;
  outsiderTok = await login(f.app, b.users.bob!.subject);
  ws = (
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(ownerTok), "idempotency-key": "create-cw-0001" },
        payload: { objective: "o", networkScope: "fixture-only" },
      })
    ).json() as { workspaceId: string }
  ).workspaceId;
  await f.app.listen({ port: 0, host: "127.0.0.1" });
  base = `ws://127.0.0.1:${(f.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => f?.close());

interface Client {
  sock: WebSocket;
  msgs: Array<Record<string, unknown>>;
  closed: Promise<{ code: number; at: number }>;
  next(type: string, ms?: number): Promise<Record<string, unknown>>;
  send(o: unknown): void;
}
function open(workspace: string, scope: string, token: string | null): Promise<Client> {
  const sock = new WebSocket(
    `${base}/v1/workspaces/${workspace}/collab/${scope}/ws`,
    token ? [`nearesis.bearer.${token}`] : [],
  );
  const msgs: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  sock.onmessage = (e) => {
    msgs.push(JSON.parse(String(e.data)) as Record<string, unknown>);
    for (const w of waiters.splice(0)) w();
  };
  const closed = new Promise<{ code: number; at: number }>((res) => {
    sock.onclose = (e) => res({ code: e.code, at: Date.now() });
  });
  const client: Client = {
    sock,
    msgs,
    closed,
    send: (o) => sock.send(JSON.stringify(o)),
    next: (type, ms = 5000) =>
      new Promise((res, rej) => {
        const t = setTimeout(
          () => rej(new Error(`timeout waiting for ${type}; got ${JSON.stringify(msgs)}`)),
          ms,
        );
        const check = () => {
          const i = msgs.findIndex((m) => m.type === type);
          if (i >= 0) {
            clearTimeout(t);
            res(msgs.splice(i, 1)[0]!);
          } else waiters.push(check);
        };
        check();
      }),
  };
  return new Promise((res, rej) => {
    sock.onopen = () => res(client);
    sock.onerror = () => rej(new Error("upgrade refused"));
  });
}
const state = async (tok: string) =>
  (
    await f.app.inject({
      method: "GET",
      url: `/v1/workspaces/${ws}/collab/layout/state`,
      headers: bearer(tok),
    })
  ).json() as { decoded: Record<string, unknown>; cursor: number };

describe("Yjs over WebSocket", () => {
  it("authenticates the upgrade; foreign, unknown and anonymous peers are refused before any frame", async () => {
    await expect(open(ws, "layout", null)).rejects.toThrow();
    await expect(open(ws, "layout", outsiderTok)).rejects.toThrow();
    await expect(open("11111111-1111-4111-8111-111111111111", "layout", ownerTok)).rejects.toThrow();
    await expect(open(ws, "evidence", ownerTok)).rejects.toThrow(); // only layout and notes rooms exist
    await expect(open(ws, "layout", "not-a-token")).rejects.toThrow();
  });

  it("members edit live: update acked, persisted, broadcast to the other member and restored for a late joiner", async () => {
    const a = await open(ws, "layout", ownerTok);
    const b = await open(ws, "layout", analystTok);
    expect((await a.next("sync")).cursor).toBeDefined();
    await b.next("sync");
    a.send({ type: "update", update: N1 });
    expect(typeof (await a.next("ack")).cursor).toBe("number");
    const got = await b.next("update");
    expect(got.update).toBe(N1);
    expect((await state(ownerTok)).decoded).toEqual({ n1: { x: 3, y: 4 } }); // durable: read over REST
    b.send({ type: "update", update: N2 });
    await b.next("ack");
    expect((await a.next("update")).update).toBe(N2);
    a.sock.close();
    b.sock.close();
    await Promise.all([a.closed, b.closed]);
    const late = await open(ws, "layout", ownerTok);
    const sync = await late.next("sync");
    expect(typeof sync.update).toBe("string");
    expect((await state(ownerTok)).decoded).toEqual({ n1: { x: 3, y: 4 }, n2: { x: 7, y: 9 } });
    late.sock.close();
  });

  it("a viewer can read but every write is refused; crafted updates cannot touch other roots or policy keys", async () => {
    const v = await open(ws, "layout", viewerTok);
    await v.next("sync");
    v.send({ type: "update", update: N1 });
    expect((await v.next("error")).code).toBe("FORBIDDEN");
    const o = await open(ws, "layout", ownerTok);
    await o.next("sync");
    for (const crafted of [EVIL_ROOT, POLICY_KEY]) {
      o.send({ type: "update", update: crafted });
      expect((await o.next("error")).code).toBe("VALIDATION_FAILED");
    }
    o.send({ type: "update", update: "%%%not-base64-yjs" });
    expect((await o.next("error")).code).toBe("VALIDATION_FAILED");
    o.send({ type: "nonsense" });
    expect((await o.next("error")).reasonCode).toBe("UNKNOWN_FRAME");
    expect((await state(ownerTok)).decoded).toEqual({ n1: { x: 3, y: 4 }, n2: { x: 7, y: 9 } });
    // malformed JSON closes with the protocol close code
    o.sock.send("{not json");
    expect((await o.closed).code).toBe(4400);
    v.sock.close();
  });

  it("presence is ephemeral and delivered to peers of the same room only", async () => {
    const a = await open(ws, "layout", ownerTok);
    const b = await open(ws, "layout", analystTok);
    await a.next("sync");
    await b.next("sync");
    a.send({ type: "presence", state: { cursor: { x: 1, y: 2 } } });
    await a.next("ack");
    const p = await b.next("presence");
    expect(JSON.stringify(p.peers)).toContain('"x":1');
    a.sock.close();
    b.sock.close();
    await Promise.all([a.closed, b.closed]);
    const c = await f.app.inject({
      method: "GET",
      url: `/v1/workspaces/${ws}/collab/layout/presence`,
      headers: bearer(ownerTok),
    });
    expect((c.json() as { peers: unknown[] }).peers).toEqual([]);
  });

  it("closes a revoked member's socket with 4403 within the declared interval and delivers nothing after", async () => {
    const r = await open(ws, "layout", revokeTok);
    const o = await open(ws, "layout", ownerTok);
    await r.next("sync");
    await o.next("sync");
    const t0 = Date.now();
    await f.db.admin.query("DELETE FROM memberships WHERE org_id=$1 AND user_id=$2", [orgId, revokeUser]);
    const c = await r.closed;
    expect(c.code).toBe(4403);
    expect(c.at - t0).toBeLessThan(2_500);
    o.send({ type: "update", update: N1 });
    await o.next("ack");
    expect(r.msgs.filter((m) => m.type === "update")).toEqual([]);
    o.sock.close();
  });
});
