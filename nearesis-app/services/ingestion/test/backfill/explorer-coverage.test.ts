import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLiveCh,
  ensureDatabase,
  insertLive,
  migrateLive,
  coverageRows,
} from "../../src/backfill/ch.ts";
import { explorerCoverageDays, refreshExplorerCoverage } from "../../src/backfill/explorer-coverage.ts";

describe("explorerCoverageDays (pure)", () => {
  it("marks edges partial, the interior complete and gap days partial with the reason", () => {
    const d = explorerCoverageDays({
      minDay: "2026-07-21",
      maxDay: "2026-07-26",
      gaps: [{ from: "2026-07-23T12:11:27", to: "2026-07-23T13:02:50", reasonCode: "QUARANTINED_PAGE:abc" }],
    });
    expect(d.map((x) => [x.day, x.state, x.reason])).toEqual([
      ["2026-07-21", "partial", "OLDEST_EDGE_DAY"],
      ["2026-07-22", "complete", null],
      ["2026-07-23", "partial", "QUARANTINED_PAGE"],
      ["2026-07-24", "complete", null],
      ["2026-07-25", "complete", null],
      ["2026-07-26", "partial", "STILL_FILLING"],
    ]);
  });
  it("a gap spanning several days marks each; a finished window makes the oldest day complete", () => {
    const d = explorerCoverageDays({
      minDay: "2026-01-01",
      maxDay: "2026-01-04",
      windowFrom: "2026-01-01",
      gaps: [{ from: "2026-01-02T23:00:00", to: "2026-01-03T01:00:00", reasonCode: "AUTH_REJECTED" }],
    });
    expect(d.map((x) => x.state)).toEqual(["complete", "partial", "partial", "partial"]);
  });
});

describe("explorerCoverageDays: a day with no loaded swap is never complete without provider evidence", () => {
  const swapDays = (ds: string[]) => new Set(ds);
  const base = { minDay: "2026-04-01", maxDay: "2026-04-08", windowFrom: "2026-04-01", gaps: [] };
  it("an interior hole (cursor jump) is partial NO_SWAPS_LOADED and its neighbours are partial too", () => {
    const d = explorerCoverageDays({
      ...base,
      swapDays: swapDays([
        "2026-04-01",
        "2026-04-02",
        "2026-04-05",
        "2026-04-06",
        "2026-04-07",
        "2026-04-08",
      ]),
    });
    expect(d.map((x) => [x.day, x.state, x.reason])).toEqual([
      ["2026-04-01", "complete", null],
      ["2026-04-02", "partial", "ADJACENT_TO_EMPTY_DAYS"],
      ["2026-04-03", "partial", "NO_SWAPS_LOADED"],
      ["2026-04-04", "partial", "NO_SWAPS_LOADED"],
      ["2026-04-05", "partial", "ADJACENT_TO_EMPTY_DAYS"],
      ["2026-04-06", "complete", null],
      ["2026-04-07", "complete", null],
      ["2026-04-08", "partial", "STILL_FILLING"],
    ]);
  });
  it("days the provider confirmed empty are complete (zero swaps), and stop making their neighbours partial", () => {
    const d = explorerCoverageDays({
      ...base,
      swapDays: swapDays([
        "2026-04-01",
        "2026-04-02",
        "2026-04-05",
        "2026-04-06",
        "2026-04-07",
        "2026-04-08",
      ]),
      confirmedEmptyDays: swapDays(["2026-04-03", "2026-04-04"]),
    });
    expect(d.map((x) => [x.day, x.state, x.reason]).slice(1, 5)).toEqual([
      ["2026-04-02", "complete", null],
      ["2026-04-03", "complete", "PROVIDER_EMPTY_CONFIRMED"],
      ["2026-04-04", "complete", "PROVIDER_EMPTY_CONFIRMED"],
      ["2026-04-05", "complete", null],
    ]);
  });
});

