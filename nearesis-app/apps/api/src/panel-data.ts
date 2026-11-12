import { Redis } from "ioredis";
import type { AnalyticsPanelData, DataFrameEnvelope, PanelDataResponse } from "@nearesis/contracts";
import {
  ClickHouseAccountSource,
  ClickHouseEntitySource,
  IntentsAnalytics,
  CUBE_URL_DEFAULT,
  LIVE_CUBE_URL_DEFAULT,
  LIVE_DATABASE,
  createCh,
  createPg,
  defaultCubeSecret,
  loadLiveRegistry,
  loadQuery,
  loadRegistry,
  panelDataForHash,
  type AnalyticsDeps,
  type Registry,
  type StoredAnalyticsPanel,
} from "@nearesis/analytics";
import {
  DEFAULT_POLICY,
  createGateway,
  type EstimateResult,
  type QueryResult,
  type Session as GatewaySession,
} from "@nearesis/semantic-gateway";
import { hashCanonical } from "@nearesis/canvas-schema";

export type DataSource = "fixture" | "live";

/** What a stored query hash names. Unknown hashes are `null`; the stored `kind` decides which engine answers. */
export type StoredQuery =
  { kind: "semantic"; ast: unknown; source: DataSource } | { kind: "analytics"; ast: unknown };

/**
 * The API process's access to the data layer. Production: `createPanelDataPort()` (the same guarded semantic gateway the
 * agents use, plus the analytics capabilities). Tests inject a fake: nothing else in this file touches ClickHouse, Cube
 * or Redis.
 */
export interface PanelDataPort {
  stored(hash: string, sourceOverride?: DataSource): Promise<StoredQuery | null>;
  query(session: GatewaySession, ast: unknown, source: DataSource): Promise<QueryResult>;
  estimate(session: GatewaySession, ast: unknown, source: DataSource): Promise<EstimateResult>;
  registry(source: DataSource): Registry;
  analytics(hash: string): Promise<StoredAnalyticsPanel>;
  close(): Promise<void>;
}

const ZERO_PANEL = "00000000-0000-4000-8000-000000000000";

