import { observe } from "@nearesis/acceptance";
import { fixtureHash } from "@nearesis/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ExplorerFixtureServer } from "../../src/testing/servers.ts";
import { explorerImportChecksum } from "../../src/adapters/explorer.ts";
import { loadPages, setupEnv, type TestEnv } from "../helpers/env.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
}, 60_000);
afterAll(async () => env.close(), 60_000);

// D02: Explorer HTTP 429 -> rate backoff respects partner limit, no dropped cursor
it("honours Retry-After, falls back to exponential backoff with a 5 s floor, and never advances the cursor on 429", async () => {
  const pages = loadPages("fx.explorer.pages-3");
  const server = new ExplorerFixtureServer(env.clock, pages);
  const c = env.collector(server.fetchImpl, { max429Retries: 1 });

  // commit page 1, then throttle page 2 hard
  const first = await c.run({ maxPages: 1 });
  expect(first.pagesCommitted).toBe(1);
  const cpBefore = await c.checkpoint();

  let throttled = 0;
  server.intercept((r) => {
    if (r.query.lastDepositAddress && throttled < 2) {
      throttled++;
      return {
        status: 429,
        headers: (throttled === 1 ? { "retry-after": "7" } : {}) as Record<string, string>,
        body: JSON.stringify({ status: 429, error: { code: "RATE_LIMIT", message: "slow down" } }),
      };
    }
    return undefined;
  });
  const t429 = env.clock.now();
  const blocked = await c.run();
  expect(blocked.status).toBe("rate_limited");
  const cpAfter = await c.checkpoint();
  // no dropped / advanced cursor, no new facts
  expect(cpAfter.cursor).toEqual(cpBefore.cursor);
  expect(cpAfter.pagesCommitted).toBe(1);
  expect(c.backoffLog[0]).toEqual({ attempt: 1, delayMs: 7000, source: "retry-after" });
  const reqs = server.requests.filter((r) => r.status === 429).map((r) => r.atMs);
  expect(reqs).toHaveLength(2);
  expect(reqs[1]! - reqs[0]!).toBeGreaterThanOrEqual(7000);

  // exponential path: two 429s without Retry-After => 5 s then 10 s (floor 5 s)
  const server2 = new ExplorerFixtureServer(env.clock, pages);
  const c2 = env.collector(server2.fetchImpl, { streamKey: "transactions:exp" });
  await c2.run({ maxPages: 1 });
  let n = 0;
  server2.intercept((r) => (r.query.lastDepositAddress && n++ < 2 ? { status: 429, body: "{}" } : undefined));
  const done = await c2.run();
  expect(done.status).toBe("complete");
  expect(c2.backoffLog.map((b) => ({ d: b.delayMs, s: b.source }))).toEqual([
    { d: 5000, s: "exponential" },
    { d: 10000, s: "exponential" },
  ]);
  expect(Math.min(...c2.backoffLog.map((b) => b.delayMs))).toBeGreaterThanOrEqual(5000);

  // every request, across both collectors per credential, is >= 5 s apart (global limit)
  const all = [...server.requests, ...server2.requests].map((r) => r.atMs).sort((a, b) => a - b);
  const minGap = Math.min(...all.slice(1).map((t, i) => t - all[i]!));
  expect(minGap).toBeGreaterThanOrEqual(5000);

  // recover the throttled stream: resumes at the committed cursor and equals a clean import
  server.intercept(null);
  const resumed = await c.run();
  expect(resumed.status).toBe("complete");
  const ck = await explorerImportChecksum(env.tdb.db);
  expect(ck.count).toBe(13);
  observe({
    testId: "D02",
    observed: `429 with Retry-After: waited ${c.backoffLog[0]?.delayMs} ms; 429s without it: ${c2.backoffLog.map((b) => b.delayMs).join(",")} ms (floor 5000); cursor unchanged at page ${cpAfter.pagesCommitted} during throttling; min request gap ${minGap} ms; resumed to ${ck.count} swaps`,
    fixtureHash: fixtureHash("fx.explorer.pages-3"),
    evidence: {
      retryAfterBackoffMs: c.backoffLog[0]?.delayMs,
      exponentialBackoffMs: c2.backoffLog.map((b) => b.delayMs),
      minRequestGapMs: minGap,
      cursorUnchanged: true,
      resumedSwapCount: ck.count,
      simulatedElapsedMs: env.clock.now() - t429,
    },
  });
}, 120_000);
