import { Attributor } from "./attribution.ts";
import type { ActivityInput, EntityRow, RegistrySnapshot } from "./types.ts";

export const CANNOT_COMPUTE_UNIQUE_USERS = {
  state: "CANNOT_COMPUTE" as const,
  reasonCode: "PER_SIGNER_SOURCE_MISSING",
  message:
    "Unique accounts per entity need account-level (signer x receiver x day) data. nearesis_live holds only receiver-day interaction counts and heavy-signer aggregates, so unique users cannot be derived and contract counts must not be summed.",
  missingSource:
    "A signer_account_id x receiver_account_id x block_date dataset (BigQuery bigquery-public-data.crypto_near_mainnet_us.transactions/actions grouped by signer and receiver). Not loaded: the billed per-signer query awaits owner approval (see docs/research/sql/per_signer_daily_organic.sql, ~35 GiB, for the related organic-segment query).",
  approvalRequired: "owner approval for a new billed BigQuery query",
};

export interface Coverage {
  totalInteractions: number;
  /** verified + inferred, counted in named entities. */
  classifiedInteractions: number;
  verifiedInteractions: number;
  inferredInteractions: number;
  /** Receivers whose winning mapping is unverified: reported separately, never in a named entity. */
  unverifiedInteractions: number;
  ambiguousInteractions: number;
  /** Listed receivers (>= 100 interactions/day) with no mapping. */
  unclassifiedListedInteractions: number;
  /** Receivers below the per-day listing threshold: cannot be classified by construction. */
  belowThresholdInteractions: number;
  classifiedShare: number;
  verifiedShare: number;
  inferredShare: number;
  unverifiedShare: number;
  ambiguousShare: number;
  unclassifiedShare: number; // listed-unclassified + below-threshold remainder
  belowThresholdShare: number;
  /** Days of the range with / without data rows. A day without rows is unavailable, never zero. */
  daysExpected: number;
  daysWithReceiverData: number;
  daysWithRemainderData: number;
  missingDays: string[];
}

export interface EntityWindow {
  interactions: number;
  verifiedInteractions: number;
  inferredInteractions: number;
  shareOfTotal: number | null;
  shareOfClassified: number | null;
}
export interface EntityMetric {
  entityId: string;
  name: string;
  entityType: string;
  categoryId: string | null;
  current: EntityWindow;
  prior: EntityWindow;
  change: number;
  changePct: number | null;
  /** This entity's share of the total absolute increase of all entities that grew (null when nothing grew). */
  shareOfGrowth: number | null;
  /** Share of the entity's current interactions that rests on inferred (namespace) mappings. */
  inferredShareOfEntity: number | null;
  coverage: { classifiedShare: number; unclassifiedShare: number; windowCoverage: "complete" | "partial" };
}
export interface Window {
  from: string;
  to: string;
  days: number;
}

const DAY = 86_400_000;
export const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};
const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

interface Bucket {
  verified: number;
  inferred: number;
}
interface Tally {
  byEntity: Map<string, Bucket>;
  coverage: Coverage;
}

function tally(att: Attributor, input: ActivityInput, w: Window): Tally {
  const byEntity = new Map<string, Bucket>();
  let unverified = 0,
    ambiguous = 0,
    unclassified = 0,
    below = 0,
    verified = 0,
    inferred = 0;
  const recvDays = new Set<string>();
  const remDays = new Set<string>();
  for (const r of input.receivers) {
    if (r.date < w.from || r.date > w.to) continue;
    recvDays.add(r.date);
    const a = att.resolve(r.receiver, r.date);
    if (a.state === "verified" || a.state === "inferred") {
      const b = byEntity.get(a.entityId) ?? { verified: 0, inferred: 0 };
      b[a.state] += r.interactions;
      byEntity.set(a.entityId, b);
      if (a.state === "verified") verified += r.interactions;
      else inferred += r.interactions;
    } else if (a.state === "unverified") unverified += r.interactions;
    else if (a.state === "ambiguous") ambiguous += r.interactions;
    else unclassified += r.interactions;
  }
  for (const r of input.remainder) {
    if (r.date < w.from || r.date > w.to) continue;
    remDays.add(r.date);
    below += r.interactions;
  }
  const classified = verified + inferred;
  const total = classified + unverified + ambiguous + unclassified + below;
  const expected = daysBetween(w.from, w.to);
  const s = (n: number) => (total > 0 ? n / total : 0);
  const coverage: Coverage = {
    totalInteractions: total,
    classifiedInteractions: classified,
    verifiedInteractions: verified,
    inferredInteractions: inferred,
    unverifiedInteractions: unverified,
    ambiguousInteractions: ambiguous,
    unclassifiedListedInteractions: unclassified,
    belowThresholdInteractions: below,
    classifiedShare: s(classified),
    verifiedShare: s(verified),
    inferredShare: s(inferred),
    unverifiedShare: s(unverified),
    ambiguousShare: s(ambiguous),
    unclassifiedShare: s(unclassified + below),
    belowThresholdShare: s(below),
    daysExpected: expected.length,
    daysWithReceiverData: recvDays.size,
    daysWithRemainderData: remDays.size,
    missingDays: expected.filter((d) => !recvDays.has(d) || !remDays.has(d)),
  };
  return { byEntity, coverage };
}

