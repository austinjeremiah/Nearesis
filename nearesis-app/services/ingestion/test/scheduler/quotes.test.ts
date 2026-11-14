import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RawArchive } from "../../src/archive/archive.ts";
import { FsObjectStore } from "../../src/archive/object-store.ts";
import { FakeClock } from "../../src/clock.ts";
import { ALLOW_ONECLICK, HttpClient } from "../../src/http/client.ts";
import { CredentialSource } from "../../src/http/credentials.ts";
import { loadConfig } from "../../src/scheduler/config.ts";
import { DEFAULT_ROUTES } from "../../src/scheduler/plan.ts";
import { OneClickQuoteSampler } from "../../src/adapters/oneclick.ts";
import { runQuoteRound, type QuoteRow } from "../../src/scheduler/quotes.ts";
import { SchedulerStateStore } from "../../src/scheduler/state.ts";
import { FixtureServer, type FakeResponse, type ServedRequest } from "../../src/testing/servers.ts";

const WNEAR = DEFAULT_ROUTES[0]!.originAsset;
const USDC = DEFAULT_ROUTES[0]!.destinationAsset;
const TOKENS = [
  {
    assetId: WNEAR,
    decimals: 24,
    blockchain: "near",
    symbol: "wNEAR",
    price: 3.65,
    priceUpdatedAt: "2026-11-11T10:00:00Z",
  },
  {
    assetId: USDC,
    decimals: 6,
    blockchain: "near",
    symbol: "USDC",
    price: 1,
    priceUpdatedAt: "2026-11-11T10:00:00Z",
  },
];

class OneClickFake extends FixtureServer {
  protected handle(req: ServedRequest): FakeResponse {
    if (req.method === "GET" && req.path === "/v0/tokens")
      return { status: 200, body: JSON.stringify(TOKENS) };
    const b = req.body as { amount: string; confidentiality?: string; destinationAsset: string };
    if (b.confidentiality === "advanced")
      return { status: 400, body: JSON.stringify({ message: "invalid confidentiality value" }) };
    if (b.confidentiality === "basic") return { status: 503, body: "{}" };
    if (b.amount.length > 9 && b.destinationAsset === USDC && b.amount === "2739726027397260273972602")
      return { status: 400, body: JSON.stringify({ message: "insufficient liquidity" }) };
    return {
      status: 200,
      body: JSON.stringify({
        correlationId: "c1",
        timestamp: "2026-11-11T10:00:00.000Z",
        quoteRequest: {},
        quote: {
          amountIn: b.amount,
          amountInFormatted: "1",
          amountInUsd: "10.0",
          minAmountIn: b.amount,
          amountOut: "9990000",
          amountOutFormatted: "9.99",
          amountOutUsd: "9.99",
          minAmountOut: "9900000",
          timeEstimate: 30,
        },
      }),
    };
  }
}

let tmp: string;
beforeAll(() => void (tmp = mkdtempSync(join(tmpdir(), "sched-quotes-"))));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function rig(
  name: string,
  over: Partial<ReturnType<typeof loadConfig>> = {},
  creds: Record<string, string> = { NEARESIS_QUOTE_ADDRESS_NEAR: "dry-recipient.near" },
) {
  const clock = new FakeClock(Date.parse("2026-11-11T10:20:00Z"));
  const server = new OneClickFake(clock);
  const http = new HttpClient({ allow: [ALLOW_ONECLICK], fetchImpl: server.fetchImpl, clock });
  const archive = new RawArchive(new FsObjectStore(join(tmp, name, "raw")), null);
  const sampler = new OneClickQuoteSampler({ http, archive, clock, sourceEnvironment: "live" });
  const store = new SchedulerStateStore(join(tmp, name, "state.json"));
  const cfg = { ...loadConfig({}), quotePaceMs: 0, quoteNotionalsUsd: [10, 100], ...over };
  const rows: QuoteRow[] = [];
  const routes = [DEFAULT_ROUTES[0]!, DEFAULT_ROUTES[1]!, DEFAULT_ROUTES[2]!]; // third asset is not in the token list
  const deps = (extra: { shouldStop?: () => boolean } = {}) => ({
    sampler,
    creds: CredentialSource.fromMap(creds),
    cfg,
    store,
    nowMs: () => clock.now(),
    sleep: (ms: number) => clock.sleep(ms),
    insert: async (r: QuoteRow[]) => void rows.push(...r),
    routes,
    ...extra,
  });
  return { clock, server, sampler, store, cfg, rows, deps, http };
}

