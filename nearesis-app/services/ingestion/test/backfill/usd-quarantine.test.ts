import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLiveCh, ensureDatabase, migrateLive } from "../../src/backfill/ch.ts";
import { openLivePg, tempName } from "../../src/backfill/env.ts";
import { refreshExplorerCoverage } from "../../src/backfill/explorer-coverage.ts";
import {
  findImplausibleUsdSwaps,
  recordUsdQuarantine,
  USD_IMPLAUSIBLE_THRESHOLD_USD,
  usdImplausibleCode,
} from "../../src/backfill/usd-quarantine.ts";
import type { Db } from "../../src/db.ts";

describe("USD_IMPLAUSIBLE quarantine (disposable ClickHouse + Postgres)", () => {
  const chName = `nearesis_t_a13_q${Date.now().toString(36)}`;
  const pgName = tempName();
  let ch: ReturnType<typeof createLiveCh>;
  let db: Db;
  beforeAll(async () => {
    await ensureDatabase(chName);
    ch = createLiveCh(chName);
    await migrateLive(ch);
    ({ db } = await openLivePg(pgName));
  });
  afterAll(async () => {
    await ch.close();
    const admin = createLiveCh("nearesis_live");
    await admin.command({ query: `DROP DATABASE IF EXISTS ${chName}` });
    await admin.close();
    await db.pool.end();
  });
  const row = (key: string, day: string, status: string, usd: string | null) => ({
    swap_key: key,
    created_at: `${day} 10:00:00.123`,
    created_day: day,
    status,
    amount_in_usd: usd,
    amount_out_usd: usd,
    version: 1,
    fetched_at: `${day} 10:00:00.000`,
  });

  it("finds only values above the threshold, records them as partial gaps without the swap key, and keeps coverage and rows", async () => {
    await ch.insert({
      table: "intents_swaps",
      values: [
        row("k1|", "2026-07-27", "SUCCESS", "3086349.3086"),
        row("k2|", "2026-07-28", "REFUNDED", "29988690000000"),
        row("k3|", "2026-07-28", "SUCCESS", "12.5"),
        row("k4|", "2026-07-29", "SUCCESS", null),
        row("k5|", "2026-07-30", "SUCCESS", "1"),
      ],
      format: "JSONEachRow",
      clickhouse_settings: { input_format_defaults_for_omitted_fields: 1 },
    });
    expect(USD_IMPLAUSIBLE_THRESHOLD_USD).toBe(1_000_000_000);
    const found = await findImplausibleUsdSwaps(ch);
    expect(found.map((s) => [s.swapKey, s.status, s.createdAt])).toEqual([
      ["k2|", "REFUNDED", "2026-07-28T10:00:00.123Z"],
    ]);
    expect(await recordUsdQuarantine(db, ch, found, 5)).toBe(1);
    await recordUsdQuarantine(db, ch, found, 6); // idempotent
    const gaps = (await (
      await ch.query({
        query: "SELECT state, reason_code, toString(from_utc) f FROM quality_gaps FINAL",
        format: "JSONEachRow",
      })
    ).json()) as Array<{ state: string; reason_code: string; f: string }>;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ state: "partial", reason_code: usdImplausibleCode("k2|") });
    expect(gaps[0]!.reason_code).not.toContain("k2");
    const pgRows = await db.query("SELECT reason_code FROM ingestion.quality_gaps");
    expect(pgRows.rows).toHaveLength(1);
    // the swap itself is untouched (still counted), and the quarantine does not turn the whole day partial
    const n = (await (
      await ch.query({ query: "SELECT count() c FROM intents_swaps FINAL", format: "JSONEachRow" })
    ).json()) as Array<{ c: string }>;
    expect(Number(n[0]!.c)).toBe(5);
    await refreshExplorerCoverage(ch, 10);
    const cov = (await (
      await ch.query({
        query: "SELECT toString(day) d, state, reason FROM source_coverage FINAL WHERE day = '2026-07-28'",
        format: "JSONEachRow",
      })
    ).json()) as Array<{ d: string; state: string; reason: string | null }>;
    expect(cov).toEqual([{ d: "2026-07-28", state: "complete", reason: null }]);
  });
});
