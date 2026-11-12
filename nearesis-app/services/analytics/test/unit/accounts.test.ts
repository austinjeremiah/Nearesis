import { describe, expect, it } from "vitest";
import {
  ACCOUNT_CAVEATS,
  accountConcentration,
  cohortRetention,
  coverageOf,
  dailyActivity,
  entitySignerChange,
  entityUniqueSigners,
  growthContribution,
  highFrequency,
} from "../../src/index.ts";
import type { AccountDataSource, AccountDay, EntitySignerDay } from "../../src/index.ts";

const WS = "2026-01-01";
const day = (i: number, o: Partial<AccountDay> = {}): AccountDay => {
  const date = new Date(Date.parse(`${WS}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
  const active = 1000 + i * 10;
  const nw = i === 0 ? active : 100;
  return {
    date,
    signersAll: active + 5,
    txAll: 50_000,
    txIntents: 5000,
    txBridge: 1000,
    signersWithIntents: 5,
    signersOrganic: active,
    txOrganic: 44_000,
    newSigners: nw,
    returningSigners: active - nw,
    newTx: nw * 10,
    returningTx: 44_000 - nw * 10,
    top10Tx: 22_000,
    top1PctSigners: 10,
    top1PctTx: 30_800,
    top5PctSigners: 50,
    top5PctTx: 35_200,
    headSigners: 20,
    headTx: 33_000,
    tailSigners: active - 20,
    tailTx: 11_000,
    headThreshold: 100,
    ...o,
  };
};
const rows = Array.from({ length: 40 }, (_, i) => day(i));

describe("account daily, growth and concentration", () => {
  it("returning = active - new and flags the window-start day", () => {
    const d = dailyActivity(rows, WS);
    expect(d[0]).toMatchObject({ isWindowStart: true, newAccounts: 1000, returningAccounts: 0 });
    expect(d[1]).toMatchObject({ isWindowStart: false, newAccounts: 100, returningAccounts: 910 });
    for (const r of d) expect(r.newAccounts + r.returningAccounts).toBe(r.activeAccounts);
  });
  it("splits the change in average DAU exactly into new and returning contributions and ignores the window-start day", () => {
    const g = growthContribution(rows, WS, rows[39]!.date, 15);
    expect(g.complete).toBe(true);
    expect(g.change).toBeCloseTo(150, 9); // 15 days apart x 10 accounts/day
    expect(g.newAccountContribution! + g.returningAccountContribution!).toBeCloseTo(g.change!, 9);
    const short = growthContribution(rows, WS, rows[39]!.date, 20); // previous period would reach the window-start day
    expect(short.complete).toBe(false);
    expect(short.previous.daysWithData).toBe(19);
  });
  it("concentration shares are exact ratios of the scan's counts", () => {
    const c = accountConcentration(rows);
    expect(c.daily[0]).toMatchObject({
      top1PctShare: 0.7,
      top5PctShare: 0.8,
      top10AccountsShare: 0.5,
      headShare: 0.75,
      tailShare: 0.25,
    });
    expect(c.range.headShare).toBeCloseTo(0.75, 12);
    expect(accountConcentration([day(0, { txOrganic: 0 })]).daily[0]!.top1PctShare).toBeNull();
  });
  it("reports missing days as gaps, never zeros", () => {
    const cov = coverageOf(["2026-01-01", "2026-01-03"], "2026-01-01", "2026-01-04");
    expect(cov).toEqual({ requestedDays: 4, daysWithData: 2, missingDays: ["2026-01-02", "2026-01-04"] });
  });
});

describe("cohort retention", () => {
  const cells = [
    { cohortWeek: "2025-12-29", activeWeek: "2025-12-29", signers: 100 },
    { cohortWeek: "2025-12-29", activeWeek: "2026-01-05", signers: 40 },
    { cohortWeek: "2026-01-05", activeWeek: "2026-01-05", signers: 50 },
  ];
  it("computes rates per cohort size, marks the window-start cohort and the partial final week", () => {
    const r = cohortRetention(cells, "2026-01-01", "2026-01-07");
    expect(r.cohorts[0]).toMatchObject({
      cohortWeek: "2025-12-29",
      cohortSize: 100,
      isWindowStartCohort: true,
    });
    expect(r.cohorts[0]!.weeks.map((w) => [w.weekOffset, w.rate, w.partialWeek])).toEqual([
      [0, 1, false],
      [1, 0.4, true],
    ]);
    expect(r.cohorts[1]).toMatchObject({ cohortSize: 50, isWindowStartCohort: false });
    expect(r.notes.join(" ")).toMatch(/SINCE the window start/);
  });
});

describe("high-frequency accounts", () => {
  it("labels by frequency only and carries the not-a-bot caveat", () => {
    const hf = highFrequency(
      [
        {
          account: "a.near",
          headDays: 40,
          txOrganic: 80_000,
          maxDayTx: 3000,
          firstHeadDay: WS,
          lastHeadDay: "2026-02-09",
        },
        { account: "b.near", headDays: 2, txOrganic: 400, maxDayTx: 250, firstHeadDay: WS, lastHeadDay: WS },
      ],
      rows,
      100,
    );
    expect(hf.accounts.map((a) => a.frequencyLabel)).toEqual([
      "very_high_frequency_account",
      "high_frequency_account",
    ]);
    expect(hf.accounts[0]!.shareOfOrganicTransactions).toBeCloseTo(80_000 / (44_000 * 40), 12);
    expect(hf.caveat).toMatch(/not proof of a bot/);
    expect(JSON.stringify(hf)).not.toMatch(/"bot"|is_bot|isBot/);
  });
});

describe("entity unique signers", () => {
  const ent = (n: number): EntitySignerDay[] =>
    rows
      .slice(0, n)
      .map((r, i) => ({
        date: r.date,
        signersAll: 100 + i,
        txAll: 1000,
        signersOrganic: i % 2 ? 0 : 90,
        txOrganic: i % 2 ? 0 : 900,
      }));
  const src = (data: EntitySignerDay[], days: string[], empty = false): AccountDataSource => ({
    window: async () =>
      empty
        ? null
        : { windowStart: WS, from: days[0]!, to: days[days.length - 1]!, days, headThreshold: 100 },
    days: async () => [],
    retention: async () => [],
    headAccounts: async () => [],
    headDays: async () => [],
    profile: async () => null,
    entityDays: async (_e, f, t) => data.filter((r) => r.date >= f && r.date <= t),
  });
  const days = rows.map((r) => r.date);
  it("returns exact per-day signers with coverage, and bounds (not a fake total) for the window distinct count", async () => {
    const r = await entityUniqueSigners(src(ent(40), days), "sweat", days[10]!, days[19]!);
    expect(r.state).toBe("COMPUTED");
    if (r.state !== "COMPUTED") return;
    expect(r.daily).toHaveLength(10);
    expect(r.summary.signerDays).toBe(
      Array.from({ length: 10 }, (_, i) => 110 + i).reduce((a, b) => a + b, 0),
    );
    expect(r.summary.peakDailySigners).toBe(119);
    expect(r.summary.windowDistinctSigners).toMatchObject({
      state: "CANNOT_COMPUTE",
      reasonCode: "WINDOW_DISTINCT_NOT_ADDITIVE",
      lowerBound: 119,
      upperBound: r.summary.signerDays,
    });
    expect(r.coverage.missingDays).toEqual([]);
    expect(r.caveats).toBe(ACCOUNT_CAVEATS);
    expect(r.basis.notAdditive).toMatch(/not additive/);
  });
  it("a covered day without a bucket row is an exact zero; a day outside the scan is a gap", async () => {
    const r = await entityUniqueSigners(
      src(
        ent(40).filter((x) => x.date !== days[12]),
        days,
      ),
      "aurora",
      days[10]!,
      "2026-03-01",
    );
    if (r.state !== "COMPUTED") throw new Error("expected computed");
    expect(r.daily.find((d) => d.date === days[12])).toMatchObject({ signers: 0, transactions: 0 });
    expect(r.coverage.missingDays.length).toBeGreaterThan(0);
    expect(r.to).toBe(days[39]);
  });
  it("is CANNOT_COMPUTE only when nothing is loaded or the range misses the scan", async () => {
    expect(await entityUniqueSigners(src([], days, true), "x", days[0]!, days[1]!)).toMatchObject({
      state: "CANNOT_COMPUTE",
      reasonCode: "PER_SIGNER_SOURCE_MISSING",
    });
    expect(await entityUniqueSigners(src([], days), "x", "2030-01-01", "2030-01-05")).toMatchObject({
      state: "CANNOT_COMPUTE",
      reasonCode: "RANGE_OUTSIDE_LOADED_WINDOW",
    });
  });
  it("explains a zero-organic intents-style entity instead of showing silence", async () => {
    const intents = rows.map((r) => ({
      date: r.date,
      signersAll: 148,
      txAll: 117_000,
      signersOrganic: 0,
      txOrganic: 0,
    }));
    const r = await entityUniqueSigners(src(intents, days), "near-intents", days[0]!, days[9]!);
    if (r.state !== "COMPUTED") throw new Error("expected computed");
    expect(r.organicNote).toMatch(/excludes/);
  });
  it("period-over-period change compares equal-length windows", async () => {
    const c = await entitySignerChange(src(ent(40), days), "sweat", days[39]!, 10);
    expect(c.current).toBeCloseTo(100 + 34.5, 9);
    expect(c.previous).toBeCloseTo(100 + 24.5, 9);
    expect(c.change).toBeCloseTo(10, 9);
    expect(c.complete).toBe(true);
  });
});
