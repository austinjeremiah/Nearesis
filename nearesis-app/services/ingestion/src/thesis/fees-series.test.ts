import { describe, expect, it } from "vitest";
import {
  buildIntents,
  buildTakeRate,
  buildTopReceivers,
  buildTotal,
  buildTxFees,
  collectBlocks,
  collectOutcomes,
  collectTx,
  crossCheck,
  deriveFootprint,
  divDecimal,
  headline,
  quarterOf,
  takeRateBps,
  usdOf,
  yoctoToNear,
  type Table,
} from "./fees-series.ts";
import { planFeesChunks, splitFeesChunk, outcomesSql, txSql, blocksSql, discoverySql } from "./fees-sql.ts";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import { KEEP_ACCOUNTS } from "./fees-footprint.ts";

const Y = 10n ** 24n;
const OUT_COLS = [
  "kind",
  "block_date",
  "account",
  "n",
  "gas",
  "tokens_yocto",
  "null_gas",
  "null_tokens",
  "fractional_gas",
  "day_rank",
];
const out = (rows: Array<Array<string | null>>): Table => ({ columns: OUT_COLS, data: rows });
const dayRow = (d: string, n: string, gas: string, tok: bigint) => [
  "day",
  d,
  null,
  n,
  gas,
  tok.toString(),
  "0",
  "0",
  "0",
  null,
];
const exRow = (d: string, a: string, n: string, gas: string, tok: bigint, rk: string) => [
  "ex",
  d,
  a,
  n,
  gas,
  tok.toString(),
  "0",
  "0",
  "0",
  rk,
];
const topRow = (a: string, n: string, gas: string, tok: bigint, rk: string) => [
  "top",
  null,
  a,
  n,
  gas,
  tok.toString(),
  null,
  null,
  null,
  rk,
];

describe("exact decimals", () => {
  it("prints yocto as exact NEAR", () => {
    expect(yoctoToNear("0")).toBe("0");
    expect(yoctoToNear("1")).toBe("0.000000000000000000000001");
    expect(yoctoToNear((12n * Y + Y / 2n).toString())).toBe("12.5");
    expect(yoctoToNear("1234567890123456789012345678")).toBe("1234.567890123456789012345678");
  });
  it("rounds half-even and keeps leading zeros", () => {
    expect(divDecimal(1n, 8n, 2)).toBe("0.12"); // 0.125 -> 0.12
    expect(divDecimal(3n, 8n, 2)).toBe("0.38"); // 0.375 -> 0.38
    expect(divDecimal(1n, 1000n, 4)).toBe("0.0010");
    expect(divDecimal(5n, 1n, 0)).toBe("5");
  });
  it("usd and take rate in basis points", () => {
    // 100 NEAR x 3 USD = 300 USD; volume 1,000,000 USD -> 3 bps
    expect(usdOf(100n * Y, "3")).toBe("300.000000");
    expect(takeRateBps(100n * Y, "3", "1000000")).toBe("3.00000000");
    // 0.5 NEAR x 1.5 USD / 250.5 USD
    expect(takeRateBps(Y / 2n, "1.5", "250.5")).toBe("29.94011976");
    expect(takeRateBps(Y, "1", "0")).toBeNull();
    expect(takeRateBps(Y, "1", "0.00")).toBeNull();
  });
  it("quarters", () => {
    expect(quarterOf("2025-11-10")).toBe("2025Q4");
    expect(quarterOf("2026-04-01")).toBe("2026Q2");
  });
});

