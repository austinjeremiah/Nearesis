import type { AlertPayload, Querier } from "./types.ts";

/**
 * ONE global model-spend ceiling for the whole system (final_master_prompt s18). It is not per workspace and not per
 * day: every `ai_tokens` spend of every tenant and workspace counts against the same USD 5. The constant is a hard
 * maximum: the owner may lower the ceiling (`setGlobalPolicy`), the database refuses anything above it, and raising it
 * needs a code change and a new owner approval (ADR-20261110-003).
 */
export const MODEL_SPEND_CEILING_USD = 5;
/** The cost dimension that is model spend. */
export const MODEL_DIMENSION = "ai_tokens" as const;
export const GLOBAL_EPS = 1e-12;

export const GLOBAL_ADVISORY_LOCK = "cost:global-model-ceiling";

export interface GlobalPolicy {
  modelCeilingUsd: number;
  hardMaxUsd: number;
  alertThresholds: number[];
  updatedAt: string;
}

export async function readGlobalPolicy(q: Querier): Promise<GlobalPolicy> {
  const r = await q.query(
    "SELECT model_ceiling_usd::float8 AS c, alert_thresholds, updated_at FROM runtime.cost_global_policy WHERE id=1",
  );
  const row = r.rows[0];
  return {
    modelCeilingUsd: Math.min(row ? (row.c as number) : MODEL_SPEND_CEILING_USD, MODEL_SPEND_CEILING_USD),
    hardMaxUsd: MODEL_SPEND_CEILING_USD,
    alertThresholds: (row?.alert_thresholds as number[] | undefined) ?? [0.5, 0.8, 0.95],
    updatedAt: row ? new Date(row.updated_at as string).toISOString() : new Date(0).toISOString(),
  };
}

/** Owner action. Lowering only: a value above the authorised USD 5 is refused here and by a database CHECK. */
export async function setGlobalPolicy(
  q: Querier,
  p: { modelCeilingUsd?: number; alertThresholds?: number[] },
  now: Date,
): Promise<GlobalPolicy> {
  if (p.modelCeilingUsd !== undefined) {
    if (!Number.isFinite(p.modelCeilingUsd) || p.modelCeilingUsd < 0)
      throw new Error("modelCeilingUsd must be a finite number >= 0");
    if (p.modelCeilingUsd > MODEL_SPEND_CEILING_USD)
      throw new Error(
        `modelCeilingUsd ${p.modelCeilingUsd} is above the authorised global ceiling USD ${MODEL_SPEND_CEILING_USD}`,
      );
  }
  for (const t of p.alertThresholds ?? [])
    if (!(t > 0 && t <= 1)) throw new Error("alertThresholds must be fractions in (0, 1]");
  await q.query(
    `UPDATE runtime.cost_global_policy SET
       model_ceiling_usd = COALESCE($1::numeric, model_ceiling_usd),
       alert_thresholds = COALESCE($2::jsonb, alert_thresholds), updated_at = $3 WHERE id=1`,
    [
      p.modelCeilingUsd ?? null,
      p.alertThresholds ? JSON.stringify(p.alertThresholds) : null,
      now.toISOString(),
    ],
  );
  return readGlobalPolicy(q);
}

/** Spend that already happened outside the Postgres ledger and still counts against the ceiling (e.g. the inference spend file). */
export type ExternalModelSpend = () => Promise<number>;

export interface GlobalCommitted {
  settledUsd: number;
  reservedUsd: number;
  externalUsd: number;
  committedUsd: number;
  unknownPriceEntries: number;
}

export async function readGlobalCommitted(
  q: Querier,
  external?: ExternalModelSpend,
): Promise<GlobalCommitted> {
  const r = await q.query(
    `SELECT COALESCE(SUM(usd) FILTER (WHERE state='settled'),0)::float8 AS settled,
            COALESCE(SUM(usd) FILTER (WHERE state='reserved'),0)::float8 AS reserved,
            count(*) FILTER (WHERE price_unknown AND state<>'released')::int AS unknown
       FROM runtime.cost_global_model_spend`,
  );
  const ext = external ? await external() : 0;
  if (!Number.isFinite(ext) || ext < 0) throw new Error("external model spend must be a finite number >= 0");
  const settledUsd = r.rows[0].settled as number;
  const reservedUsd = r.rows[0].reserved as number;
  return {
    settledUsd,
    reservedUsd,
    externalUsd: ext,
    committedUsd: settledUsd + reservedUsd + ext,
    unknownPriceEntries: r.rows[0].unknown as number,
  };
}