describe("refreshExplorerCoverage (disposable ClickHouse database)", () => {
  const db = `nearesis_t_a13_cov${Date.now().toString(36)}`;
  let ch: ReturnType<typeof createLiveCh>;
  beforeAll(async () => {
    await ensureDatabase(db);
    ch = createLiveCh(db);
    await migrateLive(ch);
  });
  afterAll(async () => {
    await ch.close();
    const admin = createLiveCh("nearesis_live");
    await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
    await admin.close();
  });
  const swap = (key: string, day: string, version: number) => ({
    swap_key: key,
    created_at: `${day} 10:00:00.000`,
    created_day: day,
    version,
    fetched_at: `${day} 10:00:00.000`,
    status: "SUCCESS",
  });
  const states = async () =>
    (
      (await (
        await ch.query({
          query:
            "SELECT toString(day) d, state, reason FROM source_coverage FINAL WHERE provider_id='near-explorer' AND dataset='intents_swaps' ORDER BY day",
          format: "JSONEachRow",
        })
      ).json()) as Array<{ d: string; state: string; reason: string | null }>
    ).map((r) => `${r.d}:${r.state}:${r.reason ?? ""}`);

  it("writes nothing for an empty table, then honest rows idempotently", async () => {
    expect(await refreshExplorerCoverage(ch, 1)).toBe(0);
    await ch.insert({
      table: "intents_swaps",
      values: ["2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"].map((d, i) => swap(`k${i}`, d, 1)),
      format: "JSONEachRow",
      clickhouse_settings: { input_format_defaults_for_omitted_fields: 1 },
    });
    await insertLive(ch, "quality_gaps", [
      {
        provider_id: "near-explorer",
        dataset: "intents_swaps",
        from_utc: "2026-07-22T12:00:00.000Z",
        to_utc: "2026-07-22T13:00:00.000Z",
        state: "unavailable",
        reason_code: "QUARANTINED_PAGE:h1",
        source_label: "LIVE",
        version: 1,
      },
    ]);
    expect(await refreshExplorerCoverage(ch, 10)).toBe(4);
    expect(await states()).toEqual([
      "2026-07-21:partial:OLDEST_EDGE_DAY",
      "2026-07-22:partial:QUARANTINED_PAGE",
      "2026-07-23:complete:",
      "2026-07-24:partial:STILL_FILLING",
    ]);
    // idempotent: nothing changed, nothing written
    expect(await refreshExplorerCoverage(ch, 20)).toBe(0);
    // the loader advances: only the days whose state changes are rewritten
    await ch.insert({
      table: "intents_swaps",
      values: [swap("k9", "2026-07-25", 1)],
      format: "JSONEachRow",
      clickhouse_settings: { input_format_defaults_for_omitted_fields: 1 },
    });
    expect(await refreshExplorerCoverage(ch, 30)).toBe(2);
    expect((await states()).slice(-2)).toEqual(["2026-07-24:complete:", "2026-07-25:partial:STILL_FILLING"]);
    // unrelated datasets are untouched
    await insertLive(
      ch,
      "source_coverage",
      coverageRows([
        {
          provider_id: "coingecko",
          dataset: "price_candles",
          day: "2026-07-21",
          state: "complete",
          reason: null,
          version: 1,
        },
      ]),
    );
    expect(await refreshExplorerCoverage(ch, 40)).toBe(0);
  });

  it("a hole inside the loaded range is partial, becomes complete once the days are loaded, and a confirmed-empty day survives refreshes", async () => {
    await ch.command({ query: "TRUNCATE TABLE intents_swaps" });
    await ch.command({ query: "TRUNCATE TABLE source_coverage" });
    const put = (rows: ReturnType<typeof swap>[]) =>
      ch.insert({
        table: "intents_swaps",
        values: rows,
        format: "JSONEachRow",
        clickhouse_settings: { input_format_defaults_for_omitted_fields: 1 },
      });
    await put(
      ["2026-08-01", "2026-08-02", "2026-08-06", "2026-08-07", "2026-08-08"].map((d, i) =>
        swap(`h${i}`, d, 1),
      ),
    );
    await refreshExplorerCoverage(ch, 100);
    expect(await states()).toEqual([
      "2026-08-01:partial:OLDEST_EDGE_DAY",
      "2026-08-02:partial:ADJACENT_TO_EMPTY_DAYS",
      "2026-08-03:partial:NO_SWAPS_LOADED",
      "2026-08-04:partial:NO_SWAPS_LOADED",
      "2026-08-05:partial:NO_SWAPS_LOADED",
      "2026-08-06:partial:ADJACENT_TO_EMPTY_DAYS",
      "2026-08-07:complete:",
      "2026-08-08:partial:STILL_FILLING",
    ]);
    // the refetch tool proves 08-04 empty at the provider; 08-03 and 08-05 get loaded
    await insertLive(
      ch,
      "source_coverage",
      coverageRows([
        {
          provider_id: "near-explorer",
          dataset: "intents_swaps",
          day: "2026-08-04",
          state: "complete",
          reason: "PROVIDER_EMPTY_CONFIRMED",
          version: 200,
        },
      ]),
    );
    await put(["2026-08-03", "2026-08-05"].map((d, i) => swap(`r${i}`, d, 2)));
    await refreshExplorerCoverage(ch, 300);
    expect((await states()).slice(1, 7)).toEqual([
      "2026-08-02:complete:",
      "2026-08-03:complete:",
      "2026-08-04:complete:PROVIDER_EMPTY_CONFIRMED",
      "2026-08-05:complete:",
      "2026-08-06:complete:",
      "2026-08-07:complete:",
    ]);
    expect(await refreshExplorerCoverage(ch, 400)).toBe(0);
  });
});
