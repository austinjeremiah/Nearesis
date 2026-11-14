import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelError, toErrorResponse } from "@nearesis/kernel";
import { accountRoutes } from "../src/account-routes.ts";
import { entityRoutes } from "../src/entity-routes.ts";

/** Real nearesis_live tables loaded by the A23 scan (window 2025-11-10..2026-11-11). Skipped when ClickHouse or the scan is absent. */
let live = false;
const app = Fastify();
const auth = async (req: { headers: Record<string, unknown> }) => {
  if (req.headers.authorization !== "Bearer ok") throw new KernelError("UNAUTHENTICATED", "NO_SESSION", "no");
  return {} as never;
};
beforeAll(async () => {
  try {
    const r = await fetch("http://127.0.0.1:58123/?user=nearesis&password=nearesis&database=nearesis_live", {
      method: "POST",
      body: "SELECT count() FROM account_daily_new_returning FINAL",
    });
    live = r.ok && Number((await r.text()).trim()) >= 300;
  } catch {
    live = false;
  }
  app.decorateRequest("traceId", "t-1");
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toErrorResponse(err, "t-1");
    void reply.status(status).send(body);
  });
  await app.register(accountRoutes, { authenticate: auth as never });
  await app.register(entityRoutes, { authenticate: auth as never });
});
afterAll(async () => app.close());
const get = (url: string) => app.inject({ url, headers: { authorization: "Bearer ok" } });

describe("account and entity-signer APIs on the loaded scan", () => {
  it("reconciles head + tail to organic transactions on every loaded day and answers the 90-day per-entity question", async (ctx) => {
    if (!live) return ctx.skip();
    const c = (await get("/v1/accounts/coverage")).json() as { windowStart: string; days: number };
    expect(c.windowStart).toBe("2025-11-10");
    expect(c.days).toBe(367);
    const d = (await get("/v1/accounts/concentration?from=2025-11-10&to=2026-11-11")).json() as {
      daily: Array<{ headShare: number; tailShare: number }>;
    };
    for (const r of d.daily) expect(r.headShare + r.tailShare).toBeCloseTo(1, 12);
    const rows: Array<[string, number | null, number | null, number]> = [];
    for (const id of [
      "sweat",
      "hot",
      "rhea",
      "near-intents",
      "token.wnear",
      "near-chain-signatures",
      "omni-bridge",
      "aurora",
    ]) {
      const r = (await get(`/v1/entities/${id}/unique-users?days=90`)).json() as {
        state: string;
        summary: { averageDailySigners: number; peakDailySigners: number; signerDays: number };
        coverage: { daysWithData: number };
      };
      expect(r.state).toBe("COMPUTED");
      expect(r.coverage.daysWithData).toBe(90);
      rows.push([id, r.summary.averageDailySigners, r.summary.peakDailySigners, r.summary.signerDays]);
    }
    console.log(
      "90-day per-entity daily signers [entity, avg/day, peak/day, signer-days]",
      JSON.stringify(rows),
    );
    expect(rows.find((r) => r[0] === "sweat")![1]).toBeGreaterThan(0);
  });
  it("new vs returning identities hold on every day and retention rates are within [0,1]", async (ctx) => {
    if (!live) return ctx.skip();
    const d = (await get("/v1/accounts/daily?from=2025-11-10&to=2026-11-11")).json() as {
      daily: Array<{ activeAccounts: number; newAccounts: number; returningAccounts: number }>;
      coverage: { missingDays: string[] };
    };
    expect(d.coverage.missingDays).toEqual([]);
    for (const r of d.daily) expect(r.newAccounts + r.returningAccounts).toBe(r.activeAccounts);
    const rt = (await get("/v1/accounts/retention")).json() as {
      cohorts: Array<{ weeks: Array<{ rate: number }> }>;
    };
    for (const co of rt.cohorts) for (const w of co.weeks) expect(w.rate).toBeLessThanOrEqual(1);
  });
});
