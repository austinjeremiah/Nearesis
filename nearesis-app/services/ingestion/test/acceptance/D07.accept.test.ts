import { observe } from "@nearesis/acceptance";
import { fixtureHash, readFixtureJson, readFixtureText } from "@nearesis/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
import { OneClickQuoteSampler, runQuoteGrid, type GridSlot } from "../../src/adapters/oneclick.ts";
import { ALLOW_ONECLICK, HttpClient } from "../../src/http/client.ts";
import { OneClickFixtureServer, type FakeResponse } from "../../src/testing/servers.ts";
import { setupEnv, type TestEnv } from "../helpers/env.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
}, 60_000);
afterAll(async () => env.close(), 60_000);

const QD = "fx.oneclick.quote-dry";
const TK = "fx.oneclick.tokens";

// D07: 1Click dry quote request -> dry=true, no real deposit/transaction side effect; every attempt classified
it("only sends dry quotes to the two allowlisted endpoints and classifies every attempt", async () => {
  const plan = readFixtureJson<{ attempts: Array<Record<string, unknown>>; expectedClasses: string[] }>(
    QD,
    "plan.json",
  );
  const tokens = readFixtureJson<unknown[]>(TK, "tokens.json");
  const scenarioByN = plan.attempts.filter((a) => a.outcome !== "not_attempted");
  const quote = (_b: Record<string, unknown>, n: number): FakeResponse | "timeout" | "network" => {
    const a = scenarioByN[n - 1]!;
    if (a.outcome === "timeout") return "timeout";
    if (a.outcome === "network_error") return "network";
    return { status: a.status as number, body: readFixtureText(QD, a.file as string) };
  };
  const server = new OneClickFixtureServer(env.clock, tokens, quote);
  const http = new HttpClient({ allow: [ALLOW_ONECLICK], fetchImpl: server.fetchImpl, clock: env.clock });
  const sampler = new OneClickQuoteSampler({
    http,
    archive: env.archive,
    clock: env.clock,
    sourceEnvironment: "fixture_synthetic",
  });

  // policy: forbidden endpoints and non-dry bodies throw BEFORE any I/O
  const before = server.requests.length;
  for (const [m, p] of [
    ["POST", "/v0/deposit/submit"],
    ["POST", "/v0/generate-intent"],
    ["POST", "/v0/submit-intent"],
    ["GET", "/v0/status"],
    ["GET", "/v0/orders"],
    ["POST", "/v0/auth/login"],
  ] as const) {
    await expect(sampler.call(m, p, m === "POST" ? { dry: true } : undefined)).rejects.toMatchObject({
      code: "ENDPOINT_NOT_ALLOWLISTED",
    });
  }
  await expect(sampler.call("POST", "/v0/quote", { amount: "1" })).rejects.toMatchObject({
    code: "DRY_REQUIRED",
  });
  await expect(sampler.call("POST", "/v0/quote", { dry: false })).rejects.toMatchObject({
    code: "DRY_REQUIRED",
  });
  await expect(sampler.call("POST", "/v0/quote", { dry: "true" })).rejects.toMatchObject({
    code: "DRY_REQUIRED",
  });
  expect(server.requests.length).toBe(before);

  const t = await sampler.fetchTokens();
  expect(t.tokens.length).toBe(tokens.length);

  const slots: GridSlot[] = plan.attempts.map((a) => ({
    routeId: a.routeId as string,
    originAsset: a.originAsset as string,
    destinationAsset: a.destinationAsset as string,
    amountBaseUnits: a.amountBaseUnits as string,
    privacyMode: a.privacyMode as "public" | "basic" | "advanced",
    scheduledBucketUTC: a.scheduledBucketUTC as string,
    attemptNo: a.attemptNo as number,
    recipient: "recipient.synthetic",
    refundTo: "refund.synthetic",
    destDecimals: t.tokens.find((x) => x.assetId === a.destinationAsset)?.decimals,
    skipped: a.outcome === "not_attempted",
  }));
  const res = await runQuoteGrid(sampler, env.tdb.db, slots);
  const got = res.map((r) => (r.slot === "unavailable" ? "unavailable" : r.class));
  expect(got).toEqual(plan.expectedClasses);

  // every quote request had dry:true; only the two allowlisted endpoints were called
  const quotes = server.requests.filter((r) => r.path === "/v0/quote");
  expect(quotes.length).toBe(scenarioByN.length);
  expect(quotes.every((r) => (r.body as { dry?: unknown }).dry === true)).toBe(true);
  expect(new Set(server.requests.map((r) => `${r.method} ${r.path}`))).toEqual(
    new Set(["GET /v0/tokens", "POST /v0/quote"]),
  );
  expect(sampler.callLog.every((c) => c.dry !== false)).toBe(true);

  // stored with class; unavailable slot never backfilled
  const rows = await env.tdb.db.query<{ class: string | null; slot: string; dry: boolean }>(
    "SELECT class, slot, dry FROM ingestion.quote_attempts ORDER BY scheduled_bucket_utc, amount_base_units, privacy_mode",
  );
  expect(rows.rowCount).toBe(8);
  expect(rows.rows.filter((r) => r.slot === "unavailable")).toHaveLength(1);
  expect(rows.rows.every((r) => r.dry)).toBe(true);
  const archived = await env.tdb.db.query<{ b: boolean }>(
    "SELECT (request->'body'->>'dry')::boolean AS b FROM ingestion.raw_observations WHERE request->>'method'='POST'",
  );
  expect(archived.rows.every((r) => r.b === true)).toBe(true);

  observe({
    testId: "D07",
    observed: `6 forbidden endpoints + 3 non-dry bodies rejected with 0 I/O; ${quotes.length} quote requests all dry:true; classes ${got.join(",")}; endpoints called: GET /v0/tokens, POST /v0/quote only; unavailable slot stored without backfill`,
    fixtureHash: fixtureHash(QD),
    evidence: {
      classes: got,
      endpoints: [...new Set(server.requests.map((r) => `${r.method} ${r.path}`))],
      quoteRequests: quotes.length,
      allDry: true,
      storedRows: rows.rowCount,
    },
  });
}, 120_000);
