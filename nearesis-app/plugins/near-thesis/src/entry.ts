/**
 * near-thesis plugin entrypoint (loaded in-process by the kernel PluginManager). Handlers receive a kernel-built
 * InvocationContext; tenant/workspace/principal come from there, never from the input (S14, ch.20).
 */
import { Redis } from "ioredis";
import { type DataFrameEnvelope, type MetricMetadata, SemanticQuery } from "@nearesis/contracts";
import {
  compileVisualization,
  type FieldInfo,
  type QueryResultShape,
  type VizRequest,
} from "@nearesis/canvas-schema";
import {
  createCh,
  createPg,
  CUBE_URL_DEFAULT,
  defaultCubeSecret,
  LIVE_CUBE_URL_DEFAULT,
  LIVE_DATABASE,
  liveCatalog,
  loadLiveRegistry,
  loadRegistry,
  type Registry,
} from "@nearesis/analytics";
import { createGateway, DEFAULT_POLICY, type Session } from "@nearesis/semantic-gateway";
import { definePlugin, type InvocationContext } from "@nearesis/plugin-sdk";
import { MetricProposeInput, PreviewInput } from "./capabilities.ts";
import { AuthoredMetricStore } from "@nearesis/analytics";
import {
  MetricAuthoringError,
  buildSourceCatalogue,
  createAuthoringService,
  type AuthoringPrincipal,
  type SourceCatalogue,
} from "@nearesis/semantic-gateway";
import { annotateEnvelope } from "./lifecycle/degradation.ts";

type Gateway = ReturnType<typeof createGateway>;
/** Which semantic layer a run's agents query: fixture cubes (:4000) or the LIVE real-data layer (cube-live, :4001). */
export type SemanticSource = "fixture" | "live";
interface Wired {
  gateway: Gateway;
  registry: Registry;
  redis: Redis;
  ch: ReturnType<typeof createCh>;
}
const wired: Partial<Record<SemanticSource, Wired>> = {};
let sharedRedis: Redis | null = null;
let pgPool: ReturnType<typeof createPg> | null = null;
const pool = () => (pgPool ??= createPg());

/** Fact table -> its UTC day column, for the data windows the catalog advertises to composers. */
const DAY_COLUMN: Record<string, string> = {
  intents_swaps: "created_day",
  quote_attempts: "day",
  price_candles: "day",
  near_daily_usage: "block_date",
  near_signer_days: "block_date",
  contract_interactions: "block_date",
  economics_reports: "report_day",
  agent_market_jobs: "job_day",
};

/** Observed first/last day per dataset (null = no rows). Table and column names come from the fixed map above. */
export async function dataWindows(
  ch: ReturnType<typeof createCh>,
): Promise<Record<string, { from: string; to: string } | null>> {
  const out: Record<string, { from: string; to: string } | null> = {};
  for (const [table, col] of Object.entries(DAY_COLUMN)) {
    try {
      const rs = await ch.query({
        query: `SELECT toString(min(${col})) AS f, toString(max(${col})) AS t, count() AS n FROM ${table}`,
        format: "JSONEachRow",
      });
      const r = ((await rs.json()) as Array<{ f: string; t: string; n: string }>)[0];
      out[table] = r && Number(r.n) > 0 ? { from: r.f, to: r.t } : null;
    } catch {
      out[table] = null;
    }
  }
  return out;
}

/** Lazily wires one gateway per source from server-side configuration (env), so importing the module has no side effects. */
export function gateway(source: SemanticSource = "fixture"): Wired {
  const hit = wired[source];
  if (hit) return hit;
  const live = source === "live";
  const registry = live ? loadLiveRegistry() : loadRegistry();
  sharedRedis ??= new Redis(process.env.NEARESIS_REDIS_URL ?? "redis://127.0.0.1:56379", {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });
  const ch = live ? createCh({ database: LIVE_DATABASE }) : createCh();
  const w: Wired = {
    registry,
    redis: sharedRedis,
    ch,
    gateway: createGateway({
      cubeUrl: live
        ? (process.env.CUBE_LIVE_URL ?? LIVE_CUBE_URL_DEFAULT)
        : (process.env.CUBE_URL ?? CUBE_URL_DEFAULT),
      cubeSecret: defaultCubeSecret(),
      redis: sharedRedis as never,
      registry,
      policyResolver: () => ({ ...DEFAULT_POLICY }),
      clock: () => new Date(),
      // Every executed query is recorded content-addressed (hash -> AST) so panels can be re-executed (C14).
      pg: pool(),
      ch,
    }),
  };
  wired[source] = w;
  return w;
}

