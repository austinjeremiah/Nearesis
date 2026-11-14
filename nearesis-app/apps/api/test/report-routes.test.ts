/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiFixture, bearer, login, sansTrace, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";
import { describePanel, findingHashes, questionOf, usd6 } from "../src/report-routes.ts";

let f: ApiFixture;
let owner: string;
let viewer: string;
let other: string;
let wsA: string;
let wsB: string;

const get = (tok: string, url: string) =>
  f.app.inject({ method: "GET", url, headers: tok ? bearer(tok) : {} });
const mkWs = async (tok: string, key: string) =>
  (
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(tok), "idempotency-key": key },
        payload: { objective: "Is demand durable?", networkScope: "fixture-only" },
      })
    ).json() as { workspaceId: string }
  ).workspaceId;

beforeAll(async () => {
  f = await apiFixture({ runtime: true });
  const a = await seedOrg(f.db.admin, "orga", { owner: "owner", viewer: "viewer" });
  const b = await seedOrg(f.db.admin, "orgb", { admin: "admin" });
  owner = await login(f.app, a.users.owner!.subject);
  viewer = await login(f.app, a.users.viewer!.subject);
  other = await login(f.app, b.users.admin!.subject);
  wsA = await mkWs(owner, "report-ws-a-0001");
  wsB = await mkWs(other, "report-ws-b-0001");
});
afterAll(async () => {
  await f.close();
});

describe("GET /v1/workspaces/:id/report", () => {
  it("an empty workspace returns the full document shape with empty lists and unknowns as null", async () => {
    const r = await get(owner, `/v1/workspaces/${wsA}/report`);
    expect(r.statusCode).toBe(200);
    const b = r.json() as any;
    expect(Object.keys(b).sort()).toEqual(
      ["capsules", "costs", "generatedAt", "hypotheses", "limitations", "markers", "monitors", "panels", "runs", "workspace"].sort(),
    );
    expect(b.workspace).toMatchObject({ id: wsA, objective: "Is demand durable?", archivedAt: null, dataWindow: null });
    expect(b.workspace.owner).toEqual({ displayName: expect.anything(), nearAccountId: null });
    expect(b.runs).toEqual([]);
    expect(b.panels).toEqual([]);
    expect(b.capsules).toEqual([]);
    expect(b.costs.modelUsd).toBeNull(); // no run recorded a spend: unknown, not 0.000000
    expect(b.costs.creditsChargedYocto).toBe("0");
    expect(b.costs.entries).toEqual([]);
    expect(Date.parse(b.generatedAt)).not.toBeNaN();
  });

  it("includes hypotheses written through the public route", async () => {
    const c = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${wsA}/hypotheses`,
      headers: { ...bearer(owner), "idempotency-key": "report-hyp-0001" },
      payload: {
        proposition: "Lagged Intents volume improves forecasts of organic activity.",
        target: "organic daily actions",
        predictor: "lagged completed Intents volume",
        benchmark: "own-history ridge",
        falsification: "No significant gain over 77 origins.",
      },
    });
    expect(c.statusCode).toBe(201);
    const b = (await get(owner, `/v1/workspaces/${wsA}/report`)).json() as any;
    expect(b.hypotheses).toHaveLength(1);
    expect(b.hypotheses[0]).toMatchObject({ status: "draft", target: "organic daily actions" });
  });

  it("a viewer can read it", async () => {
    expect((await get(viewer, `/v1/workspaces/${wsA}/report`)).statusCode).toBe(200);
  });

  it("another tenant's workspace and an unknown id are the same 404; no session is 401", async () => {
    const foreign = await get(other, `/v1/workspaces/${wsA}/report`);
    const unknown = await get(other, `/v1/workspaces/00000000-0000-4000-8000-000000000000/report`);
    const bad = await get(owner, `/v1/workspaces/not-a-uuid/report`);
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(bad.statusCode).toBe(404);
    expect(sansTrace(foreign.json())).toEqual(sansTrace(unknown.json()));
    expect((await get("", `/v1/workspaces/${wsB}/report`)).statusCode).toBe(401);
  });
});

describe("report helpers", () => {
  it("usd6 keeps unknown as null", () => {
    expect(usd6(0.003224)).toBe("0.003224");
    expect(usd6(0)).toBe("0.000000");
    expect(usd6(null)).toBeNull();
    expect(usd6(Number.NaN)).toBeNull();
  });

  it("questionOf prefers the composer's objective over the root task's", () => {
    expect(
      questionOf({
        rootTask: { objective: "investigation" },
        children: [
          { role: "critic", objective: "x" },
          { role: "composer", objective: "How did swaps change?" },
        ],
      }),
    ).toBe("How did swaps change?");
    expect(questionOf({ rootTask: { objective: "investigation" }, children: [] })).toBe("investigation");
    expect(questionOf({})).toBeNull();
  });

  it("findingHashes resolves canvas panels then cited query hashes, once each", () => {
    const h1 = "a".repeat(64);
    const h2 = "b".repeat(64);
    const m = new Map([["p1", h1]]);
    expect(
      findingHashes(
        { panelIds: ["p1", "gone"], facts: [{ resultRef: { queryHash: h2 } }, { resultRef: { queryHash: h1 } }, {}] },
        m,
      ),
    ).toEqual([h1, h2]);
  });

  it("describePanel takes unit from the encoded columns and leaves unknowns null", () => {
    const data = {
      state: "partial",
      chart: { columns: [{ name: "d", unit: null }, { name: "swaps", unit: "swaps" }, { name: "rate", unit: "ratio" }], rows: [] },
      provenance: { sourceLabel: "LIVE", sources: ["near-explorer"], semanticVersion: "1.0.0", ast: { time: { from: "2026-01-01", to: "2026-02-01" } } },
      gaps: [{ from: "a", to: "b", reason: "r" }],
      caveats: ["c"],
      freshness: { state: "fresh", sourceWatermark: null },
    };
    const p = describePanel("h".repeat(64), { title: "T", kind: "timeSeries", encoding: { x: "d", y: ["rate"] } }, data, null);
    expect(p).toMatchObject({ title: "T", unit: "ratio", source: "LIVE: near-explorer", metricVersion: "1.0.0", window: { from: "2026-01-01", to: "2026-02-01" }, caveats: ["c"] });
    expect(p.coverage).toMatchObject({ state: "partial", gaps: 1, nullCount: null });
    const none = describePanel("h".repeat(64), undefined, null, { status: 404, reasonCode: "QUERY_UNKNOWN" });
    expect(none).toMatchObject({ title: null, kind: null, unit: null, source: null, window: null, coverage: null, data: null });
  });
});
