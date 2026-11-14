import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, createCh } from "@nearesis/analytics";
import { rowRates } from "../../src/coverage.ts";
import { estimateRows } from "../../src/gateway.ts";

const db = `nearesis_t_a11_${Date.now().toString(36)}`;
const url = process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123";
const auth = {
  url,
  username: process.env.NEARESIS_CH_USER ?? "nearesis",
  password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
};
const admin = createCh({ ...auth, database: "default" });
const ch = createCh({ ...auth, database: db });
const ins = (table: string, values: object[]) =>
  ch.insert({
    table,
    values,
    format: "JSONEachRow",
    clickhouse_settings: {
      input_format_defaults_for_omitted_fields: 1,
      date_time_input_format: "best_effort",
    },
  });
const swap = (key: string, day: string, version: number) => ({
  swap_key: key,
  created_at: `${day} 10:00:00`,
  created_day: day,
  fetched_at: `${day} 10:00:00`,
  version,
});
const cov = (provider: string, dataset: string, day: string, state: string) => ({
  provider_id: provider,
  dataset,
  day,
  state,
  reason: null,
  source_label: "LIVE",
  version: 1,
});

beforeAll(async () => {
  await admin.command({ query: `CREATE DATABASE ${db}` });
  await migrate(ch);
});
afterAll(async () => {
  await ch.close();
  await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
  await admin.close();
});

describe("rowRates (cost-gate estimator)", () => {
  it("a fact table with no coverage rows is UNKNOWN, not 'the whole table in one day'", async () => {
    await ins(
      "intents_swaps",
      Array.from({ length: 50 }, (_, i) => swap(`a${i}`, "2026-05-01", 1)),
    );
    const r = await rowRates(ch, ["near-explorer:intents_swaps"]);
    expect(r.unknown).toEqual(["near-explorer:intents_swaps"]);
    expect(r.perDay).toEqual({});
  });

  it("with coverage, rows/day counts CURRENT rows: re-derived versions are not double counted", async () => {
    // same 50 keys re-derived at version 2 (ReplacingMergeTree keeps both parts until merged)
    await ins(
      "intents_swaps",
      Array.from({ length: 50 }, (_, i) => swap(`a${i}`, "2026-05-01", 2)),
    );
    await ins(
      "intents_swaps",
      Array.from({ length: 50 }, (_, i) => swap(`b${i}`, "2026-05-02", 1)),
    );
    await ins("source_coverage", [
      cov("near-explorer", "intents_swaps", "2026-05-01", "partial"),
      cov("near-explorer", "intents_swaps", "2026-05-02", "complete"),
      cov("near-explorer", "intents_swaps", "2026-05-03", "unavailable"),
    ]);
    const raw = await ch.query({ query: "SELECT count() AS n FROM intents_swaps", format: "JSONEachRow" });
    expect(Number(((await raw.json()) as Array<{ n: string }>)[0]!.n)).toBeGreaterThanOrEqual(100); // 150 unless merged
    const r = await rowRates(ch, ["near-explorer:intents_swaps"]);
    expect(r.unknown).toEqual([]);
    // 100 current rows over 2 loaded days (the unavailable day is not a loaded day)
    expect(r.perDay["near-explorer:intents_swaps"]).toBe(50);
    expect(estimateRows(r.perDay, 200)).toBe(10_000);
  });

  it("non-fact-table sources keep the unit rate", async () => {
    const r = await rowRates(ch, ["x:not_a_table"]);
    expect(r).toEqual({ perDay: { "x:not_a_table": 1 }, unknown: [] });
  });
});
