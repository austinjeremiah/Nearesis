import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelError, toErrorResponse } from "@nearesis/kernel";
import { loadLiveRegistry } from "@nearesis/analytics";
import { metricRegistryRoutes } from "../src/metric-registry-routes.ts";

const app = Fastify();
const reg = loadLiveRegistry();
beforeAll(async () => {
  app.decorateRequest("traceId", "t-1");
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toErrorResponse(err, "t-1");
    void reply.status(status).send(body);
  });
  await app.register(metricRegistryRoutes, {
    authenticate: async (req) => {
      if (req.headers.authorization !== "Bearer ok")
        throw new KernelError("UNAUTHENTICATED", "NO_SESSION", "no");
      return {} as never;
    },
  });
});
afterAll(async () => app.close());
const get = (url: string, auth = true) =>
  app.inject({ method: "GET", url, headers: auth ? { authorization: "Bearer ok" } : {} });

describe("registry metric detail", () => {
  const m = reg.metrics[0]!;
  it("requires a session", async () => {
    expect((await get(`/v1/metrics/${m.id}`, false)).statusCode).toBe(401);
    expect((await get(`/v1/metrics/${m.id}/versions`, false)).statusCode).toBe(401);
  });
  it("serves definition, certification, semantic hash and sources of a registry metric", async () => {
    const r = await get(`/v1/metrics/${m.id}`);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({
      metricKey: m.id,
      source: "registry",
      version: m.certifiedVersion,
      unit: m.unit,
    });
    expect(b.semanticHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.sources).toEqual(m.sources);
    expect(b.registryContentHash).toBe(reg.contentHash);
    const v = (await get(`/v1/metrics/${m.id}/versions`)).json();
    expect(v.versions[0]).toMatchObject({
      version: m.certifiedVersion,
      semanticHash: b.semanticHash,
      current: true,
    });
  });
  it("answers 404 for unknown or authored keys", async () => {
    const x = await get("/v1/metrics/authored.nothing");
    expect(x.statusCode, x.body).toBe(404);
    expect((await get("/v1/metrics/authored.nothing/versions")).statusCode).toBe(404);
  });
});
