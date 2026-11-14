import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

let f: ApiFixture;
let tokA: string;
let tokB: string;
let tokV: string;
let ws: string;
let wsB: string;
let ruleId: string;
const calls: Array<{ ids: string[]; day: string }> = [];
const day = (n: number) => new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - n * 86_400_000);
const iso = (n: number) => day(n).toISOString().slice(0, 10);
const sourceId = `rr-${randomUUID().slice(0, 8)}`;

async function cmd(token: string, workspace: string, commandType: string, payload: Record<string, unknown>) {
  const w = await f.app.inject({ method: "GET", url: `/v1/workspaces/${workspace}`, headers: bearer(token) });
  return f.app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspace}/commands`,
    headers: bearer(token),
    payload: {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType,
      payload,
      expectedVersion: (w.json() as { version: number }).version,
    },
  });
}
beforeAll(async () => {
  f = await apiFixture({
    runtime: true,
    appOptions: {
      monitorReplayValues: async (ids, d): Promise<Record<string, number>> => {
        calls.push({ ids, day: d });
        // recorded values: 9 on the older day, 1 on the newer, nothing for a third (honest gap)
        const v = d.slice(0, 10) === iso(3) ? 9 : d.slice(0, 10) === iso(2) ? 1 : null;
        return v === null ? {} : { v };
      },
    },
  });
  const a = await seedOrg(f.db.admin, "rr", { alice: "owner", vic: "viewer" });
  const b = await seedOrg(f.db.admin, "rr-b", { bob: "owner" });
  tokA = await login(f.app, a.users.alice!.subject);
  tokV = await login(f.app, a.users.vic!.subject);
  tokB = await login(f.app, b.users.bob!.subject);
  const mk = async (tok: string, key: string) =>
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(tok), "idempotency-key": key },
        payload: { objective: "o", networkScope: "fixture-only" },
      })
    ).json<{ workspaceId: string }>().workspaceId;
  ws = await mk(tokA, "rr-ws-0000001");
  wsB = await mk(tokB, "rr-ws-0000002");
  expect(
    (
      await cmd(tokB, wsB, "monitor.rule_create", {
        name: "other",
        sourceId,
        condition: { kind: "compare", metricId: "v", op: "gt", value: 1 },
      })
    ).statusCode,
  ).toBe(200);
  const c = await cmd(tokA, ws, "monitor.rule_create", {
    name: "mine",
    sourceId,
    condition: { kind: "compare", metricId: "v", op: "gt", value: 5 },
  });
  expect(c.statusCode).toBe(200);
  ruleId = (
    await f.app.inject({ method: "GET", url: `/v1/workspaces/${ws}/monitors`, headers: bearer(tokA) })
  ).json<{
    rules: Array<{ ruleId: string }>;
  }>().rules[0]!.ruleId;
}, 60_000);
afterAll(async () => f?.close());

const replay = (tok: string, body: unknown, w = ws, r = ruleId) =>
  f.app.inject({
    method: "POST",
    url: `/v1/workspaces/${w}/monitors/${r}/replay`,
    headers: bearer(tok),
    payload: body as object,
  });

describe("POST /v1/workspaces/:id/monitors/:ruleId/replay", () => {
  it("replays one rule over recorded daily values, labelled replay, with honest gaps and no live records", async () => {
    const res = await replay(tokA, { from: iso(3), to: iso(1) });
    expect(res.statusCode, res.body).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({ mode: "replay", ruleId, fired: 1, window: { days: 3 } });
    expect(b.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      "fired",
      "condition_false",
      "no_data",
    ]);
    expect(b.results[2].missing).toEqual(["v"]);
    expect(calls.every((c) => c.ids.join() === "v")).toBe(true);
    const trig = await f.db.admin.query("SELECT DISTINCT mode FROM monitor_triggers WHERE rule_id=$1", [
      ruleId,
    ]);
    expect(trig.rows).toEqual([{ mode: "replay" }]);
    const notifs = await f.db.admin.query("SELECT DISTINCT mode FROM notifications WHERE workspace_id=$1", [
      ws,
    ]);
    expect(notifs.rows).toEqual([{ mode: "replay" }]);
    expect(
      (await f.db.admin.query("SELECT count(*)::int n FROM monitor_triggers WHERE workspace_id=$1", [wsB]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (
        await f.db.admin.query("SELECT count(*)::int n FROM source_watermark_events WHERE source_id=$1", [
          sourceId,
        ])
      ).rows[0].n,
    ).toBe(0);
    // re-run is idempotent
    const again = (await replay(tokA, { from: iso(3), to: iso(1) })).json();
    expect(again.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
    ]);
  });
  it("validates the window and the actor", async () => {
    expect((await replay(tokA, { from: iso(1), to: iso(3) })).statusCode).toBe(422);
    expect((await replay(tokA, { from: iso(1), to: iso(0) })).statusCode).toBe(422);
    expect((await replay(tokA, { from: iso(200), to: iso(1) })).statusCode).toBe(422);
    expect((await replay(tokA, { from: "x" })).statusCode).toBe(422);
    expect((await replay(tokV, { from: iso(3), to: iso(2) })).statusCode).toBe(403);
  });
  it("hides foreign and unknown rules behind the same 404", async () => {
    expect((await replay(tokB, { from: iso(3), to: iso(2) })).statusCode).toBe(404);
    expect((await replay(tokA, { from: iso(3), to: iso(2) }, ws, randomUUID())).statusCode).toBe(404);
    expect((await replay(tokA, { from: iso(3), to: iso(2) }, ws, "nope")).statusCode).toBe(404);
  });
});
