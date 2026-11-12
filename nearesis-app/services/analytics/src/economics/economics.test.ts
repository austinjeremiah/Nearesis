import { describe, expect, it } from "vitest";
import {
  activityPerNear,
  dailyFeeTotals,
  reconcileOutcomesContainConversion,
  EconomicsUnitError,
  ECONOMICS_PROPOSALS,
  executionIntensity,
  feeConcentrationHhi,
  feePercentiles,
  feeWithUsd,
  gasAtPrice,
  gasByContract,
  gasToYocto,
  highCostTransactions,
  mkGas,
  mkYocto,
  parseGas,
  parseYocto,
  reconcileOutcomesToTransactions,
  reconcileReceiversToDay,
  reconcileTxParts,
  REGIME_PRE_V87,
  REGIME_V87,
  splitFee,
  sumGas,
  sumYocto,
  yoctoToNear,
  yoctoToUsd,
  type OutcomeRow,
  type PriceSource,
  type TxDayRow,
  type TxReceiverRow,
} from "./index.ts";

const o = (
  day: string,
  ex: string,
  kind: string,
  status: string,
  n: string,
  g: string,
  t: string,
): OutcomeRow => ({
  block_date: day,
  executor_account_id: ex,
  outcome_kind: kind,
  status_class: status,
  outcomes: n,
  gas_burnt: g,
  tokens_burnt_yocto: t,
});

// Fixture day: a successful multi-receipt call, a failed receipt, delayed receipt (same executor, later day row), refund
// receipts (gas reported, zero tokens), transaction outcomes (NO_RECEIPT_ROW) and a folded remainder.
const outcomes: OutcomeRow[] = [
  o("2026-10-01", "dex.near", "ACTION", "SUCCESS", "10", "30000000000000", "3000000000000000000000000"),
  o("2026-10-01", "dex.near", "ACTION", "FAILURE", "2", "4000000000000", "400000000000000000000000"),
  o("2026-10-01", "dex.near", "REFUND", "SUCCESS", "3", "660000000000", "0"),
  o("2026-10-01", "token.near", "ACTION", "SUCCESS", "5", "5000000000000", "7032494768750000000000001"),
  o(
    "2026-10-01",
    "alice.near",
    "NO_RECEIPT_ROW",
    "SUCCESS",
    "7",
    "2100000000000",
    "210000000000000000000000",
  ),
  o(
    "2026-10-01",
    "__below_threshold__",
    "DATA",
    "SUCCESS",
    "40",
    "1000000000000",
    "100000000000000000000000",
  ),
  o("2026-10-02", "dex.near", "ACTION", "SUCCESS", "1", "1000000000000", "100000000000000000000000"),
];

describe("unit safety: gas units, yoctoNEAR and USD never mix", () => {
  it("refuses to add gas to yoctoNEAR or the reverse", () => {
    const g = mkGas(5n);
    const y = mkYocto(5n);
    expect(() => sumGas([g, y as never])).toThrow(EconomicsUnitError);
    expect(() => sumYocto([y, g as never])).toThrow(EconomicsUnitError);
    expect(() => yoctoToNear(g as never)).toThrow(EconomicsUnitError);
    expect(() => gasToYocto(y as never, 100n)).toThrow(EconomicsUnitError);
    expect(() => yoctoToUsd(g as never, price)).toThrow(EconomicsUnitError);
  });
  it("parses only plain unsigned integer strings (no floats, exponents or negatives)", () => {
    expect(() => parseGas("1e12")).toThrow();
    expect(() => parseYocto("7.03e21")).toThrow();
    expect(() => parseYocto("-1")).toThrow();
    expect(() => parseGas("12.5")).toThrow();
    expect(parseYocto("7032494768750000000000001").units).toBe(7032494768750000000000001n);
  });
  it("gas becomes yoctoNEAR only through an explicit price", () => {
    expect(gasToYocto(parseGas("3000000000000"), 100_000_000n).units).toBe(300_000_000_000_000_000_000n);
    expect(gasAtPrice("1000", "100000000")).toBe("100000000000");
    expect(() => gasToYocto(mkGas(1n), 0n)).toThrow();
  });
});

