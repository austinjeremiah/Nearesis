import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { KernelError, zodDetails } from "@nearesis/kernel";
import type { Session } from "@nearesis/kernel";
import { IntentsAnalytics, createCh } from "@nearesis/analytics";

export interface IntentsRoutesOptions {
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Test seam. Default: a lazily created instance over the live ClickHouse database (NEARESIS_CH_LIVE_DATABASE or nearesis_live). */
  analytics?: IntentsAnalytics;
}

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Win = z.object({
  from: Day.optional(),
  to: Day.optional(),
  days: z.coerce.number().int().min(1).max(366).optional(),
});
const Era = z.enum(["public", "private_settlement"]).optional();
const TopN = z.coerce.number().int().min(1).max(200).optional();

/**
 * NEAR Intents intelligence API (final_master_prompt section 8). Read-only, versioned, authenticated. Every response is a typed result:
 *   { status: "OK", metric, definition, window, chart: {kind, x|y|series|category|value}, data, coverage, provenance, caveats }
 *   { status: "CANNOT_COMPUTE", metric, missing: string[], explanation, evidence, alternative?, coverage, provenance }
 * CANNOT_COMPUTE is a successful HTTP 200 answer: the source does not carry the field (solver identity, settlement time).
 * Dates are UTC days, inclusive on both ends; omitted `from`/`to` default to the 30 days ending at the newest complete day.
 * Money values are exact decimal strings. USD that the provider did not supply is never zero: it is counted in `swapsWithUnknownUsd`.
 *
 *   GET /v1/intents/field-inventory                what the Explorer does and does not identify
 *   GET /v1/intents/coverage                       ?from&to&era
 *   GET /v1/intents/summary                        ?from&to&era
 *   GET /v1/intents/status                         ?from&to&by=none|day
 *   GET /v1/intents/assets                         ?side=origin|destination&top
 *   GET /v1/intents/chain-flows                    origin->destination matrix and net flow per chain
 *   GET /v1/intents/asset-pairs                    ?top
 *   GET /v1/intents/refund-rates                   ?by=chain_pair|asset_pair&minTerminal&top
 *   GET /v1/intents/refund-causes                  ?by=reason|week|day|chain_pair
 *   GET /v1/intents/routes                         ?top
 *   GET /v1/intents/referrals                      ?top
 *   GET /v1/intents/size-buckets
 *   GET /v1/intents/trend                          ?granularity=day|week|month
 *   GET /v1/intents/chain-pair-growth              window vs the preceding window of equal length
 *   GET /v1/intents/concentration                  ?dimension=origin_asset|destination_asset|origin_chain|destination_chain|chain_pair&measure=volume|count&top
 *   GET /v1/intents/unusual-flows                  ?asOf&baselineDays&recentDays
 *   GET /v1/intents/settlement-duration            measured p50/p95 by origin chain on pilot-covered days; CANNOT_COMPUTE elsewhere (+ indicative alternative)
 *   GET /v1/intents/solver-metrics                 CANNOT_COMPUTE (no solver identity, no quote linkage)
 *   GET /v1/intents/quotes                         dry-quote intelligence per route (indicative, never executed outcomes)
 */