export interface GlobalForecast {
  label: "projection";
  method: "trailing_24h_rate";
  /** Plain-language assumptions the projection rests on; shown with the number, never separated from it. */
  assumptions: string[];
  rate24hUsdPerHour: number;
  projectedExhaustionAt: string | null;
  projected30DayUsd: number | null;
  confidence: "ok" | "insufficient_data";
}

export interface GlobalSpendStatus {
  scope: "global";
  currency: "USD";
  /** Effective ceiling (owner-set, never above `hardMaxUsd`). */
  ceilingUsd: number;
  hardMaxUsd: number;
  settledUsd: number;
  reservedUsd: number;
  /** Spend counted from outside the Postgres ledger (the inference spend file); 0 when none is configured. */
  externalUsd: number;
  committedUsd: number;
  remainingUsd: number;
  fraction: number;
  state: "ok" | "warning" | "exhausted";
  /** Entries whose price was unknown: they are listed, never counted as 0 and never hidden. */
  unknownPriceEntries: number;
  thresholds: Array<{ fraction: number; usd: number; reached: boolean }>;
  forecast: GlobalForecast;
  asOf: string;
}

export async function readGlobalSpend(
  q: Querier,
  now: Date,
  external?: ExternalModelSpend,
): Promise<GlobalSpendStatus> {
  const [policy, c] = await Promise.all([readGlobalPolicy(q), readGlobalCommitted(q, external)]);
  const last24 = await q.query(
    `SELECT COALESCE(SUM(usd),0)::float8 AS usd, count(*)::int AS n FROM runtime.cost_global_model_spend
      WHERE state IN ('reserved','settled') AND created_at >= $1`,
    [new Date(now.getTime() - 86_400_000).toISOString()],
  );
  const rate = (last24.rows[0].usd as number) / 24;
  const remaining = Math.max(0, policy.modelCeilingUsd - c.committedUsd);
  const enough = (last24.rows[0].n as number) >= 3;
  const fraction = policy.modelCeilingUsd > 0 ? c.committedUsd / policy.modelCeilingUsd : 1;
  const assumptions = [
    "Linear: the trailing 24 hour model spend rate continues unchanged.",
    "Counts reserved (not yet settled) spend as spent; counts spend recorded outside the ledger when configured.",
    "Entries with an unknown price are excluded from the rate and listed separately; the real figure may be higher.",
    "Needs at least 3 entries in the last 24 hours; with fewer, no projection is made.",
  ];
  return {
    scope: "global",
    currency: "USD",
    ceilingUsd: policy.modelCeilingUsd,
    hardMaxUsd: policy.hardMaxUsd,
    settledUsd: c.settledUsd,
    reservedUsd: c.reservedUsd,
    externalUsd: c.externalUsd,
    committedUsd: c.committedUsd,
    remainingUsd: remaining,
    fraction,
    state:
      c.committedUsd >= policy.modelCeilingUsd - GLOBAL_EPS
        ? "exhausted"
        : fraction >= 0.8
          ? "warning"
          : "ok",
    unknownPriceEntries: c.unknownPriceEntries,
    thresholds: [...policy.alertThresholds, 1]
      .sort((a, b) => a - b)
      .map((t) => ({ fraction: t, usd: t * policy.modelCeilingUsd, reached: fraction >= t - GLOBAL_EPS })),
    forecast: {
      label: "projection",
      method: "trailing_24h_rate",
      assumptions,
      rate24hUsdPerHour: rate,
      projectedExhaustionAt:
        enough && rate > 0 ? new Date(now.getTime() + (remaining / rate) * 3_600_000).toISOString() : null,
      projected30DayUsd: enough ? c.committedUsd + rate * 24 * 30 : null,
      confidence: enough ? "ok" : "insufficient_data",
    },
    asOf: now.toISOString(),
  };
}

/** Alert for a threshold crossing of the global ceiling (platform scope: tenant and workspace are null). */
export function globalThresholdAlerts(
  thresholds: number[],
  ceilingUsd: number,
  beforeUsd: number,
  afterUsd: number,
): AlertPayload[] {
  if (ceilingUsd <= 0) return [];
  const before = beforeUsd / ceilingUsd;
  const after = afterUsd / ceilingUsd;
  const out: AlertPayload[] = [];
  for (const t of new Set([...thresholds, 1])) {
    if (before < t - GLOBAL_EPS && after >= t - GLOBAL_EPS)
      out.push({
        tenantId: null,
        workspaceId: null,
        key: `cost.global_threshold:${t}:${ceilingUsd}`,
        kind: "cost.global_threshold",
        severity: t >= 1 ? "critical" : "warning",
        title: `Global model spend reached ${(t * 100).toFixed(0)}% of the USD ${ceilingUsd} ceiling`,
        detail: { threshold: t, fraction: after, ceilingUsd, committedUsd: afterUsd },
      });
  }
  return out;
}
