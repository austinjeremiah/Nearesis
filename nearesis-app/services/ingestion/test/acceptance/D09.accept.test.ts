import { observe } from "@nearesis/acceptance";
import { fixtureHash } from "@nearesis/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ExplorerFixtureServer } from "../../src/testing/servers.ts";
import { explorerBundleFromDb } from "../../src/live-bundle.ts";
import { normalize } from "../../src/normalize.ts";
import { loadPages, setupEnv, type TestEnv } from "../helpers/env.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
}, 60_000);
afterAll(async () => env.close(), 60_000);

const ID = "fx.explorer.private-era";

// D09: Private settlement era -> non-public swap hash not fabricated or counted exact
it("treats nearTxHashes from 2026-10-27 as boundary hashes and never counts private swaps as exact", async () => {
  const pages = loadPages(ID);
  const server = new ExplorerFixtureServer(env.clock, pages);
  await env.collector(server.fetchImpl, { pageSize: 10 }).run();
  const n = normalize(
    await explorerBundleFromDb(env.tdb.db, "SYNTHETIC", Date.parse("2026-11-10T00:00:00Z")),
  );
  const rows = n.tables.intents_swaps;
  const priv = rows.filter((r) => r.privacyEra === "private_settlement");
  const pub = rows.filter((r) => r.privacyEra === "public");
  expect(priv).toHaveLength(3);
  expect(pub).toHaveLength(3);
  for (const r of priv) {
    expect(r.createdAtUTC >= "2026-10-27T00:00:00.000Z").toBe(true);
    expect(r.publicSwapTxHashes).toEqual([]); // no fabricated swap hash
    expect(r.boundaryTxHashes.length).toBe(1);
    expect(r.reconciliationLevel).toBe("boundary_indicated");
    expect(r.reconciliationLevel).not.toBe("exact_public");
  }
  for (const r of pub) {
    expect(r.reconciliationLevel).toBe("exact_public");
    expect(r.publicSwapTxHashes.length).toBe(1);
    expect(r.boundaryTxHashes).toEqual([]);
  }
  const exact = rows.filter((r) => r.reconciliationLevel === "exact_public");
  expect(exact).toHaveLength(3);
  const allPublicHashes = new Set(rows.flatMap((r) => r.publicSwapTxHashes));
  expect(priv.flatMap((r) => r.boundaryTxHashes).some((h) => allPublicHashes.has(h))).toBe(false);
  // boundary instant
  expect(Math.min(...priv.map((r) => Date.parse(r.createdAtUTC)))).toBeGreaterThanOrEqual(
    Date.parse("2026-10-27T00:00:00Z"),
  );
  expect(Math.max(...pub.map((r) => Date.parse(r.createdAtUTC)))).toBeLessThan(
    Date.parse("2026-10-27T00:00:00Z"),
  );
  observe({
    testId: "D09",
    observed: `3 public-era swaps exact_public with swap hashes; 3 private-era swaps (>= 2026-10-27T00:00Z) boundary_indicated, publicSwapTxHashes empty, boundary hashes disjoint from swap hashes; exact count = ${exact.length}`,
    fixtureHash: fixtureHash(ID),
    evidence: {
      privateRows: priv.length,
      publicRows: pub.length,
      exactCount: exact.length,
      privateExactCount: 0,
    },
  });
}, 60_000);
