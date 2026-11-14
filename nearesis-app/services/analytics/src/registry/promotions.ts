import type pg from "pg";
import type { MetricMetadata } from "@nearesis/contracts";
import { queryRows, type ClickHouseClient } from "../ch.ts";
import { bumpMinor, canonicalJson, sealRegistry, sha256 } from "./registry.ts";
import type { DependentsFile, Evaluator, Registry } from "./types.ts";

export type RegistryReason =
  | "UNAPPROVED_DEFINITION"
  | "EXPERIMENTAL_PROMOTION_REFUSED"
  | "UNKNOWN_METRIC"
  | "DIFF_REQUIRED"
  | "SELF_APPROVAL_REFUSED"
  | "STALE_PROPOSAL";
export class RegistryError extends Error {
  constructor(
    readonly reason: RegistryReason,
    message: string,
  ) {
    super(message);
  }
}

export interface ChangeProposal {
  metricId: string;
  /** Fields of MetricMetadata to replace (id and certified are never patchable here). */
  patch: Partial<Omit<MetricMetadata, "id" | "certified" | "certifiedVersion">>;
  /** Replacement machine-evaluable definition; undefined keeps the current one. */
  evaluator?: Evaluator | null;
}

/** Pure: the registry that results if `change` were approved. Bumps the minor version and the content hash. */
export function applyChange(base: Registry, change: ChangeProposal): Registry {
  const m = base.metrics.find((x) => x.id === change.metricId);
  if (!m) throw new RegistryError("UNKNOWN_METRIC", `unknown metric ${change.metricId}`);
  const semanticVersion = bumpMinor(base.semanticVersion);
  const metrics = base.metrics.map((x) =>
    x.id === m.id ? { ...x, ...change.patch, certifiedVersion: semanticVersion } : x,
  );
  const evaluators = { ...base.evaluators };
  if (change.evaluator !== undefined) evaluators[m.id] = change.evaluator;
  return sealRegistry({ ...base, semanticVersion, metrics, evaluators });
}

export interface SeriesStats {
  days: number;
  daysWithValue: number;
  nullDays: number;
  mean: number | null;
  total: string | null;
  coverageCompleteDays: number;
}

/** Daily series of an evaluator from ClickHouse FINAL data. Names are allowlisted by the Evaluator schema; values are bound. */
export async function evaluate(
  ch: ClickHouseClient,
  ev: Evaluator,
  fromDay: string,
  toDay: string,
): Promise<Map<string, string>> {
  const params: Record<string, unknown> = { f: fromDay, t: toDay };
  const where = [`${ev.dayColumn} >= {f:Date}`, `${ev.dayColumn} <= {t:Date}`];
  const ops = { eq: "=", neq: "!=", gte: ">=", lte: "<=", gt: ">", lt: "<" } as const;
  ev.filters.forEach((fl, i) => {
    params[`p${i}`] = fl.value;
    where.push(`${fl.column} ${ops[fl.op]} {p${i}:${typeof fl.value === "number" ? "Float64" : "String"}}`);
  });
  const agg = ev.agg === "count" ? "count()" : `${ev.agg}(${ev.column})`;
  const rows = await queryRows<{ d: string; v: string | number | null }>(
    ch,
    `SELECT toString(${ev.dayColumn}) AS d, toString(${agg}) AS v FROM ${ev.table} FINAL WHERE ${where.join(" AND ")} GROUP BY ${ev.dayColumn} ORDER BY ${ev.dayColumn}`,
    params,
  );
  return new Map(rows.filter((r) => r.v !== null).map((r) => [r.d, String(r.v)]));
}

function stats(series: Map<string, string>, allDays: string[], completeDays: number): SeriesStats {
  const vals = [...series.values()].map(Number);
  return {
    days: allDays.length,
    daysWithValue: vals.length,
    nullDays: allDays.length - vals.length,
    mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    total: vals.length ? String(vals.reduce((a, b) => a + b, 0)) : null,
    coverageCompleteDays: completeDays,
  };
}

const daysOf = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

export interface DiffReport {
  metricId: string;
  fromVersion: string;
  toVersion: string;
  window: { from: string; to: string };
  old: SeriesStats;
  new: SeriesStats;
  deltaMean: number | null;
  columnChanges: Array<{ field: string; from: unknown; to: unknown }>;
  resultColumns: { old: string[]; new: string[] };
  dependentPanels: string[];
  dependentClaims: string[];
  statisticalOutputChange: { meanChangePct: number | null; seriesDiffDays: number };
  oldHash: string;
  newHash: string;
}