export const intentsRoutes: FastifyPluginAsync<IntentsRoutesOptions> = async (app, opts) => {
  const { authenticate } = opts;
  let owned: ReturnType<typeof createCh> | null = null;
  let made: IntentsAnalytics | null = opts.analytics ?? null;
  const live = (): IntentsAnalytics => {
    if (!made) {
      owned = createCh({ database: process.env.NEARESIS_CH_LIVE_DATABASE ?? "nearesis_live" });
      made = new IntentsAnalytics(owned, {
        database: process.env.NEARESIS_CH_LIVE_DATABASE ?? "nearesis_live",
      });
    }
    return made;
  };
  app.addHook("onClose", async () => {
    await owned?.close();
  });
  const a = new Proxy({} as IntentsAnalytics, {
    get: (_t, prop: string) => {
      const inst = live();
      const v = (inst as unknown as Record<string, unknown>)[prop];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(inst) : v;
    },
  });

  const parse = <T extends z.ZodType>(schema: T, input: unknown): z.infer<T> => {
    const r = schema.safeParse(input);
    if (!r.success)
      throw new KernelError("VALIDATION_FAILED", "INVALID_QUERY", "Invalid query parameters.", {
        details: zodDetails(r.error),
      });
    return r.data;
  };
  const windowOf = async (q: z.infer<typeof Win>): Promise<{ from: string; to: string }> => {
    if (q.from && q.to) return { from: q.from, to: q.to };
    const d = await a.defaultWindow(q.days ?? 30);
    if (!d)
      throw new KernelError(
        "NOT_FOUND",
        "NO_COMPLETE_DAYS",
        "No complete day exists in source coverage yet; pass an explicit from and to.",
      );
    return { from: q.from ?? d.from, to: q.to ?? d.to };
  };
  const bad = (e: unknown): never => {
    if (e instanceof Error && /window/.test(e.message))
      throw new KernelError("VALIDATION_FAILED", "INVALID_WINDOW", e.message);
    throw e;
  };
  const get = <S extends z.ZodType>(
    path: string,
    schema: S,
    run: (q: z.infer<S>, w: { from: string; to: string }) => Promise<unknown>,
    needsWindow = true,
  ): void => {
    app.get(`/v1/intents/${path}`, async (req) => {
      await authenticate(req);
      const q = parse(schema, req.query);
      const w = needsWindow ? await windowOf(q as z.infer<typeof Win>) : { from: "", to: "" };
      try {
        return await run(q, w);
      } catch (e) {
        return bad(e);
      }
    });
  };

  app.get("/v1/intents/field-inventory", async (req) => {
    await authenticate(req);
    return a.fieldInventory();
  });
  get("coverage", Win.extend({ era: Era }), (q, w) => a.coverage(w, q.era));
  get("summary", Win.extend({ era: Era }), (q, w) => a.summary(w, q.era));
  get("status", Win.extend({ by: z.enum(["none", "day"]).optional() }), (q, w) =>
    a.statusDistribution(w, q.by ?? "none"),
  );
  get(
    "assets",
    Win.extend({ side: z.enum(["origin", "destination"]).default("origin"), top: TopN }),
    (q, w) => a.assetVolume(w, q.side, q.top ?? 25),
  );
  get("chain-flows", Win, (_q, w) => a.chainFlows(w));
  get("asset-pairs", Win.extend({ top: TopN }), (q, w) => a.assetPairs(w, q.top ?? 25));
  get(
    "refund-rates",
    Win.extend({
      by: z.enum(["chain_pair", "asset_pair"]).default("chain_pair"),
      minTerminal: z.coerce.number().int().min(1).max(1_000_000).optional(),
      top: TopN,
    }),
    (q, w) => a.refundRates(w, q.by, q.minTerminal ?? 100, q.top ?? 25),
  );
  get(
    "refund-causes",
    Win.extend({ by: z.enum(["reason", "week", "day", "chain_pair"]).default("reason") }),
    (q, w) => a.refundCauses(w, q.by),
  );
  get("routes", Win.extend({ top: TopN }), (q, w) => a.routeUsage(w, q.top ?? 25));
  get("referrals", Win.extend({ top: TopN }), (q, w) => a.referralUsage(w, q.top ?? 20));
  get("size-buckets", Win, (_q, w) => a.sizeBuckets(w));
  get("trend", Win.extend({ granularity: z.enum(["day", "week", "month"]).default("day") }), (q, w) =>
    a.trend(w, q.granularity),
  );
  get(
    "chain-pair-growth",
    Win.extend({ minPrevious: z.coerce.number().int().min(0).max(1_000_000).optional(), top: TopN }),
    (q, w) => a.chainPairGrowth(w, q.minPrevious ?? 50, q.top ?? 25),
  );
  get(
    "concentration",
    Win.extend({
      dimension: z
        .enum(["origin_asset", "destination_asset", "origin_chain", "destination_chain", "chain_pair"])
        .default("origin_asset"),
      measure: z.enum(["volume", "count"]).default("volume"),
      top: TopN,
    }),
    (q, w) => a.concentrationOf(w, q.dimension, q.measure, q.top ?? 10),
  );
  get(
    "unusual-flows",
    z.object({
      asOf: Day.optional(),
      baselineDays: z.coerce.number().int().min(14).max(120).optional(),
      recentDays: z.coerce.number().int().min(1).max(30).optional(),
    }),
    async (q) => {
      const asOf = q.asOf ?? (await a.defaultWindow(1))?.to;
      if (!asOf)
        throw new KernelError(
          "NOT_FOUND",
          "NO_COMPLETE_DAYS",
          "No complete day exists in source coverage yet; pass asOf.",
        );
      return a.unusualFlows(asOf, { baselineDays: q.baselineDays ?? 28, recentDays: q.recentDays ?? 7 });
    },
    false,
  );
  get("settlement-duration", Win, (_q, w) => a.settlementDurationMeasured(w));
  get("solver-metrics", Win, (_q, w) => a.solverMetrics(w));
  get("quotes", Win, (_q, w) => a.quoteIntelligence(w));
};

(intentsRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;
