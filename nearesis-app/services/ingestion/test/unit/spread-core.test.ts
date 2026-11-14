import { describe, expect, it } from "vitest";
import {
  addFeeItem,
  baseSymbol,
  classifyRoute,
  emptyFeeAgg,
  formatFeeUsd,
  formatScaled,
  isArtefact,
  missingDays,
  parseDecimalScaled,
  spreadAggSql,
  spreadBps,
  toFeeItem,
  topShares,
} from "../../src/thesis/spread-core.ts";

const A = (symbol: string, blockchain: string) => ({ symbol, blockchain });

describe("route classification", () => {
  it("strips the deprecated suffix", () => expect(baseSymbol("USDC(DEPRECATED)")).toBe("usdc"));
  it("stable to stable across chains and symbols", () => {
    expect(classifyRoute(A("USDC", "eth"), A("USDT", "tron"))).toBe("stable_to_stable");
    expect(classifyRoute(A("USDC", "eth"), A("USDC", "base"))).toBe("stable_to_stable");
    expect(classifyRoute(A("USDC(DEPRECATED)", "pol"), A("USDT0", "arb"))).toBe("stable_to_stable");
  });
  it("same asset on different chains, including wrapped variants", () => {
    expect(classifyRoute(A("ETH", "eth"), A("ETH", "base"))).toBe("same_asset_cross_chain");
    expect(classifyRoute(A("WETH", "arb"), A("ETH", "eth"))).toBe("same_asset_cross_chain");
    expect(classifyRoute(A("BTC", "btc"), A("cbBTC", "base"))).toBe("same_asset_cross_chain");
  });
  it("same symbol on the same chain is not a bridge, different assets are volatile", () => {
    expect(classifyRoute(A("ETH", "eth"), A("ETH", "eth"))).toBe("volatile_other");
    expect(classifyRoute(A("ETH", "eth"), A("USDC", "eth"))).toBe("volatile_other");
  });
  it("assets missing from the registry are unclassified", () => {
    expect(classifyRoute(null, A("USDC", "eth"))).toBe("unclassified");
  });
});

describe("exact decimals", () => {
  it("parses and formats without float error", () => {
    expect(parseDecimalScaled("17.948854863980", 12)).toBe(17948854863980n);
    expect(formatScaled(17948854863980n, 12)).toBe("17.94885486398");
    expect(formatScaled(-5n, 3)).toBe("-0.005");
    expect(parseDecimalScaled("abc", 12)).toBeNull();
  });
  it("spread in bps, rounded half away from zero", () => {
    const usd = (s: string) => parseDecimalScaled(s, 12)!;
    expect(spreadBps(usd("100"), usd("99.5"))).toBe("50");
    expect(spreadBps(usd("100"), usd("100.1"))).toBe("-10");
    expect(spreadBps(usd("3"), usd("2.99999"), 2)).toBe("0.03");
    expect(spreadBps(0n, 1n)).toBeNull();
  });
  it("artefact rule is strictly above 20 percent of input", () => {
    expect(isArtefact(100n, 80n)).toBe(false);
    expect(isArtefact(100n, 79n)).toBe(true);
    expect(isArtefact(100n, 121n)).toBe(true);
    expect(isArtefact(100n, 120n)).toBe(false);
  });
});

describe("sql generation", () => {
  it("is a SELECT with every population and no write verbs", () => {
    const s = spreadAggSql("day", true);
    expect(s).toMatch(/^WITH /);
    expect(s).toContain("quantilesExact(0.25, 0.5, 0.75)");
    expect(s).not.toMatch(/\b(INSERT|ALTER|DROP|TRUNCATE|DELETE)\b/i);
    expect(spreadAggSql("month", false)).toContain("'all' AS grp");
  });
  it("lists missing days", () => {
    expect(missingDays("2026-01-01", "2026-01-04", ["2026-01-01", "2026-01-04"])).toEqual([
      "2026-01-02",
      "2026-01-03",
    ]);
  });
});

describe("app fee extraction", () => {
  const raw = {
    depositAddress: "0xabc",
    depositMemo: null,
    createdAt: "2026-07-24T08:29:46.964Z",
    status: "SUCCESS",
    amountInUsd: "17.948854863980",
    referral: "swapkit",
    appFees: [{ recipient: "trustswapkit.near", fee: 70 }],
  };
  it("builds a key, day, exact usd and fees", () => {
    const it = toFeeItem(raw)!;
    expect(it.key).toBe("0xabc|");
    expect(it.day).toBe("2026-07-24");
    expect(it.fees).toEqual([{ recipient: "trustswapkit.near", bps: 70 }]);
    expect(toFeeItem({ nope: 1 })).toBeNull();
  });
  it("sums fee usd exactly and tracks fee swaps without a mark", () => {
    const a = emptyFeeAgg();
    addFeeItem(a, toFeeItem(raw)!);
    addFeeItem(a, toFeeItem({ ...raw, depositAddress: "b", amountInUsd: "" })!);
    addFeeItem(a, toFeeItem({ ...raw, depositAddress: "c", appFees: [] })!);
    expect(a.swaps).toBe(3);
    expect(a.swapsWithFee).toBe(2);
    expect(a.feeNoUsd).toBe(1);
    // 17.94885486398 * 70 / 10000 = 0.12564198404786
    expect(formatFeeUsd(a.feeScaled4)).toBe("0.12564198404786");
  });
  it("ranks recipients with shares of the total", () => {
    const t = topShares(
      new Map([
        ["a", 3n],
        ["b", 1n],
      ]),
      1,
    );
    expect(t).toEqual([{ label: "a", usdScaled4: 3n, share: "0.75" }]);
  });
});