/** Dataset-backed diff (ch.06 "Metric drift and registry review"): old vs new definition evaluated on the loaded dataset. */
export async function diffChange(
  ch: ClickHouseClient,
  base: Registry,
  change: ChangeProposal,
  window: { from: string; to: string },
  dependents: DependentsFile = { panels: {}, claims: {} },
): Promise<DiffReport> {
  const next = applyChange(base, change);
  const oldM = base.metrics.find((m) => m.id === change.metricId)!;
  const newM = next.metrics.find((m) => m.id === change.metricId)!;
  const oldEv = base.evaluators[change.metricId];
  const newEv = next.evaluators[change.metricId];
  const days = daysOf(window.from, window.to);
  const covComplete = async (m: MetricMetadata) => {
    const [provider, dataset] = [m.sources[0]!.split(":")[0]!, m.sources[0]!.split(":")[1]!];
    const r = await queryRows<{ n: string }>(
      ch,
      `SELECT toString(countIf(state = 'complete')) AS n FROM source_coverage FINAL WHERE provider_id = {p:String} AND dataset = {d:String} AND day >= {f:Date} AND day <= {t:Date}`,
      { p: provider, d: dataset, f: window.from, t: window.to },
    );
    return Number(r[0]?.n ?? 0);
  };
  const oldSeries = oldEv ? await evaluate(ch, oldEv, window.from, window.to) : new Map<string, string>();
  const newSeries = newEv ? await evaluate(ch, newEv, window.from, window.to) : new Map<string, string>();
  const o = stats(oldSeries, days, await covComplete(oldM));
  const n = stats(newSeries, days, await covComplete(newM));
  const columnChanges: DiffReport["columnChanges"] = [];
  for (const k of Object.keys(change.patch) as Array<keyof MetricMetadata>)
    if (canonicalJson(oldM[k]) !== canonicalJson(newM[k]))
      columnChanges.push({ field: k, from: oldM[k], to: newM[k] });
  if (change.evaluator !== undefined && canonicalJson(oldEv) !== canonicalJson(newEv))
    columnChanges.push({ field: "evaluator", from: oldEv, to: newEv });
  const diffDays = days.filter((d) => oldSeries.get(d) !== newSeries.get(d)).length;
  const col = (m: MetricMetadata) => [m.id, `${m.id}__coverage`];
  return {
    metricId: change.metricId,
    fromVersion: base.semanticVersion,
    toVersion: next.semanticVersion,
    window,
    old: o,
    new: n,
    deltaMean: o.mean !== null && n.mean !== null ? n.mean - o.mean : null,
    columnChanges,
    resultColumns: { old: col(oldM), new: col(newM) },
    dependentPanels: dependents.panels[change.metricId] ?? [],
    dependentClaims: dependents.claims[change.metricId] ?? [],
    statisticalOutputChange: {
      meanChangePct: o.mean && n.mean !== null ? ((n.mean - o.mean) / o.mean) * 100 : null,
      seriesDiffDays: diffDays,
    },
    oldHash: base.contentHash,
    newHash: next.contentHash,
  };
}

export const diffHash = (d: DiffReport) => sha256(canonicalJson(d));

type Row = {
  id: string;
  metric_id: string;
  kind: string;
  status: "proposed" | "approved" | "rejected";
  from_hash: string;
  proposal: ChangeProposal & { promote?: boolean };
  diff_report: DiffReport | null;
  diff_hash: string | null;
  proposed_by: string;
  approver: string | null;
  to_version: string | null;
  to_hash: string | null;
  reason_code: string | null;
};

const q = (pool: pg.Pool, text: string, vals: unknown[] = []) => pool.query(text, vals);

/** Records a definition change as PROPOSED. It is inactive: activeRegistry() ignores it until approval. */
export async function proposeChange(
  pool: pg.Pool,
  base: Registry,
  change: ChangeProposal,
  proposer: string,
): Promise<string> {
  applyChange(base, change); // validates
  const r = await q(
    pool,
    `INSERT INTO analytics_meta.metric_promotions (metric_id, kind, status, from_version, from_hash, proposal, proposed_by)
     VALUES ($1, 'definition_change', 'proposed', $2, $3, $4, $5) RETURNING id`,
    [change.metricId, base.semanticVersion, base.contentHash, JSON.stringify(change), proposer],
  );
  return String(r.rows[0].id);
}