/**
 * Run -> source registry, held on `globalThis` so the worker's gateway decorator and this plugin module share it even
 * when the module is loaded through a different specifier. The worker registers a run's source (read from its own
 * `runs` row) before every gateway call made for that run; the plugin never reads a source from invocation input.
 */
const REGISTRY = Symbol.for("nearesis.near-thesis.run-source");
const registry = (): Map<string, SemanticSource> => {
  const g = globalThis as unknown as Record<symbol, Map<string, SemanticSource> | undefined>;
  return (g[REGISTRY] ??= new Map());
};
export function registerRunSource(runId: string, source: SemanticSource): void {
  const m = registry();
  if (m.size > 5000) m.clear();
  m.set(runId, source);
}
/**
 * The source the run was submitted with. Agent principals carry the run id as `parentRunId`; anything without a
 * registered run (health probes, humans, unknown runs) uses the fixture layer: real data is only served when the run
 * explicitly asked for it.
 */
export function sourceOf(ctx: InvocationContext): SemanticSource {
  const runId = ctx.principal.parentRunId;
  return (runId && registry().get(runId)) || "fixture";
}

/** Observed data windows of the LIVE datasets, keyed by table like `dataWindows` (null = no rows). */
export async function liveDataWindows(
  ch: ReturnType<typeof createCh>,
): Promise<Record<string, { from: string; to: string } | null>> {
  const out: Record<string, { from: string; to: string } | null> = {};
  try {
    for (const d of await liveCatalog(ch))
      out[d.table] =
        d.dataWindow.from && d.dataWindow.to ? { from: d.dataWindow.from, to: d.dataWindow.to } : null;
  } catch {
    /* an unreadable catalog advertises no windows */
  }
  return out;
}

export function sessionOf(ctx: InvocationContext): Session {
  return {
    tenantId: ctx.principal.orgId,
    workspaceId: ctx.workspaceId,
    principalId: ctx.principal.actorId,
    aclClasses: [ctx.principal.kind],
  };
}

/** Field roles/units for the canvas compiler, derived from the envelope's typed columns. */
export function shapeOf(env: DataFrameEnvelope, grain: QueryResultShape["grain"]): QueryResultShape {
  const fields: FieldInfo[] = env.columns.map((c) => ({
    name: c.name,
    unit: c.unit,
    role: c.type === "time" ? "time" : c.type === "number" || c.type === "decimal" ? "measure" : "dimension",
    // Quote views bucket by sample time (fetchedAt), never settlement time (C17); other views use event time.
    ...(c.type === "time"
      ? {
          timeSemantics:
            /fetched_at/.test(c.name) || c.name.startsWith("quotes.")
              ? ("fetched_at" as const)
              : ("event_time" as const),
        }
      : {}),
    ...(c.type === "number" || c.type === "decimal" ? { metricId: c.name } : {}),
  }));
  return { queryHash: env.queryHash, grain, fields };
}

export function completenessOf(env: DataFrameEnvelope): "complete" | "partial" | "unavailable" {
  if (!env.rows.length) return env.gaps.length ? "unavailable" : "complete";
  return env.partialCount || env.nullCount || env.gaps.length || env.certification !== "certified"
    ? "partial"
    : "complete";
}

let authoring: { svc: ReturnType<typeof createAuthoringService> } | null = null;
let catalogueCache: { at: number; c: SourceCatalogue } | null = null;
/** Authoring service over the LIVE database: generated source catalogue (cached 5 min), read-only bounded execution. */
function authoringService() {
  if (authoring) return authoring;
  const ch = createCh({ database: LIVE_DATABASE });
  const svc = createAuthoringService({
    store: new AuthoredMetricStore(pool()),
    ch,
    registry: loadLiveRegistry(),
    catalogue: async () => {
      if (!catalogueCache || Date.now() - catalogueCache.at > 300_000)
        catalogueCache = { at: Date.now(), c: await buildSourceCatalogue(ch, { database: LIVE_DATABASE }) };
      return catalogueCache.c;
    },
  });
  return (authoring = { svc });
}

