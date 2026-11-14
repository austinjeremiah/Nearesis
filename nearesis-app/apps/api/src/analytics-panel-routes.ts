import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { KernelError } from "@nearesis/kernel";
import type { Session } from "@nearesis/kernel";
import {
  ClickHouseAccountSource,
  ClickHouseEntitySource,
  IntentsAnalytics,
  createCh,
  createPg,
  panelDataForHash,
  type AnalyticsDeps,
} from "@nearesis/analytics";

export interface AnalyticsPanelRoutesOptions {
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Test seams. Defaults: the live ClickHouse database (nearesis_live) and the analytics Postgres, created lazily. */
  deps?: AnalyticsDeps;
  pool?: ReturnType<typeof createPg>;
}

/**
 * Data of a panel whose `queryRef.resultKind` is `analytics_result` (contracts v1.8.0):
 *   GET /v1/analytics/panel/:hash -> AnalyticsPanelData { chart, shape, provenance (sourceLabel "ANALYTICS", certification
 *   SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC, call, coverage, caveats), cannotCompute, truncated }
 * The hash names an analytics-capability call stored by the capability (content addressed); the route re-executes it.
 * Errors: 404 QUERY_UNKNOWN (not an analytics call: use the semantic panel route), 422 STORED_CALL_INVALID, 503 ANALYTICS_SOURCE_UNAVAILABLE.
 * A call the source can no longer answer is HTTP 200 with `cannotCompute` set, never a chart of zeros.
 */
export const analyticsPanelRoutes: FastifyPluginAsync<AnalyticsPanelRoutesOptions> = async (app, opts) => {
  let ch: ReturnType<typeof createCh> | null = null;
  let pool: ReturnType<typeof createPg> | null = null;
  const deps = (): AnalyticsDeps => {
    if (opts.deps) return opts.deps;
    ch ??= createCh({ database: process.env.NEARESIS_CH_LIVE_DATABASE ?? "nearesis_live" });
    return {
      intents: new IntentsAnalytics(ch, {
        database: process.env.NEARESIS_CH_LIVE_DATABASE ?? "nearesis_live",
      }),
      entities: new ClickHouseEntitySource(ch),
      accounts: new ClickHouseAccountSource(ch),
    };
  };
  app.addHook("onClose", async () => {
    await ch?.close();
    if (!opts.pool) await pool?.end();
  });
  app.get<{ Params: { hash: string } }>("/v1/analytics/panel/:hash", async (req, reply) => {
    await opts.authenticate(req);
    pool ??= opts.pool ?? createPg();
    const r = await panelDataForHash(pool, deps(), req.params.hash);
    if (r.status === 200) return r.body;
    if (r.status === 404) throw new KernelError("NOT_FOUND", r.body.reasonCode, r.body.message);
    if (r.status === 422) throw new KernelError("VALIDATION_FAILED", r.body.reasonCode, r.body.message);
    void reply;
    throw new KernelError("UPSTREAM_DEGRADED", r.body.reasonCode, r.body.message, { retryable: true });
  });
};

(analyticsPanelRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