describe("sql", () => {
  it("plans newest month first, blocks then outcomes then tx, and splits at the midpoint", () => {
    const plan = planFeesChunks();
    expect(plan[0]).toMatchObject({ family: "blocks", from: "2026-11-01", to: "2026-11-14" });
    expect(plan.at(-1)).toMatchObject({ family: "tx", from: "2025-11-10", to: "2025-12-01" });
    expect(plan.filter((c) => c.family === "outcomes")).toHaveLength(13);
    const halves = splitFeesChunk({
      id: "outcomes:2026-03-01",
      family: "outcomes",
      from: "2026-03-01",
      to: "2026-04-01",
    }) as NonNullable<ReturnType<typeof splitFeesChunk>>;
    expect(halves[0].to).toBe(halves[1].from);
    expect(halves[1].to).toBe("2026-04-01");
    expect(splitFeesChunk({ id: "x", family: "tx", from: "2026-03-01", to: "2026-03-02" })).toBeNull();
  });
  it("every generated query passes the static guard", () => {
    for (const c of planFeesChunks())
      assertGuardedSql(
        `${c.family === "outcomes" ? outcomesSql(c, KEEP_ACCOUNTS) : c.family === "tx" ? txSql(c, KEEP_ACCOUNTS) : blocksSql(c)}`,
      );
    assertGuardedSql(discoverySql("2026-05-13"));
  });
  it("rejects bad literals", () => {
    expect(() => outcomesSql({ from: "2026-01-01", to: "2026-01-02" }, ["x'; DROP TABLE y; --"])).toThrow();
    expect(() => blocksSql({ from: "2026-1-1", to: "2026-01-02" })).toThrow();
  });
});

const chunkA = {
  id: "outcomes:2026-05-01",
  from: "2026-05-01",
  to: "2026-05-03",
  table: out([
    dayRow("2026-05-01", "1000", "5000000", 100n * Y),
    dayRow("2026-05-02", "2000", "9000000", 200n * Y),
    exRow("2026-05-01", "intents.near", "10", "100", 2n * Y, "5"),
    exRow("2026-05-02", "intents.near", "20", "200", 4n * Y, "5"),
    exRow("2026-05-01", "eth.omft.near", "5", "50", 1n * Y, "9"),
    exRow("2026-05-01", "wrap.near", "100", "900", 10n * Y, "2"),
    exRow("2026-05-02", "wrap.near", "100", "900", 10n * Y, "2"),
    topRow("wrap.near", "200", "1800", 20n * Y, "1"),
    topRow("intents.near", "30", "300", 6n * Y, "2"),
    topRow("alice.near", "7", "70", 3n * Y, "3"),
  ]),
};
const chunkB = {
  id: "outcomes:2026-08-01",
  from: "2026-08-01",
  to: "2026-08-02",
  table: out([
    dayRow("2026-08-01", "10", "50", 10n * Y),
    exRow("2026-08-01", "intents.near", "1", "1", 1n * Y, "1"),
    topRow("intents.near", "1", "1", 1n * Y, "1"),
    topRow("bob.near", "1", "1", 5n * Y, "0"),
  ]),
};