export interface ChangeReport {
  registryVersion: string;
  metric: "contract_interactions";
  attribution: string;
  current: Window;
  prior: Window;
  currentCoverage: Coverage;
  priorCoverage: Coverage;
  entities: EntityMetric[];
  categories: Array<{
    categoryId: string;
    name: string;
    current: number;
    prior: number;
    change: number;
    changePct: number | null;
  }>;
  totals: {
    current: number;
    prior: number;
    change: number;
    changePct: number | null;
    classifiedChange: number;
    unclassifiedChange: number;
  };
  /** Receivers NOT in a named entity (unclassified or unverified) ranked by change: where the unexplained growth is. */
  unattributedGrowth: Array<{
    receiver: string;
    state: "unclassified" | "unverified" | "ambiguous";
    current: number;
    prior: number;
    change: number;
  }>;
  uniqueUsers: typeof CANNOT_COMPUTE_UNIQUE_USERS;
  notes: string[];
}

/** Period-over-period interactions per entity: [to-days+1, to] versus the preceding window of equal length. */
export function entityChanges(
  reg: RegistrySnapshot,
  input: ActivityInput,
  to: string,
  days: number,
): ChangeReport {
  const att = new Attributor(reg);
  const cur: Window = { from: addDays(to, -(days - 1)), to, days };
  const pri: Window = { from: addDays(to, -(2 * days - 1)), to: addDays(to, -days), days };
  const c = tally(att, input, cur);
  const p = tally(att, input, pri);
  const byId = new Map(reg.entities.map((e) => [e.entityId, e] as const));
  const ids = new Set([...c.byEntity.keys(), ...p.byEntity.keys()]);
  const win = (b: Bucket | undefined, cov: Coverage): EntityWindow => {
    const n = (b?.verified ?? 0) + (b?.inferred ?? 0);
    return {
      interactions: n,
      verifiedInteractions: b?.verified ?? 0,
      inferredInteractions: b?.inferred ?? 0,
      shareOfTotal: ratio(n, cov.totalInteractions),
      shareOfClassified: ratio(n, cov.classifiedInteractions),
    };
  };
  const partial = c.coverage.missingDays.length > 0 || p.coverage.missingDays.length > 0;
  const rows = [...ids].map((id) => {
    const e = byId.get(id) as EntityRow | undefined;
    const current = win(c.byEntity.get(id), c.coverage);
    const prior = win(p.byEntity.get(id), p.coverage);
    const change = current.interactions - prior.interactions;
    return {
      entityId: id,
      name: e?.name ?? id,
      entityType: e?.entityType ?? "unknown",
      categoryId: e?.categoryId ?? null,
      current,
      prior,
      change,
      changePct: prior.interactions > 0 ? change / prior.interactions : null,
      shareOfGrowth: null as number | null,
      inferredShareOfEntity: ratio(current.inferredInteractions, current.interactions),
      coverage: {
        classifiedShare: c.coverage.classifiedShare,
        unclassifiedShare: c.coverage.unclassifiedShare,
        windowCoverage: (partial ? "partial" : "complete") as "complete" | "partial",
      },
    } satisfies EntityMetric;
  });
  const growth = rows.reduce((s, r) => s + Math.max(0, r.change), 0);
  for (const r of rows) r.shareOfGrowth = growth > 0 ? Math.max(0, r.change) / growth : null;
  rows.sort((a, b) => b.change - a.change || a.entityId.localeCompare(b.entityId));

  const catAgg = new Map<string, { current: number; prior: number }>();
  for (const r of rows) {
    if (!r.categoryId) continue;
    const a = catAgg.get(r.categoryId) ?? { current: 0, prior: 0 };
    a.current += r.current.interactions;
    a.prior += r.prior.interactions;
    catAgg.set(r.categoryId, a);
  }
  const categories = [...catAgg]
    .map(([categoryId, a]) => ({
      categoryId,
      name: byId.get(categoryId)?.name ?? categoryId,
      current: a.current,
      prior: a.prior,
      change: a.current - a.prior,
      changePct: a.prior > 0 ? (a.current - a.prior) / a.prior : null,
    }))
    .sort((a, b) => b.change - a.change);

  const un = new Map<
    string,
    { state: "unclassified" | "unverified" | "ambiguous"; current: number; prior: number }
  >();
  for (const r of input.receivers) {
    const inCur = r.date >= cur.from && r.date <= cur.to;
    if (!inCur && !(r.date >= pri.from && r.date <= pri.to)) continue;
    const a = att.resolve(r.receiver, r.date);
    if (a.state === "verified" || a.state === "inferred") continue;
    const x = un.get(r.receiver) ?? { state: a.state, current: 0, prior: 0 };
    if (inCur) x.current += r.interactions;
    else x.prior += r.interactions;
    un.set(r.receiver, x);
  }
  const unattributedGrowth = [...un]
    .map(([receiver, x]) => ({ receiver, ...x, change: x.current - x.prior }))
    .sort((a, b) => b.change - a.change)
    .slice(0, 15);
  const tc = c.coverage.totalInteractions;
  const tp = p.coverage.totalInteractions;
  const classifiedChange = c.coverage.classifiedInteractions - p.coverage.classifiedInteractions;
  return {
    registryVersion: reg.registryVersion,
    metric: "contract_interactions",
    attribution:
      "Each receiver-day goes to at most one entity: exact mapping beats suffix, longer suffix beats shorter, then lower precedence; ties are ambiguous; unverified mappings are not counted in named entities. Entity totals are disjoint and sum to the classified total.",
    current: cur,
    prior: pri,
    currentCoverage: c.coverage,
    priorCoverage: p.coverage,
    entities: rows,
    categories,
    totals: {
      current: tc,
      prior: tp,
      change: tc - tp,
      changePct: tp > 0 ? (tc - tp) / tp : null,
      classifiedChange,
      unclassifiedChange: tc - tp - classifiedChange,
    },
    unattributedGrowth,
    uniqueUsers: CANNOT_COMPUTE_UNIQUE_USERS,
    notes: [
      "Metric = function-call receipts received per contract-day (contract_interactions + exact below-threshold remainder). Interactions are not unique users.",
      "Receivers below 100 interactions/day are only available as an aggregate and are always unclassified.",
    ],
  };
}