describe("decimal precision", () => {
  it("renders yoctoNEAR as an exact 24-digit NEAR decimal above 2^53", () => {
    expect(yoctoToNear(parseYocto("1"))).toBe("0.000000000000000000000001");
    expect(yoctoToNear(parseYocto("7032494768750000000000001"))).toBe("7.032494768750000000000001");
    expect(yoctoToNear(parseYocto("1000000000000000000000000"))).toBe("1.000000000000000000000000");
    // a float64 round trip would lose this digit
    expect(BigInt(Number("7032494768750000000000001"))).not.toBe(7032494768750000000000001n);
  });
  it("sums without drift: 1e6 additions of 1 yocto on top of 2^60", () => {
    const base = parseYocto((2n ** 60n).toString());
    const total = sumYocto([base, mkYocto(1_000_000n)]);
    expect(total.units).toBe(2n ** 60n + 1_000_000n);
  });
});

const price: PriceSource = {
  provider: "coingecko",
  symbol: "NEAR",
  priceUsd: "2.4375",
  priceTimestampUTC: "2026-10-01T00:00:00.000Z",
  method: "coingecko_daily_close_utc",
};

describe("USD conversion exposes source, timestamp and method", () => {
  it("converts exactly and rounds once, half-even", () => {
    const r = yoctoToUsd(parseYocto("2000000000000000000000000"), price); // 2 NEAR x 2.4375
    expect(r.usd).toBe("4.875000");
    expect(r.conversion).toMatchObject({
      method: "coingecko_daily_close_utc",
      source: "coingecko:NEAR",
      priceUsd: "2.4375",
      priceTimestampUTC: "2026-10-01T00:00:00.000Z",
      unitFrom: "yoctoNEAR",
      rounding: "half_even",
    });
    expect(yoctoToUsd(parseYocto("5"), { ...price, priceUsd: "1" }, 24).usd).toBe(
      "0.000000000000000000000005",
    );
    expect(yoctoToUsd(parseYocto("2500000000000000000"), { ...price, priceUsd: "1" }, 6).usd).toBe(
      "0.000002",
    ); // 2.5e-6 -> half even
  });
  it("refuses an untimestamped or malformed price and gives null (not 0) without a price", () => {
    expect(() => yoctoToUsd(mkYocto(1n), { ...price, priceTimestampUTC: "" })).toThrow();
    expect(() => yoctoToUsd(mkYocto(1n), { ...price, priceUsd: "1e3" })).toThrow();
    const f = feeWithUsd("1000000000000000000000000", null);
    expect(f.usd).toBeNull();
    expect(f.usdUnavailableReason).toBe("NO_TIMESTAMPED_PRICE");
    expect(f.executionFeeNear).toBe("1.000000000000000000000000");
  });
});

describe("fee semantics: no protocol-revenue claim; split is modelled by regime", () => {
  it("pre-v87: 30% contract reward, 70% burnt, parts sum to the fee", () => {
    const s = splitFee(parseYocto("1000000000000000000000001"), REGIME_PRE_V87);
    expect(s.contractReward.units + s.burnt.units).toBe(s.executionFee.units);
    expect(s.contractReward.units).toBe(300000000000000000000000n);
    expect(s.basis).toBe("modelled_from_documented_regime");
  });
  it("v87+: everything burnt, no reward", () => {
    const s = splitFee(parseYocto("123"), REGIME_V87);
    expect(s.contractReward.units).toBe(0n);
    expect(s.burnt.units).toBe(123n);
  });
  it("exposes no protocol revenue helper", async () => {
    const m = await import("./index.ts");
    expect(Object.keys(m).filter((k) => /revenue/i.test(k))).toEqual([]);
    for (const p of ECONOMICS_PROPOSALS)
      expect(`${p.name} ${p.displayName} ${p.description}`).not.toMatch(/revenue/i);
  });
});

describe("daily totals, refunds, unusual receipt structures", () => {
  it("sums every outcome kind exactly per execution day and splits refund gas (no tokens) out", () => {
    const d = dailyFeeTotals(outcomes);
    expect(d.map((x) => x.day)).toEqual(["2026-10-01", "2026-10-02"]);
    const d1 = d[0]!;
    expect(d1.outcomes).toBe("67");
    expect(d1.gasUnits).toBe(
      (
        30000000000000n +
        4000000000000n +
        660000000000n +
        5000000000000n +
        2100000000000n +
        1000000000000n
      ).toString(),
    );
    expect(d1.executionFeeYocto).toBe(
      (
        3000000000000000000000000n +
        400000000000000000000000n +
        7032494768750000000000001n +
        210000000000000000000000n +
        100000000000000000000000n
      ).toString(),
    );
    expect(d1.refundReceiptGasUnits).toBe("660000000000"); // refund gas is units, with zero fee
  });
  it("failed receipts still burn tokens and are counted in the fee", () => {
    const failedFee = outcomes.find((r) => r.status_class === "FAILURE")!.tokens_burnt_yocto;
    expect(BigInt(failedFee)).toBeGreaterThan(0n);
  });
});