export async function attachDiff(pool: pg.Pool, id: string, report: DiffReport): Promise<string> {
  const h = diffHash(report);
  await q(
    pool,
    "UPDATE analytics_meta.metric_promotions SET diff_report = $2, diff_hash = $3 WHERE id = $1 AND status = 'proposed'",
    [id, JSON.stringify(report), h],
  );
  return h;
}

/** Approval needs a stored diff and a reviewer other than the proposer. Returns the new (N+1) registry. */
export async function approveChange(
  pool: pg.Pool,
  base: Registry,
  id: string,
  approver: string,
): Promise<Registry> {
  const row = (await q(pool, "SELECT * FROM analytics_meta.metric_promotions WHERE id = $1", [id]))
    .rows[0] as Row | undefined;
  if (!row || row.status !== "proposed")
    throw new RegistryError("UNAPPROVED_DEFINITION", `proposal ${id} is not open`);
  if (row.from_hash !== base.contentHash)
    throw new RegistryError("STALE_PROPOSAL", "registry changed since the proposal was made");
  if (!row.diff_report || !row.diff_hash)
    throw new RegistryError("DIFF_REQUIRED", "a dataset-backed diff must be attached before approval");
  if (row.proposed_by === approver)
    throw new RegistryError("SELF_APPROVAL_REFUSED", "reviewer must differ from the proposer");
  const next = applyChange(base, row.proposal);
  await q(
    pool,
    `UPDATE analytics_meta.metric_promotions SET status = 'approved', approver = $2, to_version = $3, to_hash = $4, decided_at = now() WHERE id = $1`,
    [id, approver, next.semanticVersion, next.contentHash],
  );
  return next;
}

/** The registry that queries resolve against: base plus approved changes in order. Proposed changes are never active. */
export async function activeRegistry(pool: pg.Pool, base: Registry): Promise<Registry> {
  const rows = (
    await q(
      pool,
      "SELECT * FROM analytics_meta.metric_promotions WHERE status = 'approved' AND kind = 'definition_change' AND from_version >= $1 ORDER BY id",
      [base.semanticVersion],
    )
  ).rows as Row[];
  let cur = base;
  for (const r of rows) if (r.from_hash === cur.contentHash) cur = applyChange(cur, r.proposal);
  return cur;
}

/**
 * Promotion of a (workspace-scoped) experimental metric into the global certified catalog. Without a reviewer it is
 * refused and recorded; the refusal is part of the audit trail. Returns the promoted registry when a reviewer approves.
 */
export async function requestPromotion(
  pool: pg.Pool,
  base: Registry,
  metricId: string,
  requester: string,
  reviewer?: string,
): Promise<Registry> {
  const m = base.metrics.find((x) => x.id === metricId);
  if (!m) throw new RegistryError("UNKNOWN_METRIC", `unknown metric ${metricId}`);
  const refuse = async (why: string) => {
    await q(
      pool,
      `INSERT INTO analytics_meta.metric_promotions (metric_id, kind, status, from_version, from_hash, proposal, proposed_by, reason_code, decided_at)
       VALUES ($1, 'promotion', 'rejected', $2, $3, $4, $5, 'EXPERIMENTAL_PROMOTION_REFUSED', now())`,
      [
        metricId,
        base.semanticVersion,
        base.contentHash,
        JSON.stringify({ metricId, patch: {}, promote: true, why }),
        requester,
      ],
    );
    throw new RegistryError("EXPERIMENTAL_PROMOTION_REFUSED", why);
  };
  if (m.certified) return base;
  if (!reviewer) return refuse("experimental metrics cannot be promoted without review");
  if (reviewer === requester) return refuse("reviewer must differ from the requester");
  const semanticVersion = bumpMinor(base.semanticVersion);
  const next = sealRegistry({
    ...base,
    semanticVersion,
    metrics: base.metrics.map((x) =>
      x.id === metricId ? { ...x, certified: true, certifiedVersion: semanticVersion } : x,
    ),
  });
  await q(
    pool,
    `INSERT INTO analytics_meta.metric_promotions (metric_id, kind, status, from_version, to_version, from_hash, to_hash, proposal, proposed_by, approver, decided_at)
     VALUES ($1, 'promotion', 'approved', $2, $3, $4, $5, $6, $7, $8, now())`,
    [
      metricId,
      base.semanticVersion,
      semanticVersion,
      base.contentHash,
      next.contentHash,
      JSON.stringify({ metricId, patch: {}, promote: true }),
      requester,
      reviewer,
    ],
  );
  return next;
}

/** Panels label experimental metrics as unverified (S12 d). */
export const verificationLabel = (m: MetricMetadata): "certified" | "unverified" =>
  m.certified ? "certified" : "unverified";
