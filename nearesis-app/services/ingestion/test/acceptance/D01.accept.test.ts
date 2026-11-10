import { observe } from "@nearesis/acceptance";
import { fixtureHash } from "@nearesis/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ExplorerFixtureServer } from "../../src/testing/servers.ts";
import { explorerImportChecksum } from "../../src/adapters/explorer.ts";
import { keysOf, loadPages, setupEnv, type TestEnv } from "../helpers/env.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
}, 60_000);
afterAll(async () => env.close(), 60_000);

// D01: Explorer multi-page fixture -> all unique stable IDs imported exactly once
it("imports every unique stable ID exactly once across a multi-page cursor walk", async () => {
  const pages = loadPages("fx.explorer.pages-3");
  const expectedKeys = keysOf(pages);
  expect(new Set(expectedKeys).size).toBe(expectedKeys.length);
  const server = new ExplorerFixtureServer(env.clock, pages);
  const c = env.collector(server.fetchImpl);
  const r = await c.run();
  expect(r.status).toBe("complete");
  expect(r.pagesCommitted).toBe(3);

  const rows = await env.tdb.db.query<{ swap_key: string }>(
    "SELECT swap_key FROM ingestion.explorer_swaps ORDER BY swap_key",
  );
  expect(rows.rows.map((x) => x.swap_key).sort()).toEqual([...expectedKeys].sort());
  expect(r.swapsInserted).toBe(expectedKeys.length);

  // The stable identity includes the memo: swaps with a memo must carry it in the key.
  expect(rows.rows.some((x) => /\|memo-/.test(x.swap_key))).toBe(true);

  // Cursor was sent as lastDepositAddress/lastDepositMemo with direction=next, size <= 1000.
  const q2 = server.requests[1]?.query ?? {};
  expect(q2.direction).toBe("next");
  expect(Number(q2.numberOfTransactions)).toBeLessThanOrEqual(1000);
  expect(q2.lastDepositAddress).toBe((pages[0]!.at(-1) as { depositAddress: string }).depositAddress);

  // Re-delivering everything (cursor reset) imports nothing twice.
  await env.tdb.db.query("DELETE FROM ingestion.cursor_state");
  const again = await env.collector(server.fetchImpl).run();
  expect(again.swapsInserted).toBe(0);
  expect(again.duplicatesSkipped).toBe(expectedKeys.length);
  const count = await env.tdb.db.query<{ n: string }>("SELECT count(*) n FROM ingestion.explorer_swaps");
  expect(Number(count.rows[0]?.n)).toBe(expectedKeys.length);
  const ck = await explorerImportChecksum(env.tdb.db);

  observe({
    testId: "D01",
    observed: `${expectedKeys.length} unique stable IDs across ${r.pagesCommitted} pages imported once (rows=${count.rows[0]?.n}); cursor-reset re-run inserted 0 and skipped ${again.duplicatesSkipped} duplicates`,
    fixtureHash: fixtureHash("fx.explorer.pages-3"),
    evidence: {
      uniqueIds: expectedKeys.length,
      rowsInDb: Number(count.rows[0]?.n),
      firstRunInserted: r.swapsInserted,
      rerunInserted: again.swapsInserted,
      rerunSkipped: again.duplicatesSkipped,
      importChecksum: ck.checksum,
    },
  });
}, 60_000);