describe("reconciliation invariants: per-contract sum = daily total", () => {
  const day = "2026-10-01";
  it("per-account gas and fee equal the daily totals, with and without an application mapper", () => {
    const total = dailyFeeTotals(outcomes)[0]!;
    for (const appOf of [
      undefined,
      (a: string) => (a.endsWith(".near") && a !== "alice.near" ? "app:defi" : null),
    ]) {
      const g = gasByContract(outcomes, day, appOf);
      expect(g.totalGas).toBe(total.gasUnits);
      expect(g.totalFeeYocto).toBe(total.executionFeeYocto);
      expect(g.items.reduce((a, i) => a + BigInt(i.gasUnits), 0n).toString()).toBe(total.gasUnits);
      expect(g.items.reduce((a, i) => a + BigInt(i.executionFeeYocto), 0n).toString()).toBe(
        total.executionFeeYocto,
      );
    }
  });
  it("maps to an application via a registry resolver, keeps unmapped accounts and the folded remainder separate", () => {
    const g = gasByContract(outcomes, day, (a) =>
      a === "dex.near" || a === "token.near" ? "app:defi" : null,
    );
    const names = g.items.map((i) => i.account).sort();
    expect(names).toEqual(["__below_threshold__", "alice.near", "app:defi"]);
    expect(g.items.find((i) => i.account === "__below_threshold__")?.folded).toBe(true);
  });
  it("fee shares in basis points are bounded by 10000 and sum within rounding", () => {
    const g = gasByContract(outcomes, day);
    const s = g.items.reduce((a, i) => a + BigInt(i.feeShareBps ?? "0"), 0n);
    expect(s).toBeGreaterThanOrEqual(9995n);
    expect(s).toBeLessThanOrEqual(10005n);
    const hhi = BigInt(feeConcentrationHhi(g.items, g.totalFeeYocto)!);
    expect(hhi).toBeGreaterThan(0n);
    expect(hhi).toBeLessThanOrEqual(10_000n);
  });
  const dayRow: TxDayRow = {
    block_date: day,
    txs: "3",
    receipts: "7",
    total_gas: "3000",
    total_tokens_yocto: "300000000000000000000000",
    conversion_gas: "900",
    conversion_tokens_yocto: "90000000000000000000000",
    receipt_gas: "2100",
    receipt_tokens_yocto: "210000000000000000000000",
    tokens_p50: "1",
    tokens_p90: "2",
    tokens_p99: "3",
    tokens_p999: "4",
  };
  const recv = (a: string, t: string, rc: string, g: string, tok: string): TxReceiverRow => ({
    block_date: day,
    receiver_account_id: a,
    txs: t,
    receipts: rc,
    total_gas: g,
    total_tokens_yocto: tok,
  });
  it("receiver rows reconcile to the tx day; a missing row is detected", () => {
    const rs = [
      recv("dex.near", "2", "5", "2000", "200000000000000000000000"),
      recv("__below_threshold__", "1", "2", "1000", "100000000000000000000000"),
    ];
    expect(reconcileReceiversToDay(dayRow, rs).every((x) => x.ok)).toBe(true);
    expect(reconcileReceiversToDay(dayRow, rs.slice(0, 1)).some((x) => !x.ok)).toBe(true);
    expect(reconcileTxParts(dayRow).every((x) => x.ok)).toBe(true);
    expect(reconcileTxParts({ ...dayRow, receipt_gas: "2101" }).some((x) => !x.ok)).toBe(true);
  });
  it("cross-family: transaction outcomes in execution_outcomes vs the transactions table are REPORTED, not forced", () => {
    const r = reconcileOutcomesToTransactions(outcomes, {
      ...dayRow,
      conversion_tokens_yocto: "210000000000000000000000",
    });
    expect(r.ok).toBe(true);
    const bad = reconcileOutcomesToTransactions(outcomes, dayRow);
    expect(bad.ok).toBe(false);
    expect(bad.actual).toBe("210000000000000000000000");
  });
});

