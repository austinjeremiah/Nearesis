import { observe } from "@nearesis/acceptance";
import { fixtureHash } from "@nearesis/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
import { systemClock } from "../../src/clock.ts";
import { ExplorerFixtureServer } from "../../src/testing/servers.ts";
import { loadPages, setupEnv, type TestEnv } from "../helpers/env.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
}, 60_000);
afterAll(async () => env.close(), 60_000);

// D04: Two collectors, same JWT -> global 1 request / 5 seconds enforced (real clock, real Redis, real 5000 ms)
it("enforces one request per 5 s across two concurrent collectors sharing a JWT", async () => {
  const pages = loadPages("fx.explorer.pages-3");
  const s1 = new ExplorerFixtureServer(systemClock, pages);
  const s2 = new ExplorerFixtureServer(systemClock, pages);
  const c1 = env.collector(s1.fetchImpl, { clock: systemClock, streamKey: "stream:one" });
  const c2 = env.collector(s2.fetchImpl, { clock: systemClock, streamKey: "stream:two" });
  const t0 = Date.now();
  const [r1, r2] = await Promise.all([c1.run(), c2.run()]);
  const elapsed = Date.now() - t0;
  expect(r1.status).toBe("complete");
  expect(r2.status).toBe("complete");

  const grants = [...c1.grantLog, ...c2.grantLog].sort((a, b) => a - b);
  const reqTimes = [...s1.requests, ...s2.requests].map((r) => r.atMs).sort((a, b) => a - b);
  expect(grants).toHaveLength(6);
  expect(reqTimes).toHaveLength(6);
  const grantGaps = grants.slice(1).map((t, i) => t - grants[i]!);
  const reqGaps = reqTimes.slice(1).map((t, i) => t - reqTimes[i]!);
  expect(Math.min(...grantGaps)).toBeGreaterThanOrEqual(5000); // exact limiter guarantee
  expect(Math.min(...reqGaps)).toBeGreaterThanOrEqual(4900); // wall-clock request times (timer jitter allowance)
  expect(elapsed).toBeGreaterThanOrEqual(25_000);

  // a second collector on the SAME stream is refused by the single-scheduler lease
  const lease = env.collector(s1.fetchImpl, { streamKey: "stream:locked" });
  const leaseKey = `${lease.rateKey().replace("ingestion:rate:", "ingestion:lease:")}:stream:locked`;
  await env.redis.set(leaseKey, "other-owner", "PX", 30_000);
  expect((await lease.run()).status).toBe("lease_held");
  await env.redis.del(leaseKey);

  const rows = await env.tdb.db.query<{ n: string }>("SELECT count(*) n FROM ingestion.explorer_swaps");
  expect(Number(rows.rows[0]?.n)).toBe(13);
  observe({
    testId: "D04",
    observed: `2 collectors (same JWT) made ${grants.length} requests in ${elapsed} ms; min gap between limiter grants ${Math.min(...grantGaps)} ms (>=5000), min wall-clock request gap ${Math.min(...reqGaps)} ms; same-stream second collector got lease_held`,
    fixtureHash: fixtureHash("fx.explorer.pages-3"),
    evidence: {
      requests: grants.length,
      grantGapsMs: grantGaps,
      requestGapsMs: reqGaps,
      elapsedMs: elapsed,
      intervalMs: 5000,
      redisKeyPrefix: "ingestion:rate:explorer:",
    },
  });
}, 120_000);
