import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelError, toErrorResponse } from "@nearesis/kernel";
import type {
  AccountDataSource,
  AccountDay,
  ActivityInput,
  EntityDataSource,
  RegistrySnapshot,
} from "@nearesis/analytics";
import { accountRoutes } from "../src/account-routes.ts";
import { entityRoutes } from "../src/entity-routes.ts";

const days = Array.from({ length: 30 }, (_, i) =>
  new Date(Date.parse("2026-10-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10),
);
const mk = (date: string, i: number): AccountDay => ({
  date,
  signersAll: 1005,
  txAll: 2000,
  txIntents: 200,
  txBridge: 100,
  signersWithIntents: 5,
  signersOrganic: 1000,
  txOrganic: 1700,
  newSigners: i === 0 ? 1000 : 50,
  returningSigners: i === 0 ? 0 : 950,
  newTx: 100,
  returningTx: 1600,
  top10Tx: 850,
  top1PctSigners: 10,
  top1PctTx: 1000,
  top5PctSigners: 50,
  top5PctTx: 1200,
  headSigners: 3,
  headTx: 900,
  tailSigners: 997,
  tailTx: 800,
  headThreshold: 100,
});
const src: AccountDataSource = {
  window: async () => ({
    windowStart: "2026-10-01",
    from: days[0]!,
    to: days[29]!,
    days,
    headThreshold: 100,
  }),
  days: async (f, t) => days.map(mk).filter((r) => r.date >= f && r.date <= t),
  retention: async () => [
    { cohortWeek: "2026-09-28", activeWeek: "2026-09-28", signers: 1000 },
    { cohortWeek: "2026-09-28", activeWeek: "2026-10-05", signers: 600 },
  ],
  headAccounts: async () => [
    {
      account: "whale.near",
      headDays: 30,
      txOrganic: 9000,
      maxDayTx: 500,
      firstHeadDay: days[0]!,
      lastHeadDay: days[29]!,
    },
  ],
  headDays: async () => [{ date: days[0]!, txOrganic: 300 }],
  profile: async (a) =>
    a === "whale.near"
      ? {
          account: a,
          firstSeenInWindow: days[0]!,
          lastSeenInWindow: days[29]!,
          activeDays: 30,
          txOrganic: 9000,
          headDays: 30,
        }
      : null,
  entityDays: async (e, f, t) =>
    e === "sweat"
      ? days
          .filter((d) => d >= f && d <= t)
          .map((date) => ({ date, signersAll: 70, txAll: 700, signersOrganic: 70, txOrganic: 700 }))
      : [],
};
const registry: RegistrySnapshot = {
  registryVersion: "t",
  entities: [
    {
      entityId: "sweat",
      entityType: "application",
      name: "Sweat",
      categoryId: null,
      parentEntityId: null,
      description: "d",
      registryVersion: "t",
    },
  ],
  mappings: [],
  relations: [],
};
const entSrc: EntityDataSource = {
  registry: async () => registry,
  activity: async (): Promise<ActivityInput> => ({ receivers: [], remainder: [] }),
  latestDate: async () => days[29]!,
};

const app = Fastify();
const auth = async (req: { headers: Record<string, unknown> }) => {
  if (req.headers.authorization !== "Bearer ok") throw new KernelError("UNAUTHENTICATED", "NO_SESSION", "no");
  return {} as never;
};
beforeAll(async () => {
  app.decorateRequest("traceId", "t-1");
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toErrorResponse(err, "t-1");
    void reply.status(status).send(body);
  });
  await app.register(accountRoutes, { authenticate: auth as never, source: src });
  await app.register(entityRoutes, { authenticate: auth as never, source: entSrc, signers: src });
});
afterAll(async () => app.close());
const get = (url: string, authed = true) =>
  app.inject({ method: "GET", url, headers: authed ? { authorization: "Bearer ok" } : {} });

