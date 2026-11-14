import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

let f: ApiFixture;
let alice: string;
let ana: string;
let bob: string;
let ws: string;
let ws2: string;
let wsB: string;
const ids: string[] = [];
let foreignId = "";
const get = (tok: string, url: string) => f.app.inject({ method: "GET", url, headers: bearer(tok) });
const post = (tok: string, url: string, payload: unknown) =>
  f.app.inject({ method: "POST", url, headers: bearer(tok), payload: payload as object });
const unread = async (tok: string) => (await get(tok, "/v1/notifications")).json<{ unread: number }>().unread;

async function rule(tok: string, workspace: string) {
  const w = (await get(tok, `/v1/workspaces/${workspace}`)).json<{ version: number }>();
  const r = await post(tok, `/v1/workspaces/${workspace}/commands`, {
    apiVersion: "v1",
    commandId: randomUUID(),
    commandType: "monitor.rule_create",
    payload: {
      name: "r",
      sourceId: `s-${randomUUID().slice(0, 8)}`,
      condition: { kind: "compare", metricId: "v", op: "gt", value: 1 },
    },
    expectedVersion: w.version,
  });
  expect(r.statusCode).toBe(200);
  return (await get(tok, `/v1/workspaces/${workspace}/monitors`)).json<{ rules: Array<{ ruleId: string }> }>()
    .rules[0]!.ruleId;
}
beforeAll(async () => {
  f = await apiFixture({ runtime: true });
  const a = await seedOrg(f.db.admin, "nr", { alice: "owner", ana: "analyst" });
  const b = await seedOrg(f.db.admin, "nr-b", { bob: "owner" });
  alice = await login(f.app, a.users.alice!.subject);
  ana = await login(f.app, a.users.ana!.subject);
  bob = await login(f.app, b.users.bob!.subject);
  const mk = async (tok: string, key: string) =>
    (
      await post(tok, "/v1/workspaces", { objective: "o", networkScope: "fixture-only", idempotencyKey: key })
    ).json<{ workspaceId: string }>().workspaceId;
  ws = await mk(alice, "nr-ws-00000001");
  ws2 = await mk(alice, "nr-ws-00000002");
  wsB = await mk(bob, "nr-ws-00000003");
  const ins = async (orgId: string, workspace: string, ruleId: string) => {
    const id = randomUUID();
    await f.db.admin.query(
      `INSERT INTO notifications(id, org_id, workspace_id, rule_id, trigger_id, mode, title, body) VALUES ($1,$2,$3,$4,$5,'live','t','b')`,
      [id, orgId, workspace, ruleId, randomUUID()],
    );
    return id;
  };
  const rA = await rule(alice, ws);
  const rA2 = await rule(alice, ws2);
  const rB = await rule(bob, wsB);
  ids.push(await ins(a.orgId, ws, rA), await ins(a.orgId, ws, rA), await ins(a.orgId, ws2, rA2));
  const bOrg = (await f.db.admin.query("SELECT org_id FROM workspaces WHERE id=$1", [wsB])).rows[0]
    .org_id as string;
  foreignId = await ins(bOrg, wsB, rB);
}, 60_000);
afterAll(async () => f?.close());

describe("notification mark-read", () => {
  it("marks by id for the caller only; counts stay consistent with GET /v1/notifications", async () => {
    expect(await unread(alice)).toBe(3);
    expect(await unread(ana)).toBe(3);
    const r = await post(alice, "/v1/notifications/read", { ids: [ids[0]!] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ marked: [ids[0]], alreadyRead: 0, notFound: [], unread: 2 });
    expect(await unread(alice)).toBe(2);
    expect(await unread(ana)).toBe(3); // per user
    const again = (await post(alice, "/v1/notifications/read", { ids: [ids[0]!] })).json();
    expect(again).toMatchObject({ marked: [], alreadyRead: 1, unread: 2 });
    const list = (await get(alice, "/v1/notifications?unread=1")).json<{ notifications: unknown[] }>();
    expect(list.notifications).toHaveLength(2);
  });
  it("marks all, and the per-workspace route only touches that workspace", async () => {
    const w = await post(ana, `/v1/workspaces/${ws2}/notifications/read`, { all: true });
    expect(w.json()).toMatchObject({ marked: [ids[2]], unread: 0 });
    expect(await unread(ana)).toBe(2);
    expect((await post(alice, "/v1/notifications/read", { all: true })).json()).toMatchObject({ unread: 0 });
    expect(await unread(alice)).toBe(0);
  });
  it("is tenant-safe: foreign ids are notFound, foreign workspaces 404, and nothing leaks across orgs", async () => {
    const r = await post(alice, "/v1/notifications/read", { ids: [foreignId] });
    expect(r.json()).toMatchObject({ marked: [], notFound: [foreignId] });
    expect(await unread(bob)).toBe(1);
    expect((await post(alice, `/v1/workspaces/${wsB}/notifications/read`, { all: true })).statusCode).toBe(
      404,
    );
    expect(
      (await post(alice, `/v1/workspaces/${randomUUID()}/notifications/read`, { all: true })).statusCode,
    ).toBe(404);
    expect((await post(bob, "/v1/notifications/read", { all: true })).json()).toMatchObject({ unread: 0 });
    const rows = await f.db.admin.query(
      "SELECT count(*)::int n FROM notification_reads r JOIN notifications n ON n.id=r.notification_id WHERE r.org_id <> n.org_id",
    );
    expect(rows.rows[0].n).toBe(0);
  });
  it("validates the body and requires a session", async () => {
    expect((await post(alice, "/v1/notifications/read", {})).statusCode).toBe(422);
    expect((await post(alice, "/v1/notifications/read", { ids: ["x"] })).statusCode).toBe(422);
    expect(
      (await f.app.inject({ method: "POST", url: "/v1/notifications/read", payload: { all: true } }))
        .statusCode,
    ).toBe(401);
  });
});