describe("footprint and series", () => {
  const o = collectOutcomes([chunkA, chunkB]);
  const disc = (day: string, rows: Array<[string, bigint, number | null]>) => ({
    day,
    table: {
      columns: ["executor_account_id", "tokens_yocto", "gas", "outcomes", "transactions", "rank"],
      data: rows.map(([a, t, rk]) => [a, t.toString(), "1", "1", "1", rk === null ? null : String(rk)]),
    } as Table,
  });
  const fp = deriveFootprint(
    [
      disc("2026-05-01", [
        ["intents.near", 2n * Y, 1],
        ["eth.omft.near", 1n * Y, 2], // own burn 1 -> dependence 100%
        ["wrap.near", 2n * Y, 3], // own burn 10 -> dependence 20%: generic, excluded
        ["__all_executors__", 5n * Y, null],
      ]),
    ],
    o,
  );
  it("derives core and wide with the documented rule", () => {
    expect(fp.core).toEqual(["intents.near"]);
    expect(fp.wide).toEqual(["eth.omft.near", "intents.near"]);
    const wrap = fp.rows.find((r) => r.account === "wrap.near");
    expect(wrap?.inWide).toBe(false);
    expect(wrap?.reason).toMatch(/generic/);
    expect(fp.originTotalTokens).toBe(5n * Y);
  });
  it("rejects overlapping chunks", () => {
    expect(() => collectOutcomes([chunkA, chunkA])).toThrow(/duplicate/);
  });
  const blocks = collectBlocks([
    {
      columns: ["block_date", "blocks", "min_gas_price", "max_gas_price", "sum_gas_price", "null_price_rows"],
      data: [["2026-05-01", "4", "100000000", "100000001", "400000002", "0"]],
    },
  ]);
  const total = buildTotal(o, blocks);
  it("series 1: exact sums, gas price only where blocks exist, no zero fill", () => {
    expect(total.map((t) => t.d)).toEqual(["2026-05-01", "2026-05-02", "2026-08-01"]); // 05-03.. are absent, not zero
    expect(total[0]).toMatchObject({
      tokens_burnt_near: "100",
      avg_gas_price_yocto: "100000000.500",
      blocks: "4",
    });
    expect(total[1]?.avg_gas_price_yocto).toBeNull();
  });
  const intents = buildIntents(o, fp);
  it("series 2: narrow, wide and rank-cut accounting", () => {
    expect(intents[0]).toMatchObject({
      narrow_tokens_burnt_near: "2",
      wide_tokens_burnt_near: "3",
      wide_accounts_without_row: "0",
      narrow_share_of_total_pct: "2.000000",
      wide_share_of_total_pct: "3.000000",
    });
    expect(intents[1]).toMatchObject({
      narrow_tokens_burnt_near: "4",
      wide_tokens_burnt_near: "4",
      wide_accounts_without_row: "1",
    });
  });
  it("series 3: window and quarter ranking, lower-bound flag when absent from a chunk", () => {
    const rows = buildTopReceivers(o);
    const w = rows.filter((r) => r.scope === "window");
    expect(w[0]).toMatchObject({
      account: "wrap.near",
      rank: 1,
      tokens_burnt_near: "20",
      lower_bound_only: true,
    });
    const inter = w.find((r) => r.account === "intents.near");
    expect(inter).toMatchObject({ tokens_burnt_near: "7", lower_bound_only: false, chunks_present: "2" });
    expect(rows.some((r) => r.scope === "2026Q2" && r.account === "bob.near")).toBe(false);
    expect(rows.some((r) => r.scope === "2026Q3" && r.account === "bob.near")).toBe(true);
    // share uses only the days of the scope: window total = 100 + 200 + 10 NEAR
    expect(w[0]?.share_of_total_pct).toBe("6.451613");
  });
  it("series 4 and its reconciliation with series 2", () => {
    const tx = collectTx([
      {
        columns: [
          "kind",
          "block_date",
          "account",
          "txs",
          "conversion_gas",
          "conversion_tokens_yocto",
          "null_gas",
          "null_tokens",
          "day_rank",
        ],
        data: [
          ["day", "2026-05-01", null, "50", "1000", (5n * Y).toString(), "0", "0", null],
          ["rcv", "2026-05-01", "intents.near", "5", "100", (Y / 2n).toString(), "0", "0", "3"],
        ],
      },
    ]);
    const rows = buildTxFees(tx, new Map(intents.map((i) => [i.d, i])), fp);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      narrow_txs: "5",
      narrow_outcomes_per_tx: "2.0000",
      narrow_direct_toll_yocto: (2n * Y + Y / 2n).toString(),
      narrow_conversion_share_of_direct_pct: "20.000000",
    });
  });
  it("take rate: daily, 30 day ratio of sums, missing volume stays null", () => {
    const price = new Map<string, string | null>([
      ["2026-05-01", "2"],
      ["2026-05-02", "2"],
      ["2026-08-01", "4"],
    ]);
    const volume = new Map<string, string | null>([
      ["2026-05-01", "1000"],
      ["2026-08-01", "0"],
    ]);
    const rows = buildTakeRate(intents, price, volume);
    // 2 NEAR x 2 USD = 4 USD over 1000 USD = 40 bps
    expect(rows[0]?.take_rate_gas_bps_narrow).toBe("40.00000000");
    expect(rows[1]?.take_rate_gas_bps_narrow).toBeNull(); // no volume that day
    expect(rows[2]?.take_rate_gas_bps_narrow).toBeNull(); // zero volume
    expect(rows[0]?.take_rate_gas_bps_narrow_30d).toBeNull(); // fewer than 15 usable days
    expect(rows[0]?.days_in_30d).toBe("1");
  });
  it("30 day average needs 15 usable days", () => {
    const days = Array.from({ length: 20 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
    const rows = days.map((d) => ({
      d,
      narrow_outcomes: "1",
      narrow_gas_burnt: "1",
      narrow_tokens_burnt_yocto: Y.toString(),
      narrow_tokens_burnt_near: "1",
      wide_outcomes: "1",
      wide_gas_burnt: "1",
      wide_tokens_burnt_yocto: (2n * Y).toString(),
      wide_tokens_burnt_near: "2",
      wide_accounts_without_row: "0",
      total_tokens_burnt_yocto: (10n * Y).toString(),
      narrow_share_of_total_pct: "10.000000",
      wide_share_of_total_pct: "20.000000",
    }));
    const price = new Map(days.map((d) => [d, "1"] as const));
    const vol = new Map(days.map((d) => [d, "10000"] as const));
    const t = buildTakeRate(rows, price, vol);
    expect(t[13]?.take_rate_gas_bps_narrow_30d).toBeNull(); // 14 days
    expect(t[14]?.take_rate_gas_bps_narrow_30d).toBe("1.00000000"); // 15 NEAR x 1 USD / 150000 USD = 1 bps
    expect(t[19]?.take_rate_gas_bps_wide_30d).toBe("2.00000000");
  });
  it("headline periods", () => {
    const price = new Map<string, string | null>(total.map((t) => [t.d, "2"]));
    const vol = new Map<string, string | null>(total.map((t) => [t.d, "1000"]));
    const first = headline(total, intents, price, vol, "first", 2);
    expect(first).toMatchObject({
      from: "2026-05-01",
      to: "2026-05-02",
      daysWithBurn: 2,
      totalBurnNearPerDay: "150.0000",
      totalBurnUsdPerDay: "300.00",
      intentsNarrowNearPerDay: "3.0000",
    });
    expect(first.takeRateBpsNarrow).toBe("60.0000"); // 6 NEAR x 2 USD / 2000 USD
  });
});

describe("cross-check", () => {
  it("reports identical days, max absolute and relative differences, and unmatched days", () => {
    const mine = new Map([
      ["2026-09-01", { tokens: 100n, gas: 10n }],
      ["2026-09-02", { tokens: 200n, gas: 20n }],
      ["2026-09-03", { tokens: 5n, gas: 1n }],
    ]);
    const theirs = new Map([
      ["2026-09-01", { tokens: 100n, gas: 10n }],
      ["2026-09-02", { tokens: 202n, gas: 20n }],
      ["2026-09-09", { tokens: 1n, gas: 1n }],
    ]);
    const c = crossCheck(mine, theirs);
    expect(c.matchingDays).toBe(2);
    expect(c.onlyMineDays).toBe(1);
    expect(c.onlyTheirsDays).toBe(1);
    expect(c.tokens).toMatchObject({ maxAbsDiffYocto: "2", maxAbsDiffDay: "2026-09-02", identicalDays: 1 });
    expect(c.tokens.maxRelDiff).toBe("0.009900990099");
    expect(c.gas).toMatchObject({ maxAbsDiff: "0", identicalDays: 2 });
  });
});