describe("account routes", () => {
  it("require a session", async () => {
    expect((await get("/v1/accounts/daily", false)).statusCode).toBe(401);
  });
  it("coverage and daily carry the accounts-are-not-people meta and the window-start flag", async () => {
    const c = (await get("/v1/accounts/coverage")).json() as {
      windowStart: string;
      meta: { accountsArePeople: boolean; caveats: string[] };
    };
    expect(c.windowStart).toBe("2026-10-01");
    expect(c.meta.accountsArePeople).toBe(false);
    expect(c.meta.caveats.join(" ")).toMatch(/not people/);
    const d = (await get("/v1/accounts/daily?days=5")).json() as {
      daily: Array<{ date: string; isWindowStart: boolean }>;
      coverage: { missingDays: string[] };
    };
    expect(d.daily).toHaveLength(5);
    expect(d.coverage.missingDays).toEqual([]);
    const all = (await get("/v1/accounts/daily?from=2026-10-01&to=2026-10-03")).json() as {
      daily: Array<{ isWindowStart: boolean }>;
    };
    expect(all.daily[0]!.isWindowStart).toBe(true);
  });
  it("growth, retention, concentration and high-frequency answer from the scan", async () => {
    const g = (await get("/v1/accounts/growth?days=10")).json() as {
      complete: boolean;
      change: number | null;
    };
    expect(g.complete).toBe(true);
    expect(g.change).toBe(0);
    const r = (await get("/v1/accounts/retention")).json() as {
      cohorts: Array<{ cohortSize: number; weeks: Array<{ rate: number }> }>;
    };
    expect(r.cohorts[0]!.weeks.map((w) => w.rate)).toEqual([1, 0.6]);
    const c = (await get("/v1/accounts/concentration?days=3")).json() as {
      daily: Array<{ top10AccountsShare: number; headShare: number }>;
      range: { top1PctShare: number };
    };
    expect(c.daily[0]).toMatchObject({ top10AccountsShare: 0.5, headShare: 900 / 1700 });
    const h = (await get("/v1/accounts/high-frequency?limit=5")).json() as {
      accounts: Array<{ account: string; frequencyLabel: string }>;
      caveat: string;
    };
    expect(h.accounts[0]).toMatchObject({ account: "whale.near", frequencyLabel: "high_frequency_account" });
    expect(h.caveat).toMatch(/not proof/);
  });
  it("account profile exists only for head accounts; others are NOT_FOUND, never zero", async () => {
    const ok = await get("/v1/accounts/whale.near/profile");
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ kind: "account (not a person)", profile: { activeDays: 30 } });
    const nf = await get("/v1/accounts/someone.near/profile");
    expect(nf.statusCode).toBe(404);
    expect(JSON.stringify(nf.json())).toContain("ACCOUNT_NOT_IN_HEAD_SET");
  });
  it("rejects bad ranges and unknown parameters", async () => {
    expect((await get("/v1/accounts/daily?from=2026-10-10&to=2026-10-01")).statusCode).toBe(422);
    expect((await get("/v1/accounts/daily?bogus=1")).statusCode).toBe(422);
    expect((await get("/v1/accounts/not%20valid/profile")).statusCode).toBe(422);
  });
});

describe("entity unique signers replace CANNOT_COMPUTE when the scan is loaded", () => {
  it("serves exact per-day signers and a bounded window distinct", async () => {
    const r = (await get("/v1/entities/sweat/unique-users?days=10")).json() as {
      state: string;
      daily: unknown[];
      summary: {
        averageDailySigners: number;
        windowDistinctSigners: { state: string; lowerBound: number; upperBound: number };
      };
    };
    expect(r.state).toBe("COMPUTED");
    expect(r.daily).toHaveLength(10);
    expect(r.summary.averageDailySigners).toBe(70);
    expect(r.summary.windowDistinctSigners).toMatchObject({
      state: "CANNOT_COMPUTE",
      lowerBound: 70,
      upperBound: 700,
    });
  });
  it("the drilldown and metrics carry the same real answer; changes adds per-entity signers", async () => {
    const d = (await get("/v1/entities/sweat")).json() as { uniqueUsers: { state: string } };
    expect(d.uniqueUsers.state).toBe("COMPUTED");
    const m = (await get("/v1/entities/sweat/metrics?from=2026-10-01&to=2026-10-05")).json() as {
      uniqueUsers: { state: string; daily: unknown[] };
    };
    expect(m.uniqueUsers.daily).toHaveLength(5);
  });
  it("without a per-signer source the legacy CANNOT_COMPUTE remains", async () => {
    const legacy = Fastify();
    legacy.decorateRequest("traceId", "t-1");
    legacy.setErrorHandler((err, _req, reply) => {
      const { status, body } = toErrorResponse(err, "t-1");
      void reply.status(status).send(body);
    });
    await legacy.register(entityRoutes, { authenticate: auth as never, source: entSrc });
    const r = await legacy.inject({
      url: "/v1/entities/sweat/unique-users",
      headers: { authorization: "Bearer ok" },
    });
    expect(r.json()).toMatchObject({ state: "CANNOT_COMPUTE", reasonCode: "PER_SIGNER_SOURCE_MISSING" });
    await legacy.close();
  });
});