export interface DailyPoint {
  date: string;
  interactions: number;
  verifiedInteractions: number;
  inferredInteractions: number;
  totalInteractions: number | null;
  shareOfTotal: number | null;
}

/** Daily series for one entity (daily grain) with the day's total for context. Days without data rows are omitted. */
export function entityDaily(
  reg: RegistrySnapshot,
  input: ActivityInput,
  entityId: string,
  from: string,
  to: string,
): { points: DailyPoint[]; coverage: Coverage; missingDays: string[] } {
  const att = new Attributor(reg);
  const per = new Map<string, DailyPoint>();
  const totals = new Map<string, number>();
  for (const r of input.receivers) {
    if (r.date < from || r.date > to) continue;
    totals.set(r.date, (totals.get(r.date) ?? 0) + r.interactions);
    const a = att.resolve(r.receiver, r.date);
    if ((a.state === "verified" || a.state === "inferred") && a.entityId === entityId) {
      const p = per.get(r.date) ?? {
        date: r.date,
        interactions: 0,
        verifiedInteractions: 0,
        inferredInteractions: 0,
        totalInteractions: null,
        shareOfTotal: null,
      };
      p.interactions += r.interactions;
      if (a.state === "verified") p.verifiedInteractions += r.interactions;
      else p.inferredInteractions += r.interactions;
      per.set(r.date, p);
    }
  }
  for (const r of input.remainder)
    if (r.date >= from && r.date <= to) totals.set(r.date, (totals.get(r.date) ?? 0) + r.interactions);
  const recvDates = new Set(input.receivers.filter((r) => r.date >= from && r.date <= to).map((r) => r.date));
  const points = daysBetween(from, to)
    .filter((d) => recvDates.has(d))
    .map((d) => {
      const p = per.get(d) ?? {
        date: d,
        interactions: 0,
        verifiedInteractions: 0,
        inferredInteractions: 0,
        totalInteractions: null,
        shareOfTotal: null,
      };
      const tot = totals.get(d) ?? null;
      return { ...p, totalInteractions: tot, shareOfTotal: tot ? p.interactions / tot : null };
    });
  const cov = tally(att, input, { from, to, days: daysBetween(from, to).length }).coverage;
  return { points, coverage: cov, missingDays: cov.missingDays };
}

/** Coverage of a window across the whole registry, plus the largest unclassified listed receivers (so gaps are actionable). */
export function windowCoverage(
  reg: RegistrySnapshot,
  input: ActivityInput,
  from: string,
  to: string,
  topUnclassified = 15,
) {
  const att = new Attributor(reg);
  const w = { from, to, days: daysBetween(from, to).length };
  const { coverage } = tally(att, input, w);
  const un = new Map<string, number>();
  const unv = new Map<string, number>();
  for (const r of input.receivers) {
    if (r.date < from || r.date > to) continue;
    const a = att.resolve(r.receiver, r.date);
    if (a.state === "unclassified") un.set(r.receiver, (un.get(r.receiver) ?? 0) + r.interactions);
    if (a.state === "unverified") unv.set(r.receiver, (unv.get(r.receiver) ?? 0) + r.interactions);
  }
  const top = (m: Map<string, number>) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topUnclassified)
      .map(([receiver, interactions]) => ({ receiver, interactions }));
  return { window: w, coverage, topUnclassifiedReceivers: top(un), topUnverifiedReceivers: top(unv) };
}