export default definePlugin({
  handlers: {
    /**
     * Governed metric authoring for agents. The proposal's author is overwritten from the kernel principal; there is no SQL
     * surface. The result is a validation report; the metric stays DRAFT/VALIDATED (exploratory) until a human certifies it.
     */
    "metric.propose@1": async (input, ctx) => {
      const parsed = MetricProposeInput.parse(input);
      const p: AuthoringPrincipal = {
        id: ctx.principal.actorId,
        kind: ctx.principal.kind,
        role: null,
        tenantId: ctx.principal.orgId,
        workspaceId: ctx.workspaceId,
      };
      const proposal = {
        ...parsed.proposal,
        author: { principalId: p.id, kind: p.kind, tenantId: p.tenantId },
      };
      const { svc } = authoringService();
      const out = (
        status: "REFUSED" | "DRAFT" | "VALIDATED",
        extra: {
          metricKey?: string;
          version?: number;
          issues?: Array<{ reason: string; path: string; message: string }>;
          report?: unknown;
        },
      ) => ({
        ok: true as const,
        mode: parsed.mode,
        status,
        metricKey: extra.metricKey ?? null,
        version: extra.version ?? null,
        issues: extra.issues ?? [],
        report: extra.report ?? null,
        exploratory: true as const,
      });
      if (parsed.mode === "check") {
        const r = await svc.check(p, proposal);
        return out(r.ok ? "DRAFT" : "REFUSED", { issues: r.issues });
      }
      try {
        const r = await svc.propose(p, proposal);
        return out(r.record.status === "VALIDATED" ? "VALIDATED" : "DRAFT", {
          metricKey: r.record.metricKey,
          version: r.record.version,
          issues: r.report?.issues ?? [],
          report: r.report,
        });
      } catch (e) {
        if (e instanceof MetricAuthoringError)
          return out("REFUSED", {
            issues: e.issues.length ? e.issues : [{ reason: e.reason, path: "", message: e.message }],
          });
        throw e;
      }
    },
    "semantic.discover@1": async (_input, ctx) => {
      const source = sourceOf(ctx);
      const g = gateway(source);
      const r = await g.gateway.discover(sessionOf(ctx));
      return {
        ok: true,
        ...r,
        source,
        dataWindows: source === "live" ? await liveDataWindows(g.ch) : await dataWindows(g.ch),
      };
    },
    "semantic.query@1": async (input, ctx) => {
      const w = gateway(sourceOf(ctx));
      const r = await w.gateway.query(sessionOf(ctx), input);
      if (!r.ok) return { ok: false, status: r.status, error: r.error };
      // a degraded source (credential loss, outage) makes the window stale and visible instead of silently complete
      const measures = ((input as { measures?: string[] }).measures ?? []) as string[];
      const sources = (w.registry.metrics as unknown as MetricMetadata[])
        .filter((m) => measures.includes(m.id))
        .flatMap((m) => m.sources ?? []);
      return {
        ok: true,
        queryHash: r.queryHash,
        cache: r.cache,
        envelope: annotateEnvelope(r.envelope, sources),
      };
    },
    /**
     * Pure preview for the composer: run each request's semantic query (read-only, cached path), compile the chart
     * with the certified catalog, and return one CanvasPatch (or per-request issues). Nothing is persisted (C11a).
     */
    "canvas.preview@1": async (input, ctx) => {
      const parsed = PreviewInput.parse(input);
      const { gateway: g, registry } = gateway(sourceOf(ctx));
      const metrics = registry.metrics as unknown as MetricMetadata[];
      const issues: Array<{ index: number; code: string; path: string; message: string }> = [];
      const ops = [];
      for (const [index, raw] of parsed.requests.entries()) {
        const ast = SemanticQuery.safeParse(raw.query);
        if (!ast.success) {
          issues.push({
            index,
            code: "SCHEMA_INVALID",
            path: "query",
            message: ast.error.issues[0]?.message ?? "invalid",
          });
          continue;
        }
        const q = await g.query(sessionOf(ctx), ast.data);
        if (!q.ok) {
          issues.push({
            index,
            code: q.error.reasonCode ?? q.error.errorCode,
            path: "query",
            message: q.error.message,
          });
          continue;
        }
        const req = {
          ...(raw as Omit<VizRequest, "query" | "result" | "completeness">),
          query: {
            hash: q.queryHash,
            semanticVersion: q.envelope.semanticVersion,
            grain: ast.data.time.grain,
          },
          result: shapeOf(q.envelope, ast.data.time.grain),
          completeness: completenessOf(q.envelope),
        } as VizRequest;
        const c = compileVisualization(req, metrics);
        if (!c.ok)
          for (const i of c.issues) issues.push({ index, code: i.code, path: i.path, message: i.message });
        else ops.push({ op: "addPanel" as const, panel: c.value.panel });
      }
      const ok = issues.length === 0;
      return {
        ok,
        patch: ok
          ? {
              schemaVersion: 1,
              type: "workspace.patch",
              operationId: crypto.randomUUID(),
              expectedRevision: parsed.expectedRevision,
              operations: ops,
            }
          : null,
        issues,
      };
    },
  },
  health: async () => {
    await gateway().gateway.discover({
      tenantId: "00000000-0000-4000-8000-000000000000",
      workspaceId: "00000000-0000-4000-8000-000000000000",
      principalId: "health",
      aclClasses: ["service"],
    });
  },
});
