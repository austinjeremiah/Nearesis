import { readFileSync } from "node:fs";
import { observe } from "@nearesis/acceptance";
import { fixtureHash, readFixtureJson } from "@nearesis/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
import { explorerImportChecksum } from "../../src/adapters/explorer.ts";
import { ExplorerFixtureServer } from "../../src/testing/servers.ts";
import { loadPages, keysOf, setupEnv, type TestEnv } from "../helpers/env.ts";

const ID = "fx.explorer.auth-expiry";
let clean: TestEnv;
const envs: Record<number, TestEnv> = {};
beforeAll(async () => {
  clean = await setupEnv();
  envs[401] = await setupEnv();
  envs[403] = await setupEnv();
}, 60_000);
afterAll(async () => {
  await Promise.all([clean.close(), envs[401]!.close(), envs[403]!.close()]);
}, 60_000);

// D18: Credential failure mid-run degrades the source honestly
async function scenario(status: number): Promise<{ observed: string; evidence: Record<string, unknown> }> {
  const env = envs[status]!;
  const pages = loadPages(ID);
  const script = readFixtureJson<{ failFromPage: number }>(ID, "script.json");
  await clean
    .collector(new ExplorerFixtureServer(clean.clock, pages).fetchImpl, { streamKey: "clean" })
    .run();
  const cleanCk = await explorerImportChecksum(clean.tdb.db);
  expect(cleanCk.count).toBe(25);

  const server = new ExplorerFixtureServer(env.clock, pages);
  server.failFrom = { page: script.failFromPage, status };
  const c = env.collector(server.fetchImpl);
  const t0 = env.clock.now();
  const r = await c.run({ maxPages: 5, windowStartUTC: "2026-10-21T00:00:00.000Z" });
  // (a) pages 1-2 imported, cursor committed after page 2
  expect(r.status).toBe("auth_blocked");
  expect(r.pagesCommitted).toBe(2);
  const cp = await c.checkpoint();
  expect(cp.pagesCommitted).toBe(2);
  expect(cp.cursor).toEqual({
    lastDepositAddress: (pages[1]!.at(-1) as { depositAddress: string }).depositAddress,
    lastDepositMemo: (pages[1]!.at(-1) as { depositMemo: string | null }).depositMemo ?? "",
  });
  // (b) one confirmation retry, then circuit open
  expect(server.requests.filter((q) => q.status === status)).toHaveLength(2);
  expect(c.breaker.state).toBe("open");
  // (c) degraded / unavailable, no facts for pages 3-5, no zero aggregates
  const h = await c.health();
  expect(h.health).toBe("degraded");
  expect(h.watermarkState).toBe("unavailable");
  expect((await c.watermark()).state).toBe("unavailable");
  const have = await env.tdb.db.query<{ swap_key: string }>("SELECT swap_key FROM ingestion.explorer_swaps");
  expect(have.rowCount).toBe(10);
  const later = new Set(keysOf(pages.slice(2)));
  expect(have.rows.some((x) => later.has(x.swap_key))).toBe(false);
  expect((await env.tdb.db.query("SELECT 1 FROM ingestion.source_coverage")).rowCount).toBe(0);
  const gap = await env.tdb.db.query<{ state: string; reason_code: string }>(
    "SELECT state, reason_code FROM ingestion.quality_gaps",
  );
  expect(gap.rows).toEqual([{ state: "unavailable", reason_code: "AUTH_REJECTED" }]);
  // (d) blocker draft
  const draft = r.blocker!;
  expect(draft).toMatchObject({ reason_code: "AUTH_REJECTED", retryability: "human_action_needed" });
  expect(JSON.parse(draft.last_checkpoint!)).toEqual(cp.cursor);
  const onDisk = JSON.parse(readFileSync(draft.path!, "utf8")) as Record<string, unknown>;
  expect(onDisk.reason_code).toBe("AUTH_REJECTED");
  expect(JSON.stringify(onDisk)).not.toContain(env.jwt);

  // 120 s of simulated time: supervisor retries every 10 s; a restarted collector must still see the open circuit
  for (let i = 0; i < 12; i++) {
    env.clock.advance(10_000);
    const again = env.collector(server.fetchImpl); // fresh instance => breaker state restored from Postgres
    await again.run({ maxPages: 5 });
  }
  const rejected = server.requests.filter((q) => q.status === status && q.atMs - t0 <= 120_000);
  expect(rejected.length).toBeLessThanOrEqual(3);
  expect(rejected.length).toBeGreaterThanOrEqual(2);
  const timeline = server.requests.map((q) => ({
    tOffsetS: Math.round((q.atMs - t0) / 1000),
    status: q.status,
  }));
  const transitions = c.breaker.transitions.map((t) => `${t.from}->${t.to}`);
  const stillBlocked = await explorerImportChecksum(env.tdb.db);
  expect(stillBlocked.count).toBe(10);

  // restore, wait for the half-open window, probe succeeds and import resumes from the committed cursor
  server.failFrom = null;
  env.clock.advance(125_000);
  const resumed = await env.collector(server.fetchImpl).run({ maxPages: 5 });
  expect(resumed.status).toBe("complete");
  const final = await explorerImportChecksum(env.tdb.db);
  expect(final.count).toBe(25);
  expect(final.checksum).toBe(cleanCk.checksum); // (e) equals a clean import, no duplicates
  const dup = await env.tdb.db.query<{ n: string }>(
    "SELECT count(*) - count(DISTINCT swap_key) AS n FROM ingestion.explorer_swaps",
  );
  expect(Number(dup.rows[0]?.n)).toBe(0);
  const hAfter = await env.collector(server.fetchImpl).health();
  expect(hAfter.health).toBe("healthy");
  expect(hAfter.watermarkState).not.toBe("unavailable");

  return {
    observed: `HTTP ${status}: pages 1-2 imported (cursor committed at page 2), 1 confirmation retry then circuit open; ${rejected.length} rejected requests within 120 s (cap 3); degraded/unavailable, 0 facts for pages 3-5, no zero rows; blocker AUTH_REJECTED/human_action_needed with last_checkpoint; half-open probe succeeded after restore and ${final.count} swaps equal the clean checksum`,
    evidence: {
      variantStatus: status,
      requestTimeline: timeline,
      circuitTransitions: transitions,
      rejectedRequestsIn120s: rejected.length,
      blocker: { ...draft, path: undefined },
      healthAfterFailure: h,
      resumeChecksum: final.checksum,
      cleanChecksum: cleanCk.checksum,
    },
  };
}

it("401 and 403 mid-run both stop safely, never storm, emit a blocker draft and recover to the clean checksum", async () => {
  const a = await scenario(401);
  const b = await scenario(403);
  observe({
    testId: "D18",
    observed: `${a.observed} || ${b.observed}`,
    fixtureHash: fixtureHash(ID),
    evidence: { "401": a.evidence, "403": b.evidence },
  });
}, 120_000);
