/**
 * Coverage integrity of the live Explorer swap table: a day the coverage ledger calls `complete` must hold swaps.
 * The semantic layer zero-fills complete days (zeroPolicy zero_requires_complete_coverage), so a "complete" day with no rows
 * is reported to users as ZERO swaps. Real volume is ~12k-30k swaps/day. Read-only.
 */
import { afterAll, expect, it } from "vitest";
import { liveCh, queryRows } from "./lib.ts";

const ch = liveCh();
afterAll(async () => ch.close());

it("no day marked complete in source_coverage (near-explorer intents_swaps) is empty or implausibly thin", async () => {
  const rows = await queryRows<{ d: string; n: string }>(
    ch,
    `SELECT toString(c.day) AS d, toString(ifNull(r.n, 0)) AS n
     FROM (SELECT day FROM source_coverage FINAL WHERE provider_id = 'near-explorer' AND dataset = 'intents_swaps' AND state = 'complete') AS c
     LEFT JOIN (SELECT created_day AS day, count() AS n FROM intents_swaps FINAL GROUP BY day) AS r ON r.day = c.day
     WHERE ifNull(r.n, 0) < 1000 ORDER BY c.day`,
  );
  expect(
    rows,
    `complete days with fewer than 1000 swaps: ${rows.map((r) => `${r.d}=${r.n}`).join(", ")}`,
  ).toEqual([]);
});
