import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelError, toErrorResponse } from "@nearesis/kernel";
import {
  buildFreshness,
  buildLastHour,
  realtimeRoutes,
  type RealtimeMinute,
  type RealtimeSource,
  type RealtimeWatermark,
} from "../src/realtime-routes.ts";

const NOW = Date.parse("2026-11-13T10:30:20Z");
const wm: RealtimeWatermark = {
  provider: "near-rpc-public",
  height: 1000,
  blockHash: "H1000",
  blockTime: "2026-11-13T10:30:18.000Z",
  headHeight: 1002,
  observedAt: "2026-11-13T10:30:19.000Z",
  ingestedAt: "2026-11-13T10:30:19.500Z",
  lagSeconds: 1.5,
  firstBlockTime: "2026-11-13T08:00:00.000Z",
  skippedHeights: 0,
  state: "live",
};
const minute = (i: number, over: Partial<RealtimeMinute> = {}): RealtimeMinute => ({
  minute: new Date(Math.floor(NOW / 60_000) * 60_000 - i * 60_000).toISOString(),
  state: "final",
  complete: true,
  txCount: 600,
  receiptCount: 1200,
  gasBurnt: "1000",
  tokensBurntYocto: "5",
  activeSigners: 300,
  ...over,
});

describe("realtime freshness and last-hour views", () => {
  it("exposes every required freshness field and flags a stopped collector", () => {
    const ok = buildFreshness(wm, [], 0, NOW) as Record<string, unknown>;
    for (const k of [
      "lastObservationTime",
      "lastIngestionTime",
      "watermark",
      "finality",
      "historicalCoverage",
      "collectorLagSeconds",
      "reconciliation",
      "partialDayWarnings",
      "dataVintageLimitations",
    ])
      expect(ok, k).toHaveProperty(k);
    expect(ok.finality).toBe("final");
    expect(ok.collectorState).toBe("live");
    const stopped = buildFreshness(wm, [], 2, NOW + 600_000) as {
      collectorState: string;
      partialDayWarnings: string[];
    };
    expect(stopped.collectorState).toBe("stopped");
    expect(stopped.partialDayWarnings.join(" ")).toMatch(/not running/);
    expect(buildFreshness(null, [], 0, NOW).status).toBe("NO_DATA");
  });
  it("transactions_last_hour counts only complete final minutes; provisional is kept apart; gaps are not zero-filled", () => {
    const full = buildLastHour(
      [
        ...Array.from({ length: 60 }, (_, i) => minute(i + 1)),
        minute(0, { state: "provisional", complete: false, txCount: 9 }),
      ],
      NOW,
    );
    expect(full).toMatchObject({
      status: "OK",
      finalized: { transactions: 36000, minutesCovered: 60 },
      provisional: { transactions: 9 },
    });
    const part = buildLastHour(
      Array.from({ length: 10 }, (_, i) => minute(i + 1)),
      NOW,
    );
    expect(part).toMatchObject({ status: "PARTIAL", missingMinutes: 50, finalized: { transactions: 6000 } });
    expect(buildLastHour([], NOW).status).toBe("INSUFFICIENT_DATA");
  });
});

describe("realtime routes", () => {
  const source: RealtimeSource = {
    watermark: async () => wm,
    minutesSince: async () => Array.from({ length: 60 }, (_, i) => minute(i + 1)),
    reconciliation: async () => [],
    anomalyCount: async () => 0,
  };
  const app = Fastify();
  beforeAll(async () => {
    app.setErrorHandler((err, _req, reply) => {
      const k = err instanceof KernelError ? err : new KernelError("INTERNAL", "X", "x");
      void reply.status(k.code === "UNAUTHENTICATED" ? 401 : 500).send(toErrorResponse(k, "r"));
    });
    await app.register(realtimeRoutes, {
      authenticate: async (req) => {
        if (!req.headers.authorization) throw new KernelError("UNAUTHENTICATED", "NO_SESSION", "no");
        return {} as never;
      },
      source,
      now: () => NOW,
    });
  });
  afterAll(async () => app.close());
  it("requires a session and serves both views", async () => {
    expect((await app.inject({ url: "/v1/realtime/freshness" })).statusCode).toBe(401);
    const h = { authorization: "Bearer t" };
    const f = await app.inject({ url: "/v1/realtime/freshness", headers: h });
    expect(f.statusCode).toBe(200);
    expect(f.json().watermark.height).toBe(1000);
    const t = await app.inject({ url: "/v1/realtime/transactions-last-hour", headers: h });
    expect(t.json().finalized.transactions).toBe(36000);
  });
});
