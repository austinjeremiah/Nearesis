import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiFixture, bearer, login, sansTrace, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

let f: ApiFixture;
let tokA: string;
let tokB: string;
let wsA: string;
let wsB: string;
let ruleA: string;
const srcA = `wm-a-${randomUUID().slice(0, 8)}`;
const srcB = `wm-b-${randomUUID().slice(0, 8)}`;

async function mkWorkspace(token: string, key: string) {
  const r = await f.app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { ...bearer(token), "idempotency-key": key },
    payload: { objective: "o", networkScope: "fixture-only" },
  });
  return r.json<{ workspaceId: string }>().workspaceId;
}
async function mkRule(token: string, ws: string, sourceId: string): Promise<string> {
  const w = await f.app.inject({ method: "GET", url: `/v1/workspaces/${ws}`, headers: bearer(token) });
  const r = await f.app.inject({
    method: "POST",
    url: `/v1/workspaces/${ws}/commands`,
    headers: bearer(token),
    payload: {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "monitor.rule_create",
      payload: { name: "r", sourceId, condition: { kind: "compare", metricId: "v", op: "gt", value: 1 } },
      expectedVersion: w.json<{ version: number }>().version,
    },
  });
  expect(r.statusCode).toBe(200);
  const rules = (
    await f.app.inject({ method: "GET", url: `/v1/workspaces/${ws}/monitors`, headers: bearer(token) })
  ).json<{ rules: Array<{ ruleId: string }> }>().rules;
  return rules[0]!.ruleId;
}

beforeAll(async () => {
  f = await apiFixture({ runtime: true });
  const a = await seedOrg(f.db.admin, "mr-a", { alice: "owner" });
  const b = await seedOrg(f.db.admin, "mr-b", { bob: "owner" });
  tokA = await login(f.app, a.users.alice!.subject);
  tokB = await login(f.app, b.users.bob!.subject);
  wsA = await mkWorkspace(tokA, "mr-ws-a-0001");
  wsB = await mkWorkspace(tokB, "mr-ws-b-0001");
  ruleA = await mkRule(tokA, wsA, srcA);
  await mkRule(tokB, wsB, srcB);
  const ins = (src: string, wm: string, mode: string, maturity = "final") =>
    f.db.admin.query(
      "INSERT INTO source_watermark_events(source_id, watermark, mode, values_json, maturity) VALUES ($1,$2,$3,'{\"v\":2}',$4)",
      [src, wm, mode, maturity],
    );
  await ins(srcA, "2026-11-10T00:00:00Z", "live");
  await ins(srcA, "2026-11-11T00:00:00Z", "live", "provisional");
  await ins(srcA, "2026-11-09T00:00:00Z", "replay");
  await ins(srcB, "2026-11-11T00:00:00Z", "live");
  const org = (await f.db.admin.query("SELECT org_id FROM workspaces WHERE id = $1", [wsA])).rows[0].org_id;
  await f.db.admin.query(
    `INSERT INTO monitor_evaluations(id, org_id, workspace_id, rule_id, rule_version, source_id, watermark, mode, status)
     VALUES ($1,$2,$3,$4,1,$5,'2026-11-10T00:00:00Z','live','condition_false')`,
    [randomUUID(), org, wsA, ruleA, srcA],
  );
});
afterAll(async () => f?.close());

const get = (url: string, token?: string) =>
  f.app.inject({ method: "GET", url, ...(token ? { headers: bearer(token) } : {}) });

describe("monitor watermark and evaluation reads", () => {
  it("returns the newest watermark per (source, mode) for the workspace's own rule sources only", async () => {
    const r = await get(`/v1/workspaces/${wsA}/monitors/watermarks`, tokA);
    expect(r.statusCode).toBe(200);
    const rows = r.json<{ watermarks: Array<{ sourceId: string; mode: string; watermark: string }> }>()
      .watermarks;
    expect(rows.map((x) => [x.sourceId, x.mode, x.watermark])).toEqual([
      [srcA, "live", "2026-11-11T00:00:00.000Z"],
      [srcA, "replay", "2026-11-09T00:00:00.000Z"],
    ]);
    expect(rows[0]).toMatchObject({ maturity: "provisional", values: { v: 2 } });
    expect(rows.some((x) => x.sourceId === srcB)).toBe(false);
    const b = await get(`/v1/workspaces/${wsB}/monitors/watermarks`, tokB);
    expect(b.json<{ watermarks: Array<{ sourceId: string }> }>().watermarks.map((x) => x.sourceId)).toEqual([
      srcB,
    ]);
  });

  it("foreign, unknown and unauthenticated callers cannot read watermarks or evaluations", async () => {
    for (const path of ["monitors/watermarks", "monitors/evaluations"]) {
      const foreign = await get(`/v1/workspaces/${wsA}/${path}`, tokB);
      const unknown = await get(`/v1/workspaces/${randomUUID()}/${path}`, tokB);
      expect(foreign.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
      expect((await get(`/v1/workspaces/${wsA}/${path}`)).statusCode).toBe(401);
      expect((await get(`/v1/workspaces/not-a-uuid/${path}`, tokA)).statusCode).toBe(404);
    }
  });

  it("evaluations are workspace-scoped and can be filtered by rule", async () => {
    const own = await get(`/v1/workspaces/${wsA}/monitors/evaluations`, tokA);
    expect(own.json<{ evaluations: Array<{ ruleId: string }> }>().evaluations.map((e) => e.ruleId)).toEqual([
      ruleA,
    ]);
    const filtered = await get(`/v1/workspaces/${wsA}/monitors/evaluations?ruleId=${ruleA}`, tokA);
    expect(filtered.json<{ evaluations: unknown[] }>().evaluations).toHaveLength(1);
    const other = await get(`/v1/workspaces/${wsA}/monitors/evaluations?ruleId=${randomUUID()}`, tokA);
    expect(other.json<{ evaluations: unknown[] }>().evaluations).toHaveLength(0);
    expect((await get(`/v1/workspaces/${wsA}/monitors/evaluations?ruleId=x`, tokA)).statusCode).toBe(404);
    const b = await get(`/v1/workspaces/${wsB}/monitors/evaluations`, tokB);
    expect(b.json<{ evaluations: unknown[] }>().evaluations).toHaveLength(0);
  });
});
