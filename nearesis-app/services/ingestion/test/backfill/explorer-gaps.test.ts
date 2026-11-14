import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cursorJumpCode, findExplorerCursorJumps, refetchWindow } from "../../src/backfill/explorer-gaps.ts";
import { openLivePg, tempName } from "../../src/backfill/env.ts";
import type { Db } from "../../src/db.ts";

describe("findExplorerCursorJumps (disposable Postgres database)", () => {
  const name = tempName();
  let db: Db;
  beforeAll(async () => {
    ({ db } = await openLivePg(name));
  });
  afterAll(async () => {
    await db.pool.end();
    const { db: admin } = await openLivePg("nearesis_live");
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
    await admin.pool.end();
  });
  const page = async (hash: string, before: string, after: string, hi: string, lo: string) => {
    await db.query(
      `INSERT INTO ingestion.raw_observations(provider_id, request_fingerprint, payload_object_hash, fetched_at, envelope)
       VALUES ('near-explorer', $1, $1, now(), $2::jsonb)`,
      [hash, JSON.stringify({ cursorBefore: before, cursorAfter: after })],
    );
    for (const [i, t] of [hi, lo].entries())
      await db.query(
        `INSERT INTO ingestion.explorer_swaps(swap_key, status, created_at, raw_object_hash, version_ms, record)
         VALUES ($1, 'SUCCESS', $2, $3, 1, '{}'::jsonb)`,
        [`${hash}-${i}`, t, hash],
      );
  };
  it("flags a backwards jump of 21 days between linked pages, not an ordinary page step", async () => {
    await page("aaaa1111aaaa1111", "c0", "c1", "2026-04-23T13:00:00Z", "2026-04-23T12:13:45Z");
    await page("bbbb2222bbbb2222", "c1", "c2", "2026-04-02T02:50:59Z", "2026-04-02T00:37:28Z");
    await page("cccc3333cccc3333", "c2", "c3", "2026-04-02T00:30:00Z", "2026-04-01T22:17:53Z");
    // a forward-collector page (ascending chain) and an unlinked page are never jumps
    await page("dddd4444dddd4444", "f0", "f1", "2026-11-12T10:00:00Z", "2026-11-12T09:00:00Z");
    await page("eeee5555eeee5555", "f1", "f2", "2026-11-12T12:00:00Z", "2026-11-12T11:00:00Z");
    const j = await findExplorerCursorJumps(db);
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({
      prevPageHash: "aaaa1111aaaa1111",
      nextPageHash: "bbbb2222bbbb2222",
      fromUTC: "2026-04-02T02:50:59.000Z",
      toUTC: "2026-04-23T12:13:45.000Z",
      refetchFromDay: "2026-04-02",
      refetchToDay: "2026-04-23",
    });
    expect(cursorJumpCode(j[0]!)).toBe("EXPLORER_CURSOR_JUMP:aaaa1111aaaa:bbbb2222bbbb");
    expect(refetchWindow(j[0]!)).toEqual({
      startUnix: Date.parse("2026-04-02T00:00:00Z") / 1000 - 1,
      endUnix: Date.parse("2026-04-24T00:00:00Z") / 1000,
      streamKey: "transactions:refetch:2026-04-02:2026-04-23",
    });
  });
});
