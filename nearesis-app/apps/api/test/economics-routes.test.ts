import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelError, toErrorResponse } from "@nearesis/kernel";
import { EconomicsReader, createCh } from "@nearesis/analytics";
import { economicsRoutes } from "../src/economics-routes.ts";

/** Real stack: read-only over the loaded near_economics_* tables in nearesis_live (skipped when ClickHouse is down). */
let up = false;
const app = Fastify();
const ch = createCh({ database: "nearesis_live" });
beforeAll(async () => {
  up = await fetch("http://127.0.0.1:58123/ping").then(
    (r) => r.ok,
    () => false,
  );
  app.decorateRequest("traceId", "t-1");
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toErrorResponse(err, "t-1");
    void reply.status(status).send(body);
  });
  await app.register(economicsRoutes, {
    reader: new EconomicsReader(ch, "nearesis_live"),
    authenticate: async (req) => {
      if (req.headers.authorization !== "Bearer ok")
        throw new KernelError("UNAUTHENTICATED", "NO_SESSION", "no");
      return {} as never;
    },
  });
});
afterAll(async () => {
  await app.close();
  await ch.close();
});
const get = (url: string, auth = true) =>
  app.inject({ method: "GET", url, headers: auth ? { authorization: "Bearer ok" } : {} });

describe("economics routes", () => {
  it("require a session", async () => {
    for (const p of ["daily", "totals", "receivers", "percentiles", "coverage"])
      expect((await get(`/v1/economics/${p}`, false)).statusCode).toBe(401);
  });
  it("rejects malformed parameters", async () => {
    expect((await get("/v1/economics/daily?from=x&to=y")).statusCode).toBe(422);
    expect((await get("/v1/economics/receivers?top=100000")).statusCode).toBe(422);
    expect((await get("/v1/economics/daily?from=2026-11-05&to=2026-11-01")).statusCode).toBe(422);
  });
  it.skipIf(process.env.RUN_LIVE_STACK === undefined)(
    "serves 90 loaded days with exact strings and honest caveats",
    async () => {
      expect(up).toBe(true);
      const r = await get("/v1/economics/daily");
      expect(r.statusCode, r.body).toBe(200);
      const b = r.json();
      expect(b.precision).toBe("source_float64");
      expect(b.data.length).toBe(90);
      const d = b.data[b.data.length - 1];
      expect(d.tokensBurntYocto).toMatch(/^\d+$/);
      expect(d.gasBurnt).toMatch(/^\d+$/);
      expect(d.conversion.receiptOnlyTokensBurntYocto).toMatch(/^\d+$/);
      expect(JSON.stringify(b.data)).not.toMatch(/revenue/i);
      const priced = b.data.filter((x: { usd: string | null }) => x.usd !== null);
      for (const x of b.data) if (x.usd === null) expect(x.usdUnavailableReason).toBe("NO_TIMESTAMPED_PRICE");
      for (const x of priced) expect(x.usdConversion.method).toBe("coingecko_daily_close_utc");
      const cov = (await get("/v1/economics/coverage")).json();
      expect(cov.qualityGaps.map((g: { reasonCode: string }) => g.reasonCode)).toContain(
        "REFUND_SPLIT_IS_PROXY",
      );
      const rc = (await get("/v1/economics/receivers?top=5")).json();
      expect(rc.data.items).toHaveLength(5);
      const pc = (await get("/v1/economics/percentiles")).json();
      expect(pc.loaded).toBe(false);
      expect(pc.data).toEqual([]);
      const t = (await get("/v1/economics/totals")).json();
      expect(t.data.days).toBe(90);
    },
  );
});
