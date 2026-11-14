import {
  ACCOUNT_CAVEATS,
  type AccountDataSource,
  type AccountDay,
  type HeadAccountRow,
  type RetentionCell,
} from "./types.ts";

export const addDaysIso = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const share = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

export interface AccountCoverage {
  requestedDays: number;
  daysWithData: number;
  missingDays: string[];
}
export function coverageOf(days: string[], from: string, to: string): AccountCoverage {
  const have = new Set(days);
  const missing: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) if (!have.has(d)) missing.push(d);
  const requested =
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return { requestedDays: requested, daysWithData: requested - missing.length, missingDays: missing };
}

/** Daily active accounts with new vs returning. The window-start day is flagged: every account is "new" by construction. */
export function dailyActivity(rows: AccountDay[], windowStart: string) {
  return rows.map((r) => ({
    date: r.date,
    activeAccounts: r.signersOrganic,
    activeAccountsAllTraffic: r.signersAll,
    newAccounts: r.newSigners,
    returningAccounts: r.returningSigners,
    newShare: share(r.newSigners, r.signersOrganic),
    organicTransactions: r.txOrganic,
    newAccountTransactions: r.newTx,
    returningAccountTransactions: r.returningTx,
    isWindowStart: r.date === windowStart,
  }));
}

/**
 * Growth contribution: average daily active accounts of the current period vs the previous equally long period, split into new
 * and returning accounts. The window-start day never enters a period (its "new" count is the whole active base).
 */
export function growthContribution(rows: AccountDay[], windowStart: string, to: string, days: number) {
  const curFrom = addDaysIso(to, -(days - 1));
  const prevTo = addDaysIso(curFrom, -1);
  const prevFrom = addDaysIso(prevTo, -(days - 1));
  const pick = (a: string, b: string) =>
    rows.filter((r) => r.date >= a && r.date <= b && r.date !== windowStart);
  const cur = pick(curFrom, to);
  const prev = pick(prevFrom, prevTo);
  const avg = (rs: AccountDay[], f: (r: AccountDay) => number): number | null =>
    rs.length ? sum(rs.map(f)) / rs.length : null;
  const d = (a: number | null, b: number | null): number | null => (a !== null && b !== null ? a - b : null);
  const avgActive = {
    current: avg(cur, (r) => r.signersOrganic),
    previous: avg(prev, (r) => r.signersOrganic),
  };
  const avgNew = { current: avg(cur, (r) => r.newSigners), previous: avg(prev, (r) => r.newSigners) };
  const avgRet = {
    current: avg(cur, (r) => r.returningSigners),
    previous: avg(prev, (r) => r.returningSigners),
  };
  const change = d(avgActive.current, avgActive.previous);
  return {
    current: { from: curFrom, to, daysWithData: cur.length },
    previous: { from: prevFrom, to: prevTo, daysWithData: prev.length },
    complete: cur.length === days && prev.length === days,
    averageDailyActiveAccounts: avgActive,
    averageDailyNewAccounts: avgNew,
    averageDailyReturningAccounts: avgRet,
    change,
    newAccountContribution: d(avgNew.current, avgNew.previous),
    returningAccountContribution: d(avgRet.current, avgRet.previous),
    note: "Contributions are differences of period averages; new + returning contribution = change in average daily active accounts (exact).",
  };
}

/** Concentration of organic activity per day and over the range; every share is exact (counts from the scan). */
export function accountConcentration(rows: AccountDay[]) {
  const daily = rows.map((r) => ({
    date: r.date,
    activeAccounts: r.signersOrganic,
    top1PctAccounts: r.top1PctSigners,
    top1PctShare: share(r.top1PctTx, r.txOrganic),
    top5PctShare: share(r.top5PctTx, r.txOrganic),
    top10AccountsShare: share(r.top10Tx, r.txOrganic),
    headAccounts: r.headSigners,
    headShare: share(r.headTx, r.txOrganic),
    tailAccounts: r.tailSigners,
    tailShare: share(r.tailTx, r.txOrganic),
  }));
  const tx = sum(rows.map((r) => r.txOrganic));
  return {
    daily,
    range: {
      days: rows.length,
      top1PctShare: share(sum(rows.map((r) => r.top1PctTx)), tx),
      top5PctShare: share(sum(rows.map((r) => r.top5PctTx)), tx),
      top10AccountsShare: share(sum(rows.map((r) => r.top10Tx)), tx),
      headShare: share(sum(rows.map((r) => r.headTx)), tx),
      note: "Range shares are transaction-weighted averages of the daily shares (sum of numerators over sum of organic transactions); the top group is recomputed each day.",
    },
  };
}

