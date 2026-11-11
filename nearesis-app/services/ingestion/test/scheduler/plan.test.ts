import { describe, expect, it } from "vitest";
import {
  loadConfig,
  quoteAddress,
  SCHEDULER_STATE_PATH,
  SCHEDULER_BQ_STATE_PATH,
  SCHEDULER_LOAD_STATE_PATH,
  SCHEDULER_RAW_DIR,
} from "../../src/scheduler/config.ts";
import {
  backoffMs,
  DEFAULT_ROUTES,
  dueTasks,
  lastCompletedDay,
  limitSlots,
  notionalBaseUnits,
  pendingBqDays,
  pendingPriceDays,
  planQuoteGrid,
  quoteBucket,
  type TokenInfo,
} from "../../src/scheduler/plan.ts";
import { emptySchedulerState } from "../../src/scheduler/state.ts";
import { STATE_PATH as BACKFILL_STATE_PATH, DATA_DIR as BACKFILL_DIR } from "../../src/backfill/env.ts";
import { CredentialSource } from "../../src/http/credentials.ts";

const T = (s: string): number => Date.parse(s);
const cfg = loadConfig({});

describe("planning", () => {
  it("the last completed UTC day is yesterday, and days before the forward start are never planned", () => {
    expect(lastCompletedDay(T("2026-11-11T00:00:01Z"))).toBe("2026-11-10");
    expect(lastCompletedDay(T("2026-11-11T23:59:59Z"))).toBe("2026-11-10");
    expect(pendingBqDays(T("2026-11-10T12:00:00Z"), () => false)).toEqual([]);
    expect(pendingBqDays(T("2026-11-13T12:00:00Z"), () => false)).toEqual([
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
    ]);
  });

  it("a day is pending until both BigQuery families are done (resume)", () => {
    const done = new Set(["transactions:2026-11-10", "transactions:2026-11-11", "receivers:2026-11-11"]);
    expect(pendingBqDays(T("2026-11-13T12:00:00Z"), (id) => done.has(id))).toEqual([
      "2026-11-10",
      "2026-11-12",
    ]);
  });

  it("price days settle only as done or gap", () => {
    const st = { doneDays: ["2026-11-10"], gapDays: ["2026-11-11"], attempts: {}, requests: 0 };
    expect(pendingPriceDays(T("2026-11-13T12:00:00Z"), st)).toEqual(["2026-11-12"]);
  });

  it("daily tasks wait for the delay after UTC midnight; hourly tasks follow their interval; backoff is honoured", () => {
    const st = emptySchedulerState();
    const facts = { bqPending: 1, pricePending: 1, explorerInflight: false };
    expect(dueTasks(T("2026-11-11T01:00:00Z"), st, cfg, facts, ["bq", "price"])).toEqual([]);
    expect(dueTasks(T("2026-11-11T02:00:00Z"), st, cfg, facts, ["bq", "price"])).toEqual(["bq", "price"]);
    expect(
      dueTasks(T("2026-11-11T09:00:00Z"), st, cfg, { ...facts, bqPending: 0, pricePending: 0 }, [
        "bq",
        "price",
      ]),
    ).toEqual([]);

    st.tasks.explorer.lastOkAtMs = T("2026-11-11T09:00:00Z");
    expect(dueTasks(T("2026-11-11T09:30:00Z"), st, cfg, facts, ["explorer"])).toEqual([]);
    expect(dueTasks(T("2026-11-11T10:00:00Z"), st, cfg, facts, ["explorer"])).toEqual(["explorer"]);
    // an unfinished window is due on the next tick, not an hour later
    expect(
      dueTasks(T("2026-11-11T09:31:00Z"), st, cfg, { ...facts, explorerInflight: true }, ["explorer"]),
    ).toEqual(["explorer"]);

    st.tasks.explorer.nextAttemptAtMs = T("2026-11-11T10:05:00Z");
    expect(dueTasks(T("2026-11-11T10:01:00Z"), st, cfg, facts, ["explorer"])).toEqual([]);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000,
    ]);
  });

  it("quotes are due once per bucket until the round completes", () => {
    const st = emptySchedulerState();
    const now = T("2026-11-11T10:20:00Z");
    const f = { bqPending: 0, pricePending: 0, explorerInflight: false };
    expect(dueTasks(now, st, cfg, f, ["quotes"])).toEqual(["quotes"]);
    st.quotes.completedBucketMs = quoteBucket(now, cfg.quoteIntervalMs);
    expect(dueTasks(now + 600_000, st, cfg, f, ["quotes"])).toEqual([]);
    expect(dueTasks(T("2026-11-11T11:00:00Z"), st, cfg, f, ["quotes"])).toEqual(["quotes"]);
  });
});

