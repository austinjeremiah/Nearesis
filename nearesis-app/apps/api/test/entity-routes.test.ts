import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelError, toErrorResponse } from "@nearesis/kernel";
import type { ActivityInput, EntityDataSource, MappingRow, RegistrySnapshot } from "@nearesis/analytics";
import { entityRoutes } from "../src/entity-routes.ts";

const m = (o: Partial<MappingRow> & Pick<MappingRow, "entityId" | "account">): MappingRow => ({
  mappingId: `${o.entityId}:${o.account}`,
  network: "near",
  matchType: "exact",
  role: "contract",
  effectiveFrom: "2026-01-01T00:00:00Z",
  effectiveTo: null,
  registryVersion: "t",
  methodology: "exact id",
  verification: "verified",
  confidence: "high",
  evidenceKind: "official_docs",
  evidenceUrl: "https://example.org/docs",
  evidenceNote: "",
  limitations: "calls only",
  precedence: 10,
  ...o,
});
const e = (id: string, type = "application", categoryId: string | null = null) => ({
  entityId: id,
  entityType: type as "application",
  name: id.toUpperCase(),
  categoryId,
  parentEntityId: null,
  description: `${id} desc`,
  registryVersion: "t",
});
const registry: RegistrySnapshot = {
  registryVersion: "t",
  entities: [e("cat.dex", "category"), e("rhea", "application", "cat.dex"), e("aurora", "protocol")],
  mappings: [
    m({ entityId: "rhea", account: "v2.ref-finance.near" }),
    m({ entityId: "rhea", account: "dclv2.ref-labs.near" }),
    m({ entityId: "aurora", account: "aurora" }),
  ],
  relations: [],
};
const dates = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
const activity: ActivityInput = {
  receivers: dates.flatMap((d, i) => [
    { date: d, receiver: "v2.ref-finance.near", interactions: i < 2 ? 100 : 300 },
    { date: d, receiver: "aurora", interactions: 100 },
    { date: d, receiver: "unknown.near", interactions: 100 },
  ]),
  remainder: dates.map((date) => ({ date, interactions: 5 })),
};
let calls = 0;
const source: EntityDataSource = {
  async registry() {
    calls++;
    return registry;
  },
  async activity() {
    return activity;
  },
  async latestDate() {
    return "2026-10-04";
  },
};

const app = Fastify();
let failing = false;
beforeAll(async () => {
  app.decorateRequest("traceId", "t-1");
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toErrorResponse(err, "t-1");
    void reply.status(status).send(body);
  });
  await app.register(entityRoutes, {
    authenticate: async (req) => {
      if (req.headers.authorization !== "Bearer ok")
        throw new KernelError("UNAUTHENTICATED", "NO_SESSION", "no");
      return {} as never;
    },
    source: {
      ...source,
      registry: async () => (failing ? Promise.reject(new Error("ch down")) : source.registry()),
    },
  });
});
afterAll(async () => app.close());
const get = (url: string, auth = true) =>
  app.inject({ method: "GET", url, headers: auth ? { authorization: "Bearer ok" } : {} });

describe("entity routes", () => {
  it("requires a session", async () => {
    const r = await get("/v1/entities", false);
    expect(r.statusCode).toBe(401);
  });
  it("lists and searches entities (by name and by mapped account)", async () => {
    const all = (await get("/v1/entities")).json() as {
      entities: Array<{ entityId: string; mappingCount: number }>;
    };
    expect(all.entities.length).toBe(3);
    const byAcct = (await get("/v1/entities?q=ref-finance")).json() as {
      entities: Array<{ entityId: string }>;
    };
    expect(byAcct.entities.map((x) => x.entityId)).toEqual(["rhea"]);
    const byType = (await get("/v1/entities?type=protocol")).json() as {
      entities: Array<{ entityId: string }>;
    };
    expect(byType.entities.map((x) => x.entityId)).toEqual(["aurora"]);
  });
  it("returns mappings with evidence and the drilldown", async () => {
    const r = (await get("/v1/entities/rhea/mappings")).json() as {
      mappings: Array<{ evidenceUrl: string; effectiveFrom: string; limitations: string }>;
    };
    expect(r.mappings).toHaveLength(2);
    expect(r.mappings[0]).toMatchObject({
      evidenceUrl: "https://example.org/docs",
      limitations: "calls only",
    });
    const d = (await get("/v1/entities/rhea")).json() as {
      category: { entityId: string };
      uniqueUsers: { state: string };
    };
    expect(d.category.entityId).toBe("cat.dex");
    expect(d.uniqueUsers.state).toBe("CANNOT_COMPUTE");
  });
  it("answers the period-over-period question with coverage", async () => {
    const r = (await get("/v1/entities/changes?days=2")).json() as {
      entities: Array<{ entityId: string; change: number; current: { interactions: number } }>;
      currentCoverage: { classifiedShare: number; unclassifiedShare: number };
      uniqueUsers: { state: string; missingSource: string };
    };
    expect(r.entities[0]).toMatchObject({ entityId: "rhea", change: 400, current: { interactions: 600 } });
    expect(r.currentCoverage.classifiedShare).toBeCloseTo(800 / 1010, 9);
    expect(r.currentCoverage.unclassifiedShare).toBeCloseTo(210 / 1010, 9);
    expect(r.uniqueUsers).toMatchObject({ state: "CANNOT_COMPUTE" });
  });
  it("serves entity daily metrics, coverage and the unique-users CANNOT_COMPUTE", async () => {
    const d = (await get("/v1/entities/rhea/metrics?from=2026-10-01&to=2026-10-04")).json() as {
      grain: string;
      points: Array<{ interactions: number }>;
    };
    expect(d.grain).toBe("day");
    expect(d.points.map((p) => p.interactions)).toEqual([100, 100, 300, 300]);
    const c = (await get("/v1/entities/coverage?days=4")).json() as {
      topUnclassifiedReceivers: Array<{ receiver: string }>;
    };
    expect(c.topUnclassifiedReceivers[0]!.receiver).toBe("unknown.near");
    const u = await get("/v1/entities/aurora/unique-users");
    expect(u.statusCode).toBe(200);
    expect(u.json()).toMatchObject({ state: "CANNOT_COMPUTE", reasonCode: "PER_SIGNER_SOURCE_MISSING" });
  });
  it("typed errors: unknown entity 404, bad query 422/400, source outage 5xx retryable", async () => {
    const nf = await get("/v1/entities/nope-x");
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toMatchObject({ errorCode: "NOT_FOUND", reasonCode: "ENTITY_NOT_FOUND" });
    const bad = await get("/v1/entities/rhea/metrics?from=2026-13-40&to=2026-10-04");
    expect(bad.json()).toMatchObject({ errorCode: "VALIDATION_FAILED", reasonCode: "INVALID_QUERY" });
    const extra = await get("/v1/entities?bogus=1");
    expect(extra.json()).toMatchObject({ errorCode: "VALIDATION_FAILED" });
    failing = true;
    const down = await get("/v1/entities");
    failing = false;
    expect(down.json()).toMatchObject({
      errorCode: "UPSTREAM_DEGRADED",
      reasonCode: "ENTITY_SOURCE_UNAVAILABLE",
      retryable: true,
    });
    expect(JSON.stringify(down.json())).not.toContain("ch down");
    expect(calls).toBeGreaterThan(0);
  });
});
