import type { AccountDataSource } from "../accounts/types.ts";
import { ACCOUNT_CAVEATS } from "../accounts/types.ts";
import { addDaysIso, coverageOf } from "../accounts/metrics.ts";

/** Replaces CANNOT_COMPUTE_UNIQUE_USERS (A17) once the per-signer scan is loaded. Additive: metrics.ts is untouched. */
export const ENTITY_SIGNER_BASIS = {
  unit: "signer account (not a person)",
  attribution:
    "A signer is counted for an entity on a day when it signed at least one transaction whose receiver the registry attributes to that entity (verified or inferred mapping, exact beats suffix, effective-dated). Entity counts are exact per day.",
  notAdditive:
    "Daily distinct counts are not additive across days or across entities: a signer using two entities, or active on two days, is counted in each. Window-level distinct signers are therefore not derivable from daily rows.",
} as const;

export const WINDOW_DISTINCT_CANNOT_COMPUTE = {
  state: "CANNOT_COMPUTE" as const,
  reasonCode: "WINDOW_DISTINCT_NOT_ADDITIVE",
  message:
    "Exact distinct signers over a multi-day window need signer sets; the loaded scan stores exact per-day distinct counts only. Bounds are reported instead.",
};

export interface EntitySignersDay {
  date: string;
  signers: number;
  transactions: number;
  organicSigners: number;
  organicTransactions: number;
}

export type EntityUniqueSigners =
  | {
      state: "COMPUTED";
      entityId: string;
      from: string;
      to: string;
      basis: typeof ENTITY_SIGNER_BASIS;
      windowStart: string;
      coverage: { requestedDays: number; daysWithData: number; missingDays: string[] };
      daily: EntitySignersDay[];
      summary: {
        averageDailySigners: number | null;
        peakDailySigners: number | null;
        signerDays: number;
        averageDailyOrganicSigners: number | null;
        organicSignerDays: number;
        transactions: number;
        organicTransactions: number;
        windowDistinctSigners: typeof WINDOW_DISTINCT_CANNOT_COMPUTE & {
          lowerBound: number | null;
          upperBound: number;
        };
      };
      organicNote: string | null;
      caveats: readonly string[];
    }
  | {
      state: "CANNOT_COMPUTE";
      entityId: string;
      reasonCode: "PER_SIGNER_SOURCE_MISSING" | "RANGE_OUTSIDE_LOADED_WINDOW";
      message: string;
      loadedWindow: { from: string; to: string } | null;
    };

/**
 * Exact per-day distinct signers (and transactions) for one registry entity over [from, to]. A covered day with no bucket row is
 * an exact zero (the scan saw every transaction); a day outside the scan's coverage is a gap, never zero.
 */
export async function entityUniqueSigners(
  src: AccountDataSource,
  entityId: string,
  from: string,
  to: string,
): Promise<EntityUniqueSigners> {
  const w = await src.window();
  if (!w)
    return {
      state: "CANNOT_COMPUTE",
      entityId,
      reasonCode: "PER_SIGNER_SOURCE_MISSING",
      message: "The per-signer scan has not been loaded into nearesis_live.",
      loadedWindow: null,
    };
  const f = from < w.from ? w.from : from;
  const t = to > w.to ? w.to : to;
  if (f > t)
    return {
      state: "CANNOT_COMPUTE",
      entityId,
      reasonCode: "RANGE_OUTSIDE_LOADED_WINDOW",
      message: "The requested range does not overlap the days covered by the per-signer scan.",
      loadedWindow: { from: w.from, to: w.to },
    };
  const rows = await src.entityDays(entityId, f, t);
  const by = new Map(rows.map((r) => [r.date, r]));
  const covered = w.days.filter((d) => d >= f && d <= t);
  const daily: EntitySignersDay[] = covered.map((d) => {
    const r = by.get(d);
    return {
      date: d,
      signers: r?.signersAll ?? 0,
      transactions: r?.txAll ?? 0,
      organicSigners: r?.signersOrganic ?? 0,
      organicTransactions: r?.txOrganic ?? 0,
    };
  });
  const signerDays = daily.reduce((a, r) => a + r.signers, 0);
  const organicSignerDays = daily.reduce((a, r) => a + r.organicSigners, 0);
  const peak = daily.length ? Math.max(...daily.map((r) => r.signers)) : null;
  const txs = daily.reduce((a, r) => a + r.transactions, 0);
  const orgTx = daily.reduce((a, r) => a + r.organicTransactions, 0);
  return {
    state: "COMPUTED",
    entityId,
    from: f,
    to: t,
    basis: ENTITY_SIGNER_BASIS,
    windowStart: w.windowStart,
    coverage: coverageOf(w.days, from, to),
    daily,
    summary: {
      averageDailySigners: daily.length ? signerDays / daily.length : null,
      peakDailySigners: peak,
      signerDays,
      averageDailyOrganicSigners: daily.length ? organicSignerDays / daily.length : null,
      organicSignerDays,
      transactions: txs,
      organicTransactions: orgTx,
      windowDistinctSigners: { ...WINDOW_DISTINCT_CANNOT_COMPUTE, lowerBound: peak, upperBound: signerDays },
    },
    organicNote:
      signerDays > 0 && organicSignerDays === 0
        ? "All of this entity's traffic goes to receivers the organic rule excludes (Intents verifier or bridge/omni): zero organic signers by definition, not by absence of activity."
        : null,
    caveats: ACCOUNT_CAVEATS,
  };
}

/** Period-over-period change of average daily signers per entity: current `days` vs the previous equally long period. */
export async function entitySignerChange(src: AccountDataSource, entityId: string, to: string, days: number) {
  const curFrom = addDaysIso(to, -(days - 1));
  const prevTo = addDaysIso(curFrom, -1);
  const prevFrom = addDaysIso(prevTo, -(days - 1));
  const [cur, prev] = await Promise.all([
    entityUniqueSigners(src, entityId, curFrom, to),
    entityUniqueSigners(src, entityId, prevFrom, prevTo),
  ]);
  const a = cur.state === "COMPUTED" ? cur.summary.averageDailySigners : null;
  const b = prev.state === "COMPUTED" ? prev.summary.averageDailySigners : null;
  return {
    entityId,
    current: a,
    previous: b,
    change: a !== null && b !== null ? a - b : null,
    changePct: a !== null && b !== null && b > 0 ? (a - b) / b : null,
    complete:
      cur.state === "COMPUTED" &&
      prev.state === "COMPUTED" &&
      cur.coverage.missingDays.length === 0 &&
      prev.coverage.missingDays.length === 0,
  };
}
