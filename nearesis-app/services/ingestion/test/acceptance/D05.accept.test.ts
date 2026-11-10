import { observe } from "@nearesis/acceptance";
import { fixtureHash, readFixtureJson } from "@nearesis/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ExplorerDayServer } from "../../src/testing/servers.ts";
import { normalize } from "../../src/normalize.ts";
import { explorerBundleFromDb } from "../../src/live-bundle.ts";
import { replay } from "../../src/replay.ts";
import { setupEnv, type TestEnv } from "../helpers/env.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
}, 60_000);
afterAll(async () => env.close(), 60_000);

const ID = "fx.semantic.zero-vs-gap";

// D05: Missing day response -> gap flagged unknown, not zero swap
it("flags a day the provider never answered as unavailable, distinct from a confirmed zero and a partial day", async () => {
  const snap = readFixtureJson<{
    explorer: {
      streams: Array<{ days: Array<{ day: string; pages: Array<{ file: string | null; status: number }> }> }>;
    };
  }>(ID, "snapshot.json");
  const days = snap.explorer.streams[0]!.days;
  const served: Record<string, Array<{ status: number; items: Record<string, unknown>[] | null }>> = {};
  for (const d of days)
    served[d.day] = d.pages.map((p) => ({
      status: p.status,
      items: p.file ? readFixtureJson<Record<string, unknown>[]>(ID, p.file) : null,
    }));
  const server = new ExplorerDayServer(env.clock, served);
  const c = env.collector(server.fetchImpl, { maxTransientRetries: 1 });
  const result = await c.collectDays(days.map((d) => d.day));
  const by = Object.fromEntries(result.map((r) => [r.day, r]));

  expect(by["2026-10-03"]).toMatchObject({ state: "complete", rows: 0 }); // confirmed zero (200 [])
  expect(by["2026-10-06"]).toMatchObject({ state: "unavailable", rows: 0, reason: "PROVIDER_GAP" }); // gap, NOT zero
  expect(by["2026-10-09"]?.state).toBe("partial");
  expect(result.filter((r) => r.state === "complete").length).toBe(8);

  // no fact rows and no zero-valued aggregate for the gap day
  const gapRows = await env.tdb.db.query<{ n: string }>(
    "SELECT count(*) n FROM ingestion.explorer_swaps WHERE created_at >= '2026-10-06' AND created_at < '2026-10-07'",
  );
  expect(Number(gapRows.rows[0]?.n)).toBe(0);
  const cov = await env.tdb.db.query<{ day: string; state: string; observed_rows: number | null }>(
    "SELECT to_char(day,'YYYY-MM-DD') AS day, state, observed_rows FROM ingestion.source_coverage ORDER BY day",
  );
  const gapCov = cov.rows.find((r) => r.day === "2026-10-06")!;
  expect(gapCov.state).toBe("unavailable");
  expect(gapCov.observed_rows).toBeNull(); // unknown, not 0
  expect(cov.rows.find((r) => r.day === "2026-10-03")?.observed_rows).toBe(0);
  const gaps = await env.tdb.db.query<{ reason_code: string; state: string }>(
    "SELECT reason_code, state FROM ingestion.quality_gaps ORDER BY from_utc",
  );
  expect(gaps.rows.map((g) => g.state)).toEqual(["unavailable", "partial"]);

  // normalizer keeps the distinction and agrees with the recorded snapshot expectation
  const n = normalize(
    await explorerBundleFromDb(env.tdb.db, "SYNTHETIC", Date.parse("2026-10-22T00:00:00Z")),
  );
  const nCov = Object.fromEntries(n.tables.source_coverage.map((r) => [r.day, r.state]));
  expect(nCov["2026-10-06"]).toBe("unavailable");
  expect(n.tables.intents_swaps.every((s) => s.createdDay !== "2026-10-06")).toBe(true);
  const replayed = await replay(ID);
  const rCov = Object.fromEntries(replayed.tables.source_coverage.map((r) => [r.day, r.state]));
  expect(rCov).toEqual(nCov);
  const expected = readFixtureJson<{ coverage: Record<string, string> }>(ID, "expected.json").coverage;
  for (const [d, e] of Object.entries(expected)) expect(rCov[d]).toBe(e.split(" ")[0]);

  observe({
    testId: "D05",
    observed: `10 days: ${result.filter((r) => r.state === "complete").length} complete (incl. 2026-10-03 confirmed zero, observed_rows=0), 2026-10-06 unavailable (observed_rows NULL, 0 fact rows, quality gap PROVIDER_GAP), 2026-10-09 partial; replay snapshot agrees`,
    fixtureHash: fixtureHash(ID),
    evidence: { coverage: cov.rows, qualityGaps: gaps.rows, normalizedCoverage: nCov },
  });
}, 120_000);