/** Weekly retention by first-seen cohort week. Cell = cohort accounts active again k weeks later; rate = cell / cohort size. */
export function cohortRetention(cells: RetentionCell[], windowStart: string, lastDay: string) {
  const sizes = new Map<string, number>();
  for (const c of cells) if (c.cohortWeek === c.activeWeek) sizes.set(c.cohortWeek, c.signers);
  const weekDiff = (a: string, b: string): number =>
    Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (7 * 86_400_000));
  const lastWeekStart = addDaysIso(lastDay, -((new Date(`${lastDay}T00:00:00Z`).getUTCDay() + 6) % 7));
  const byCohort = new Map<
    string,
    Array<{ weekOffset: number; activeWeek: string; accounts: number; rate: number | null }>
  >();
  for (const c of cells) {
    const size = sizes.get(c.cohortWeek) ?? 0;
    const l = byCohort.get(c.cohortWeek) ?? [];
    l.push({
      weekOffset: weekDiff(c.cohortWeek, c.activeWeek),
      activeWeek: c.activeWeek,
      accounts: c.signers,
      rate: share(c.signers, size),
    });
    byCohort.set(c.cohortWeek, l);
  }
  const firstWeekStart = addDaysIso(
    windowStart,
    -((new Date(`${windowStart}T00:00:00Z`).getUTCDay() + 6) % 7),
  );
  return {
    windowStart,
    cohorts: [...byCohort.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cohortWeek, weeks]) => ({
        cohortWeek,
        cohortSize: sizes.get(cohortWeek) ?? 0,
        isWindowStartCohort: cohortWeek === firstWeekStart,
        // the last week of the window is usually partial: its rate is a lower bound
        weeks: weeks
          .sort((a, b) => a.weekOffset - b.weekOffset)
          .map((w) => ({ ...w, partialWeek: w.activeWeek === lastWeekStart })),
      })),
    notes: [
      "Cohort = week of an account's first organic transaction SEEN SINCE the window start. The first cohort week contains every account already active at the window start (a mixed base, not true new accounts).",
      "The final week of the window can be partial; its retention is a lower bound.",
    ],
  };
}

/** Heuristic label only: frequency of organic transactions, never an identity or a bot verdict. */
export function frequencyLabel(maxDayTx: number, headDays: number, days: number): string {
  if (headDays >= days * 0.9 && maxDayTx >= 1000) return "very_high_frequency_account";
  if (maxDayTx >= 1000) return "bursty_high_frequency_account";
  return "high_frequency_account";
}

export function highFrequency(rows: HeadAccountRow[], days: AccountDay[], threshold: number) {
  const orgTx = sum(days.map((d) => d.txOrganic));
  const headTx = sum(days.map((d) => d.headTx));
  return {
    definition: `Head account on a day = at least ${threshold} organic transactions that day (exact, from the scan).`,
    headShareOfOrganicTransactions: share(headTx, orgTx),
    accounts: rows.map((r) => ({
      ...r,
      shareOfOrganicTransactions: share(r.txOrganic, orgTx),
      frequencyLabel: frequencyLabel(r.maxDayTx, r.headDays, days.length),
    })),
    caveat:
      "Labels describe transaction frequency only. High frequency is not proof of a bot, a person or any identity (final_master_prompt s6).",
  };
}

export const ACCOUNT_META = { caveats: ACCOUNT_CAVEATS, accountsArePeople: false as const };

export interface AccountApiContext {
  src: AccountDataSource;
}