describe("state is separate from the backfill", () => {
  it("every scheduler path is under .data/scheduler and none is the backfill state or raw dir", () => {
    for (const p of [
      SCHEDULER_STATE_PATH,
      SCHEDULER_BQ_STATE_PATH,
      SCHEDULER_LOAD_STATE_PATH,
      SCHEDULER_RAW_DIR,
    ]) {
      expect(p).toContain("/.data/scheduler/");
      expect(p.startsWith(BACKFILL_DIR)).toBe(false);
      expect(p).not.toBe(BACKFILL_STATE_PATH);
    }
  });
});

const tok = (
  assetId: string,
  blockchain: string,
  symbol: string,
  decimals: number,
  price: number | null,
): TokenInfo => ({ assetId, blockchain, symbol, decimals, price });
const tokens = (list: TokenInfo[]): Map<string, TokenInfo> => new Map(list.map((t) => [t.assetId, t]));

describe("quote grid", () => {
  it("converts a USD notional to exact base units", () => {
    expect(notionalBaseUnits(100, 6, 1)).toBe("100000000");
    expect(notionalBaseUnits(10, 24, 3.65)).toBe("2739726027397260273972602"); // floor(10e24 / 3.65)
    expect(notionalBaseUnits(10, 6, 0)).toBeNull();
    expect(notionalBaseUnits(10, 6, Number.NaN)).toBeNull();
  });

  const all = tokens(
    DEFAULT_ROUTES.flatMap((r) => [r.originAsset, r.destinationAsset]).map((a, i) =>
      tok(a, ["near", "eth", "base", "sol", "btc", "arb"][i % 6]!, `T${i % 7}`, 6, 1),
    ),
  );

  it("the default grid is 10 routes x 4 notionals x 3 privacy modes, one deterministic slot each", () => {
    const grid = planQuoteGrid({
      routes: DEFAULT_ROUTES,
      tokens: all,
      notionalsUsd: cfg.quoteNotionalsUsd,
      modes: cfg.quotePrivacyModes,
      hasAddress: () => true,
    });
    expect(DEFAULT_ROUTES).toHaveLength(10);
    expect(grid).toHaveLength(120);
    expect(new Set(grid.map((g) => g.key)).size).toBe(120);
    expect(grid.every((g) => g.unavailableReason === null && g.amountBaseUnits !== null)).toBe(true);
  });

  it("slots that cannot be attempted say why instead of disappearing", () => {
    const some = tokens([
      tok(DEFAULT_ROUTES[0]!.originAsset, "near", "wNEAR", 24, 3.65),
      tok(DEFAULT_ROUTES[0]!.destinationAsset, "near", "USDC", 6, null),
    ]);
    const noAddr = planQuoteGrid({
      routes: DEFAULT_ROUTES.slice(0, 2),
      tokens: some,
      notionalsUsd: [10],
      modes: ["public"],
      hasAddress: () => false,
    });
    expect(noAddr.map((g) => g.unavailableReason)).toEqual([
      "NO_REFUND_ADDRESS_CONFIG:near",
      "NO_REFUND_ADDRESS_CONFIG:near",
    ]);
    const unpriced = tokens([
      tok(DEFAULT_ROUTES[0]!.originAsset, "near", "wNEAR", 24, null),
      tok(DEFAULT_ROUTES[0]!.destinationAsset, "near", "USDC", 6, 1),
    ]);
    const noPrice = planQuoteGrid({
      routes: DEFAULT_ROUTES.slice(0, 1),
      tokens: unpriced,
      notionalsUsd: [10],
      modes: ["public"],
      hasAddress: () => true,
    });
    expect(noPrice[0]!.unavailableReason).toBe("NO_PRICE_REFERENCE");
    const unlisted = planQuoteGrid({
      routes: DEFAULT_ROUTES.slice(2, 3),
      tokens: some,
      notionalsUsd: [10],
      modes: ["public"],
      hasAddress: () => true,
    });
    expect(unlisted[0]!.unavailableReason).toBe("ASSET_NOT_LISTED");
  });

  it("a limited round still spans several routes", () => {
    const grid = planQuoteGrid({
      routes: DEFAULT_ROUTES,
      tokens: all,
      notionalsUsd: cfg.quoteNotionalsUsd,
      modes: cfg.quotePrivacyModes,
      hasAddress: () => true,
    });
    const sub = limitSlots(grid, 12);
    expect(sub).toHaveLength(12);
    expect(new Set(sub.map((s) => s.routeId)).size).toBeGreaterThanOrEqual(10);
    expect(limitSlots(grid, 0)).toHaveLength(120);
  });

  it("addresses come only from configuration, per chain", () => {
    const c = CredentialSource.fromMap({
      NEARESIS_QUOTE_ADDRESS_ETH: "0xabc",
      NEARESIS_QUOTE_RECIPIENT_NEAR: "r.near",
    });
    expect(quoteAddress(c, "recipient", "eth")).toBe("0xabc");
    expect(quoteAddress(c, "refund", "eth")).toBe("0xabc");
    expect(quoteAddress(c, "recipient", "near")).toBe("r.near");
    expect(quoteAddress(c, "refund", "near")).toBeNull();
  });
});