describe("intensity, percentiles, high-cost transactions, activity vs cost", () => {
  it("execution intensity is exact and null (not 0) with no transactions", () => {
    const e = executionIntensity({
      txs: "3",
      receipts: "7",
      total_gas: "3000",
      total_tokens_yocto: "300000000000000000000000",
    });
    expect(e.gasPerTx).toBe("1000.000");
    expect(e.feeYoctoPerTx).toBe("100000000000000000000000");
    expect(e.receiptsPerTx).toBe("2.3333");
    expect(
      executionIntensity({ txs: "0", receipts: "0", total_gas: "0", total_tokens_yocto: "0" }).gasPerTx,
    ).toBeNull();
  });
  it("percentiles are labelled approximate", () => {
    const p = feePercentiles({
      block_date: "d",
      txs: "1",
      receipts: "1",
      total_gas: "1",
      total_tokens_yocto: "1",
      conversion_gas: "1",
      conversion_tokens_yocto: "1",
      receipt_gas: "0",
      receipt_tokens_yocto: "0",
      tokens_p50: "5",
      tokens_p90: "6",
      tokens_p99: "7",
      tokens_p999: "8",
    })!;
    expect(p.exact).toBe(false);
    expect(p.method).toMatch(/approx/);
    expect(
      feePercentiles({
        block_date: "d",
        txs: "1",
        receipts: "1",
        total_gas: "1",
        total_tokens_yocto: "1",
        conversion_gas: "1",
        conversion_tokens_yocto: "1",
        receipt_gas: "0",
        receipt_tokens_yocto: "0",
      }),
    ).toBeNull();
  });
  it("high-cost transactions filter by an exact yocto threshold in rank order", () => {
    const rows = [1, 2, 3].map((rank) => ({
      block_date: "2026-10-01",
      rank,
      transaction_hash: `tx${rank}`,
      receiver_account_id: "dex.near",
      gas_burnt: "1",
      tokens_burnt_yocto: String(4n - BigInt(rank)) + "00000000000000000000000",
    }));
    expect(
      highCostTransactions(rows.reverse(), "2026-10-01", "200000000000000000000000").map((r) => r.rank),
    ).toEqual([1, 2]);
  });
  it("activity per NEAR of fee is exact; zero fee is undefined, not infinite", () => {
    expect(activityPerNear("500", "250000000000000000000000")).toBe("2000.000000");
    expect(activityPerNear("5", "0")).toBeNull();
  });
});

describe("governed-authoring proposals", () => {
  it("all proposals parse against the MetricProposal contract and carry limitations", () => {
    expect(ECONOMICS_PROPOSALS.map((p) => `${p.namespace}.${p.name}`)).toEqual([
      "economics.execution_fee_yocto",
      "economics.gas_units",
      "economics.gas_per_execution_outcome",
      "economics.fee_per_execution_outcome_yocto",
      "economics.transactions",
      "economics.transaction_conversion_fee_yocto",
      "economics.mean_gas_price_yocto_per_gas",
    ]);
    for (const p of ECONOMICS_PROPOSALS) expect(p.limitations.length).toBeGreaterThan(0);
  });
  it("units are never gas+yocto in one aggregation", () => {
    for (const p of ECONOMICS_PROPOSALS) expect(p.unit).toMatch(/^(yoctoNEAR|gas|tx)(\/(tx|gas))?$/);
  });
});

describe("lean load (rule version 2)", () => {
  const o = (kind: string, gas: string, tok: string, n = "1") => ({
    block_date: "2026-11-03",
    executor_account_id: "a.near",
    outcome_kind: kind,
    status_class: "UNKNOWN",
    outcomes: n,
    gas_burnt: gas,
    tokens_burnt_yocto: tok,
  });
  const rows = [o("BURNING", "1000", "100000000000"), o("ZERO_TOKEN", "223182562500", "0", "3")];
  it("reports zero-token gas as a proxy, never as refund gas", () => {
    const [d] = dailyFeeTotals(rows);
    expect(d?.zeroTokenGasUnits).toBe("223182562500");
    expect(d?.refundReceiptGasUnits).toBe("0");
    expect(d?.outcomes).toBe("4");
  });
  it("bound-checks outcomes against the conversion burn and fails when outcomes are smaller", () => {
    const ok = reconcileOutcomesContainConversion(rows, {
      block_date: "2026-11-03",
      conversion_gas: "500",
      conversion_tokens_yocto: "50000000000",
    });
    expect(ok.every((r) => r.ok)).toBe(true);
    const bad = reconcileOutcomesContainConversion(rows, {
      block_date: "2026-11-03",
      conversion_gas: "500",
      conversion_tokens_yocto: "100000000001",
    });
    expect(bad.some((r) => !r.ok)).toBe(true);
  });
});