describe("quote sampler round", () => {
  it("records every grid slot exactly once: attempts of every class (failures included) and unavailable slots with a reason", async () => {
    const r = rig("all");
    const res = await runQuoteRound(r.deps());
    // 3 routes x 2 notionals x 3 modes
    expect(r.rows).toHaveLength(18);
    expect(res.complete).toBe(true);
    expect(new Set(r.rows.map((x) => `${x.route_id}|${x.notional_usd}|${x.privacy_mode}`)).size).toBe(18);
    // the table's ReplacingMergeTree key must not collapse distinct slots (unavailable slots have no amount)
    expect(
      new Set(
        r.rows.map((x) =>
          [x.route_id, x.amount_base_units, x.privacy_mode, x.scheduled_bucket_utc, x.attempt_no].join("|"),
        ),
      ).size,
    ).toBe(18);
    const byClass = (c: string) => r.rows.filter((x) => x.class === c).length;
    expect(byClass("OK")).toBeGreaterThan(0);
    expect(byClass("NETWORK_ERROR")).toBe(4); // BASIC -> HTTP 503, 2 routes x 2 notionals
    expect(byClass("INVALID_OUTPUT")).toBe(6); // ADVANCED -> HTTP 400 (4) + public USDC>wNEAR: amountOut scale impossible for 24 decimals (2)
    expect(byClass("NO_QUOTE")).toBeGreaterThan(0);
    const unavailable = r.rows.filter((x) => x.slot === "unavailable");
    expect(unavailable).toHaveLength(6); // the unlisted third route
    expect(
      unavailable.every(
        (x) =>
          x.reason === "ASSET_NOT_LISTED" &&
          x.class === null &&
          String(x.amount_base_units).startsWith("n/a:"),
      ),
    ).toBe(true);
    for (const x of r.rows) {
      expect(x.dry).toBe(1);
      expect(x.source_label).toBe("LIVE");
      expect(x.attempt_no).toBe(1);
    }
    const ok = r.rows.find((x) => x.class === "OK")!;
    expect(ok).toMatchObject({
      amount_out_base_units: "9990000",
      amount_in_usd: "10.0",
      amount_out_usd: "9.99",
      time_estimate_s: 30,
      http_status: 200,
    });
    expect(typeof ok.raw_object_hash).toBe("string");
    expect(r.store.state.quotes.completedBucketMs).toBe(Date.parse("2026-11-11T10:00:00Z"));
  });

  it("only GET /v0/tokens and dry POST /v0/quote ever reach the network (no swap, no deposit)", async () => {
    const r = rig("allow");
    await runQuoteRound(r.deps());
    expect(r.server.requests.length).toBeGreaterThan(1);
    for (const q of r.server.requests) {
      expect([`GET /v0/tokens`, `POST /v0/quote`]).toContain(`${q.method} ${q.path}`);
      if (q.method === "POST") expect((q.body as { dry?: unknown }).dry).toBe(true);
    }
    const before = r.server.requests.length;
    await expect(r.sampler.call("POST", "/v0/quote", { dry: false })).rejects.toMatchObject({
      code: "DRY_REQUIRED",
    });
    await expect(r.sampler.call("POST", "/v0/quote", {})).rejects.toMatchObject({ code: "DRY_REQUIRED" });
    for (const [m, p] of [
      ["POST", "/v0/deposit/submit"],
      ["GET", "/v0/status"],
      ["POST", "/v0/swap"],
      ["GET", "/v0/quote"],
    ] as const)
      await expect(r.sampler.call(m, p, { dry: true })).rejects.toMatchObject({
        code: "ENDPOINT_NOT_ALLOWLISTED",
      });
    // the HTTP layer refuses them too, independently of the sampler guard
    await expect(
      r.http.request({ method: "POST", url: "https://1click.chaindefuser.com/v0/deposit/submit", body: {} }),
    ).rejects.toBeTruthy();
    expect(r.server.requests.length).toBe(before);
  });

  it("sends confidentiality in the lowercase form the live API accepts, still dry, public without the field", async () => {
    const r = rig("conf");
    await runQuoteRound(r.deps());
    const bodies = r.server.requests
      .filter((q) => q.path === "/v0/quote")
      .map((q) => q.body as Record<string, unknown>);
    expect(new Set(bodies.map((b) => b.confidentiality ?? "public"))).toEqual(
      new Set(["public", "basic", "advanced"]),
    );
    expect(
      bodies.every(
        (b) =>
          b.dry === true &&
          !("confidentiality" in b && b.confidentiality !== "basic" && b.confidentiality !== "advanced"),
      ),
    ).toBe(true);
  });

  it("without configured addresses no quote is requested and every slot is recorded unavailable", async () => {
    const r = rig("noaddr", {}, {});
    await runQuoteRound(r.deps());
    expect(r.rows).toHaveLength(18);
    expect(r.rows.every((x) => x.slot === "unavailable")).toBe(true);
    expect(r.rows.some((x) => String(x.reason).startsWith("NO_REFUND_ADDRESS_CONFIG:near"))).toBe(true);
    expect(r.server.requests.filter((q) => q.path === "/v0/quote")).toHaveLength(0);
  });

  it("an interrupted round resumes without repeating a slot", async () => {
    const r = rig("resume");
    let n = 0;
    const first = await runQuoteRound(r.deps({ shouldStop: () => n++ >= 7 }));
    expect(first.complete).toBe(false);
    expect(r.rows).toHaveLength(7);
    const reopened = new SchedulerStateStore(r.store.path); // new process: state from disk
    const second = await runQuoteRound({ ...r.deps(), store: reopened });
    expect(second.complete).toBe(true);
    expect(r.rows).toHaveLength(18);
    expect(new Set(r.rows.map((x) => `${x.route_id}|${x.notional_usd}|${x.privacy_mode}`)).size).toBe(18);
  });

  it("a new hourly bucket starts a fresh round", async () => {
    const r = rig("bucket");
    await runQuoteRound(r.deps());
    r.clock.advance(3_600_000);
    await runQuoteRound(r.deps());
    expect(r.rows).toHaveLength(36);
    expect(new Set(r.rows.map((x) => x.scheduled_bucket_utc)).size).toBe(2);
  });

  it("the bounded subset cap holds (at most 12 quotes)", async () => {
    const r = rig("limit", { quoteLimit: 12, quoteNotionalsUsd: [10, 100, 1000, 10000] });
    const res = await runQuoteRound({ ...r.deps(), routes: DEFAULT_ROUTES.slice(0, 2) });
    expect(res.attempted).toBeLessThanOrEqual(12);
    expect(r.server.requests.filter((q) => q.path === "/v0/quote").length).toBeLessThanOrEqual(12);
  });

  it("a failed token list is recorded as unavailable slots, not silence", async () => {
    const r = rig("tokfail");
    r.server.intercept((q) => (q.path === "/v0/tokens" ? { status: 500, body: "{}" } : undefined));
    const res = await runQuoteRound(r.deps());
    expect(res.attempted).toBe(0);
    expect(r.rows).toHaveLength(18);
    expect(r.rows.every((x) => x.reason === "TOKENS_FETCH_FAILED" && x.slot === "unavailable")).toBe(true);
  });
});