export function createPanelDataPort(
  o: { analyticsDeps?: AnalyticsDeps; pool?: ReturnType<typeof createPg> } = {},
): PanelDataPort {
  const registries: Partial<Record<DataSource, Registry>> = {};
  const registry = (s: DataSource): Registry =>
    (registries[s] ??= s === "live" ? loadLiveRegistry() : loadRegistry());
  let pool: ReturnType<typeof createPg> | null = o.pool ?? null;
  const pg = () => (pool ??= createPg());
  let redis: Redis | null = null;
  const chs: Partial<Record<DataSource, ReturnType<typeof createCh>>> = {};
  let analyticsCh: ReturnType<typeof createCh> | null = null;
  const gateways: Partial<Record<DataSource, ReturnType<typeof createGateway>>> = {};
  const gateway = (s: DataSource) => {
    const have = gateways[s];
    if (have) return have;
    const live = s === "live";
    redis ??= new Redis(process.env.NEARESIS_REDIS_URL ?? "redis://127.0.0.1:56379", {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });
    const ch = (chs[s] ??= live ? createCh({ database: LIVE_DATABASE }) : createCh());
    return (gateways[s] = createGateway({
      cubeUrl: live
        ? (process.env.CUBE_LIVE_URL ?? LIVE_CUBE_URL_DEFAULT)
        : (process.env.CUBE_URL ?? CUBE_URL_DEFAULT),
      cubeSecret: defaultCubeSecret(),
      redis: redis as never,
      registry: registry(s),
      policyResolver: () => ({ ...DEFAULT_POLICY }),
      clock: () => new Date(),
      pg: pg(),
      ch,
    }));
  };
  const deps = (): AnalyticsDeps => {
    if (o.analyticsDeps) return o.analyticsDeps;
    const db = process.env.NEARESIS_CH_LIVE_DATABASE ?? "nearesis_live";
    analyticsCh ??= createCh({ database: db });
    return {
      intents: new IntentsAnalytics(analyticsCh, { database: db }),
      entities: new ClickHouseEntitySource(analyticsCh),
      accounts: new ClickHouseAccountSource(analyticsCh),
    };
  };
  return {
    async stored(hash, sourceOverride) {
      const saved = await loadQuery(pg(), hash);
      if (!saved) return null;
      if ((saved.ast as { kind?: unknown } | null)?.kind === "analytics_call")
        return { kind: "analytics", ast: saved.ast };
      // The stored model hash says which semantic layer the query was written against; `source` overrides it.
      const source: DataSource =
        sourceOverride ??
        (saved.semanticModelHash === registry("fixture").contentHash &&
        saved.semanticModelHash !== registry("live").contentHash
          ? "fixture"
          : "live");
      return { kind: "semantic", ast: saved.ast, source };
    },
    query: (session, ast, source) => gateway(source).query(session, ast),
    estimate: (session, ast, source) => gateway(source).estimate(session, ast),
    registry,
    analytics: (hash) => panelDataForHash(pg(), deps(), hash),
    async close() {
      await Promise.allSettled([
        ...Object.values(chs).map((c) => c.close()),
        analyticsCh?.close(),
        o.pool ? undefined : pool?.end(),
        redis?.quit(),
      ]);
    },
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Chart and freshness timestamps are ISO date-times; an analytics watermark may be a plain day. */
const isoOrNull = (v: string | null | undefined): string | null => {
  if (!v) return null;
  if (DAY.test(v)) return `${v}T00:00:00.000Z`;
  const t = Date.parse(v.includes("T") ? v : v.replace(" ", "T") + "Z");
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

type Panel = Omit<PanelDataResponse, "workspaceId">;

/** Semantic envelope -> the panel response. Pure. Every field is derived from the envelope; nothing is invented. */
export function semanticPanel(
  env: DataFrameEnvelope,
  ast: unknown,
  registry: Registry,
  source: DataSource,
): Panel {
  const a = ast as { measures: string[]; time: { grain: string } };
  const metrics = registry.metrics.filter((m) => a.measures.includes(m.cubeMember));
  const derived = [...new Set(metrics.flatMap((m) => m.sources.map((x) => x.split(":")[0]!)))];
  const sources = env.sources && env.sources.length ? env.sources : derived;
  const snap = env.sourceSnapshotId;
  const rows = env.rows.map((r) => r.map((v) => (typeof v === "boolean" ? String(v) : v)));
  const watermarks = Object.fromEntries(
    Object.entries(env.sourceWatermarks).map(([k, v]) => [k, isoOrNull(v)]),
  ) as Record<string, string | null>;
  const newest =
    Object.values(watermarks)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? null;
  const freshness: Panel["freshness"]["state"] =
    env.certification === "stale" ? "late" : env.partialCount || env.nullCount ? "partial" : "fresh";
  const state: PanelDataResponse["state"] =
    env.certification === "stale"
      ? "stale"
      : env.truncation
        ? "truncated"
        : env.certification === "partial" || env.partialCount || env.nullCount || env.gaps.length
          ? "partial"
          : "complete";
  return {
    kind: "semantic",
    queryHash: env.queryHash,
    state,
    chart: {
      panelId: ZERO_PANEL,
      queryHash: env.queryHash,
      dataRevision: 1,
      columns: env.columns.map((c) => ({ name: c.name, unit: c.unit })),
      rows,
      downsampling: { method: "none", originalPoints: rows.length },
      freshness,
      sourceWatermark: newest,
      ...(env.truncation ? { truncation: env.truncation } : {}),
    },
    shape: {
      queryHash: env.queryHash,
      grain: a.time.grain,
      fields: env.columns.map((c) => ({
        name: c.name,
        unit: c.unit,
        role:
          c.type === "time" ? "time" : c.type === "number" || c.type === "decimal" ? "measure" : "dimension",
        ...(c.type === "number" || c.type === "decimal" ? { metricId: c.name } : {}),
      })),
    },
    provenance: {
      queryHash: env.queryHash,
      semanticVersion: env.semanticVersion,
      semanticModelHash: env.semanticModelHash,
      sourceSnapshotId: snap,
      rawManifestHash: null,
      certification: env.certification,
      ast,
      sourceLabel: source === "live" ? "LIVE" : snap?.startsWith("fx.") ? "SYNTHETIC" : "LIVE",
      resultHash: hashCanonical({ columns: env.columns, rows: env.rows }),
      sources,
    },
    gaps: env.gaps,
    coverage: {
      rowCoverage: env.rowCoverage ?? [],
      partialCount: env.partialCount,
      nullCount: env.nullCount,
    },
    freshness: {
      state: freshness,
      sourceWatermark: newest,
      sourceWatermarks: watermarks,
      generatedAt: isoOrNull(env.generatedAt),
    },
    rollupFreshness: env.rollupFreshness ?? null,
    cost: env.cost,
    nullCount: env.nullCount,
    partialCount: env.partialCount,
    caveats: env.exploratory ? [env.exploratory.banner] : [],
    ...(env.metricStatus ? { metricStatus: env.metricStatus } : {}),
    ...(env.exploratory ? { exploratory: env.exploratory } : {}),
    cannotCompute: null,
  };
}

/** Analytics panel data -> the panel response. A `cannotCompute` result is HTTP 200 with no chart, never a chart of zeros. */
export function analyticsPanel(hash: string, a: AnalyticsPanelData): Panel {
  const cov = a.provenance.coverage;
  const gaps = [
    ...cov.missingDays.map((d) => ({ from: d, to: d, reason: "NO_COVERAGE" })),
    ...cov.incompleteDays.map((d) => ({ from: d, to: d, reason: "PARTIAL_DAY" })),
  ];
  const wm = isoOrNull(a.chart.sourceWatermark);
  const base = {
    kind: "analytics" as const,
    queryHash: hash,
    gaps,
    coverage: cov as unknown as Record<string, unknown>,
    rollupFreshness: null,
    cost: null,
    nullCount: null,
    partialCount: null,
    caveats: a.provenance.caveats,
  };
  const freshness = {
    state: a.chart.freshness,
    sourceWatermark: wm,
    sourceWatermarks: {} as Record<string, string | null>,
    generatedAt: isoOrNull(a.provenance.computedAt),
  };
  if (a.cannotCompute)
    return {
      ...base,
      state: "insufficient_data",
      chart: null,
      shape: null,
      provenance: null,
      freshness: { ...freshness, state: "unavailable" },
      cannotCompute: a.cannotCompute,
    } as Panel;
  return {
    ...base,
    state: a.truncated ? "truncated" : cov.state === "complete" ? "complete" : "partial",
    chart: {
      panelId: ZERO_PANEL,
      queryHash: a.chart.queryHash,
      dataRevision: a.chart.dataRevision,
      columns: a.chart.columns,
      rows: a.chart.rows,
      downsampling: a.chart.downsampling,
      freshness: a.chart.freshness,
      sourceWatermark: wm,
    },
    shape: a.shape,
    provenance: {
      queryHash: a.provenance.queryHash,
      semanticVersion: a.provenance.metricVersion,
      semanticModelHash: `analytics:${a.provenance.capability}:${a.provenance.analysis}`,
      sourceSnapshotId: null,
      rawManifestHash: null,
      certification: cov.state === "complete" ? "experimental" : "partial",
      ast: a.provenance.call,
      sourceLabel: "ANALYTICS",
      resultHash: a.provenance.resultHash,
      sources: a.provenance.sources,
    },
    freshness,
    cannotCompute: null,
  } as Panel;
}
