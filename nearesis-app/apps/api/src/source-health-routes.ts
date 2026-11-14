import { createClient } from "@clickhouse/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { KernelError } from "@nearesis/kernel";
import { Uuid, assertWorkspace, ctxOf, parseQuery } from "./product-common.ts";
import type { ProductDeps } from "./product-common.ts";

export interface HeatCell {
  day: string;
  /** null for day-granularity sources. */
  hour: number | null;
  expected: number | null;
  observed: number;
  coverage: number | null;
  state: "ok" | "partial" | "gap" | "info";
}
export interface SourceWatermark {
  sourceId: string;
  state: string;
  newestEventTime: string | null;
  lastFullScanAt: string | null;
  gapCount: number;
  lagSeconds: number | null;
}
export interface ErrorEvent {
  at: string;
  kind: "http_error" | "quality_gap" | "anomaly";
  code: string;
  httpStatus: number | null;
  reason: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
}
export interface HourlyRateSignal {
  at: string;
  attempts: number;
  rateLimited: number;
}
/** Read model over the ingestion state tables (ClickHouse nearesis_live). Injectable so tests and other backends can supply it. */
export interface SourceHealthPort {
  watermarks(): Promise<SourceWatermark[]>;
  heatmap(
    sourceId: string,
    days: number,
    nowMs: number,
  ): Promise<{ granularity: "hour" | "day"; basis: string; cells: HeatCell[]; note: string | null }>;
  errors(
    sourceId: string,
    days: number,
    nowMs: number,
  ): Promise<{ events: ErrorEvent[]; notAttempted: Array<{ reason: string; count: number }> }>;
  rateLimits(
    sourceId: string,
    days: number,
    nowMs: number,
  ): Promise<{ recorded: boolean; basis: string; hourly: HourlyRateSignal[]; note: string | null }>;
}

const SQL_TS = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "");
const HOUR_FMT = "%Y-%m-%dT%H:00:00.000Z";
const isoMs = (v: unknown): string =>
  new Date(`${String(v).replace(" ", "T")}${String(v).endsWith("Z") ? "" : "Z"}`).toISOString();

export function clickhouseSourceHealth(): SourceHealthPort & { close(): Promise<void> } {
  let client: ReturnType<typeof createClient> | undefined;
  const ch = () =>
    (client ??= createClient({
      url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
      username: process.env.NEARESIS_CH_USER ?? "nearesis",
      password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
      database: "nearesis_live",
    }));
  const rows = async <T>(query: string, p: Record<string, unknown> = {}): Promise<T[]> =>
    (await (await ch().query({ query, query_params: p, format: "JSONEachRow" })).json()) as T[];

  /** Fill every hour between the first and last observed hour so missing hours are visible as gaps, never skipped. */
  const grid = (
    start: number,
    end: number,
    byKey: Map<string, { expected: number | null; observed: number }>,
    expectedDefault: number | null,
  ): HeatCell[] => {
    const out: HeatCell[] = [];
    for (let t = Math.floor(start / 3.6e6) * 3.6e6; t <= end; t += 3.6e6) {
      const d = new Date(t);
      const day = d.toISOString().slice(0, 10);
      const hour = d.getUTCHours();
      const hit = byKey.get(`${day}:${hour}`);
      const expected = hit ? hit.expected : expectedDefault;
      const observed = hit?.observed ?? 0;
      const coverage = expected && expected > 0 ? Math.min(1, observed / expected) : null;
      out.push({
        day,
        hour,
        expected,
        observed,
        coverage,
        state:
          coverage === null
            ? observed > 0
              ? "info"
              : "gap"
            : coverage >= 1
              ? "ok"
              : coverage > 0
                ? "partial"
                : "gap",
      });
    }
    return out;
  };

  return {
    async close() {
      await client?.close();
    },
    async watermarks() {
      const r = await rows<Record<string, string | number | null>>(
        `SELECT provider_id, state, toString(newest_event_time) AS ne, toString(last_full_scan_at) AS fs, gap_count, provider_lag_seconds FROM source_watermarks FINAL ORDER BY provider_id`,
      );
      const nz = (v: unknown) =>
        v === null || v === undefined || v === "\\N" || v === "" ? null : String(v);
      return r.map((x) => ({
        sourceId: String(x.provider_id),
        state: String(x.state),
        newestEventTime: nz(x.ne) ? isoMs(x.ne) : null,
        lastFullScanAt: nz(x.fs) ? isoMs(x.fs) : null,
        gapCount: Number(x.gap_count),
        lagSeconds: x.provider_lag_seconds === null ? null : Number(x.provider_lag_seconds),
      }));
    },
    async heatmap(sourceId, days, nowMs) {
      const from = nowMs - days * 86_400_000;
      if (sourceId === "near-realtime") {
        const r = await rows<{ d: string; h: number; obs: string }>(
          `SELECT toString(toDate(minute)) AS d, toHour(minute) AS h, toString(countIf(complete = 1 AND state = 'final')) AS obs
             FROM rt_minutes FINAL WHERE minute >= toDateTime({f:String}, 'UTC') AND minute <= toDateTime({t:String}, 'UTC') GROUP BY d, h ORDER BY d, h`,
          { f: SQL_TS(from).slice(0, 19), t: SQL_TS(nowMs).slice(0, 19) },
        );
        if (!r.length)
          return {
            granularity: "hour",
            basis: "rt_minutes (complete final minutes per hour of 60)",
            cells: [],
            note: "The real-time feed has recorded no minutes in this window.",
          };
        const m = new Map(r.map((x) => [`${x.d}:${x.h}`, { expected: 60, observed: Number(x.obs) }]));
        const first = Date.parse(`${r[0]!.d}T${String(r[0]!.h).padStart(2, "0")}:00:00Z`);
        return {
          granularity: "hour",
          basis: "rt_minutes (complete final minutes per hour of 60)",
          cells: grid(first, nowMs, m, 60),
          note: "The current hour is still accumulating, so its coverage is a lower bound. Hours before the feed started are not shown.",
        };
      }
      if (sourceId === "intents-1click") {
        const r = await rows<{ d: string; h: number; total: string; ok: string }>(
          `SELECT toString(toDate(scheduled_bucket_utc)) AS d, toHour(scheduled_bucket_utc) AS h, toString(count()) AS total, toString(countIf(class = 'OK')) AS ok
             FROM quote_attempts FINAL WHERE scheduled_bucket_utc >= toDateTime64({f:String}, 3, 'UTC') AND scheduled_bucket_utc <= toDateTime64({t:String}, 3, 'UTC') GROUP BY d, h ORDER BY d, h`,
          { f: SQL_TS(from), t: SQL_TS(nowMs) },
        );
        const m = new Map(
          r.map((x) => [`${x.d}:${x.h}`, { expected: Number(x.total), observed: Number(x.ok) }]),
        );
        const cells = r.length
          ? grid(
              Date.parse(`${r[0]!.d}T${String(r[0]!.h).padStart(2, "0")}:00:00Z`),
              Date.parse(`${r.at(-1)!.d}T${String(r.at(-1)!.h).padStart(2, "0")}:00:00Z`),
              m,
              null,
            )
          : [];
        return {
          granularity: "hour",
          basis: "quote_attempts (observed OK attempts of scheduled attempts per hour)",
          cells,
          note: "Attempts that were scheduled but never made count as not observed.",
        };
      }
      if (sourceId === "near-explorer") {
        const r = await rows<{ d: string; h: number; n: string }>(
          `SELECT toString(toDate(created_at)) AS d, toHour(created_at) AS h, toString(count()) AS n
             FROM intents_swaps FINAL WHERE created_at >= toDateTime64({f:String}, 3, 'UTC') AND created_at <= toDateTime64({t:String}, 3, 'UTC') GROUP BY d, h ORDER BY d, h`,
          { f: SQL_TS(from), t: SQL_TS(nowMs) },
        );
        const gaps = await rows<{ f: string; t: string }>(
          `SELECT toString(from_utc) AS f, toString(to_utc) AS t FROM quality_gaps FINAL WHERE provider_id = 'near-explorer' AND to_utc >= toDateTime64({f:String}, 3, 'UTC')`,
          { f: SQL_TS(from) },
        );
        const gapHours = new Set<string>();
        for (const g of gaps)
          for (
            let t = Math.floor(Date.parse(isoMs(g.f)) / 3.6e6) * 3.6e6;
            t <= Date.parse(isoMs(g.t));
            t += 3.6e6
          )
            gapHours.add(new Date(t).toISOString().slice(0, 13));
        const cells = r.map((x): HeatCell => {
          const key = `${x.d}T${String(x.h).padStart(2, "0")}`;
          return {
            day: x.d,
            hour: x.h,
            expected: null,
            observed: Number(x.n),
            coverage: null,
            state: gapHours.has(key) ? "partial" : "info",
          };
        });
        return {
          granularity: "hour",
          basis:
            "intents_swaps (swaps per created_at hour; partial = a recorded quality gap overlaps the hour)",
          cells,
          note: "Swap counts have no per-hour expectation, so coverage is not a ratio here. Hours with no swaps are not listed.",
        };
      }
      const r = await rows<{ d: string; total: string; ok: string }>(
        `SELECT toString(day) AS d, toString(count()) AS total, toString(countIf(state = 'complete')) AS ok
           FROM source_coverage FINAL WHERE provider_id = {p:String} AND day >= toDate({f:String}) GROUP BY d ORDER BY d`,
        { p: sourceId, f: SQL_TS(from).slice(0, 10) },
      );
      return {
        granularity: "day",
        basis: "source_coverage (complete datasets of recorded datasets per day)",
        cells: r.map((x): HeatCell => {
          const cov = Number(x.total) ? Number(x.ok) / Number(x.total) : null;
          return {
            day: x.d,
            hour: null,
            expected: Number(x.total),
            observed: Number(x.ok),
            coverage: cov,
            state: cov === 1 ? "ok" : cov && cov > 0 ? "partial" : "gap",
          };
        }),
        note: "This source is loaded as daily batches; there is no hourly ingestion timeline to show.",
      };
    },
    async errors(sourceId, days, nowMs) {
      const from = SQL_TS(nowMs - days * 86_400_000);
      const events: ErrorEvent[] = [];
      let notAttempted: Array<{ reason: string; count: number }> = [];
      if (sourceId === "intents-1click") {
        const r = await rows<{
          at: string;
          cls: string;
          hs: number | null;
          reason: string | null;
          n: string;
          first: string;
          last: string;
        }>(
          `SELECT formatDateTime(toStartOfHour(scheduled_bucket_utc), '${HOUR_FMT}', 'UTC') AS at, class AS cls, http_status AS hs, reason, toString(count()) AS n,
                  toString(min(coalesce(fetched_at, scheduled_bucket_utc))) AS first, toString(max(coalesce(fetched_at, scheduled_bucket_utc))) AS last
             FROM quote_attempts FINAL WHERE class IS NOT NULL AND class != 'OK' AND scheduled_bucket_utc >= toDateTime64({f:String}, 3, 'UTC') AND scheduled_bucket_utc <= toDateTime64({t:String}, 3, 'UTC')
             GROUP BY at, cls, hs, reason ORDER BY at`,
          { f: from, t: SQL_TS(nowMs) },
        );
        for (const x of r)
          events.push({
            at: x.at,
            kind: "http_error",
            code: x.cls,
            httpStatus: x.hs === null ? null : Number(x.hs),
            reason: x.reason,
            count: Number(x.n),
            firstSeen: isoMs(x.first),
            lastSeen: isoMs(x.last),
          });
        const na = await rows<{ reason: string | null; n: string }>(
          `SELECT reason, toString(count()) AS n FROM quote_attempts FINAL WHERE class IS NULL AND scheduled_bucket_utc >= toDateTime64({f:String}, 3, 'UTC') GROUP BY reason ORDER BY count() DESC`,
          { f: from },
        );
        notAttempted = na.map((x) => ({ reason: x.reason ?? "unspecified", count: Number(x.n) }));
      }
      const gaps = await rows<{ f: string; state: string; code: string }>(
        `SELECT toString(from_utc) AS f, state, reason_code AS code FROM quality_gaps FINAL WHERE provider_id = {p:String} AND to_utc >= toDateTime64({f:String}, 3, 'UTC') ORDER BY from_utc`,
        { p: sourceId, f: from },
      );
      for (const g of gaps)
        events.push({
          at: isoMs(g.f),
          kind: "quality_gap",
          code: g.code.split(":")[0]!,
          httpStatus: null,
          reason: `${g.state}: ${g.code}`,
          count: 1,
          firstSeen: isoMs(g.f),
          lastSeen: isoMs(g.f),
        });
      if (sourceId === "near-realtime") {
        const an = await rows<{ at: string; kind: string; detail: string }>(
          `SELECT toString(at) AS at, kind, detail FROM rt_anomalies WHERE at >= toDateTime64({f:String}, 3, 'UTC') ORDER BY at`,
          { f: from },
        );
        for (const a of an)
          events.push({
            at: isoMs(a.at),
            kind: "anomaly",
            code: a.kind,
            httpStatus: null,
            reason: a.detail.slice(0, 300),
            count: 1,
            firstSeen: isoMs(a.at),
            lastSeen: isoMs(a.at),
          });
      }
      return { events: events.sort((a, b) => a.at.localeCompare(b.at)), notAttempted };
    },
    async rateLimits(sourceId, days, nowMs) {
      if (sourceId !== "intents-1click")
        return {
          recorded: false,
          basis: "none",
          hourly: [],
          note: "Ingestion does not record rate-limit responses for this source, so none can be reported (absence of rows is not evidence of no limiting).",
        };
      const r = await rows<{ at: string; attempts: string; rl: string }>(
        `SELECT formatDateTime(toStartOfHour(scheduled_bucket_utc), '${HOUR_FMT}', 'UTC') AS at, toString(countIf(class IS NOT NULL)) AS attempts,
                toString(countIf(http_status = 429 OR positionCaseInsensitive(coalesce(reason, ''), 'rate') > 0)) AS rl
           FROM quote_attempts FINAL WHERE scheduled_bucket_utc >= toDateTime64({f:String}, 3, 'UTC') AND scheduled_bucket_utc <= toDateTime64({t:String}, 3, 'UTC') GROUP BY at ORDER BY at`,
        { f: SQL_TS(nowMs - days * 86_400_000), t: SQL_TS(nowMs) },
      );
      return {
        recorded: true,
        basis: "quote_attempts (HTTP 429 or a rate-limit reason per attempt)",
        hourly: r.map((x) => ({ at: x.at, attempts: Number(x.attempts), rateLimited: Number(x.rl) })),
        note: null,
      };
    },
  };
}

export const Q = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14),
  workspaceId: Uuid.optional(),
});

export interface SourceHealthOptions extends ProductDeps {
  port?: SourceHealthPort & { close?(): Promise<void> };
  now?: () => number;
}

/**
 * Source health depth (frontend audit s4 item 10). Read-only over ingestion state; nothing is estimated.
 *   GET /v1/sources/:sourceId/health               watermark + heatmap + errors + rate limits
 *   GET /v1/sources/:sourceId/health/heatmap       hourly (or daily) coverage cells and the weekday x hour aggregate
 *   GET /v1/sources/:sourceId/health/errors        error history grouped by code with first/last seen
 *   GET /v1/sources/:sourceId/health/rate-limits   recorded rate-limit history; `?workspaceId=` adds the BigQuery byte ceiling for the workspace
 * Maintainer actions (backfill, retry) are not routed.
 */
export const sourceHealthRoutes: FastifyPluginAsync<SourceHealthOptions> = async (
  app,
  { kernel, authenticate, port, now },
) => {
  const src = port ?? clickhouseSourceHealth();
  app.addHook("onClose", async () => {
    await src.close?.();
  });
  const clock = now ?? Date.now;
  type P = { Params: { sourceId: string }; Querystring: Record<string, string> };

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof KernelError) throw e;
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "SOURCE_STATE_UNAVAILABLE",
        "Ingestion state is unavailable.",
        { retryable: true },
      );
    }
  }
  async function known(sourceId: string) {
    const wm = await guarded(() => src.watermarks());
    const hit = wm.find((w) => w.sourceId === sourceId);
    if (!hit) throw new KernelError("NOT_FOUND", "SOURCE_NOT_FOUND", "No such source.");
    return hit;
  }
  const weekdayHour = (cells: HeatCell[]) => {
    const agg = new Map<string, { expected: number; observed: number; hours: number }>();
    for (const c of cells) {
      if (c.hour === null) continue;
      const k = `${new Date(`${c.day}T00:00:00Z`).getUTCDay()}:${c.hour}`;
      const a = agg.get(k) ?? { expected: 0, observed: 0, hours: 0 };
      a.expected += c.expected ?? 0;
      a.observed += c.observed;
      a.hours += 1;
      agg.set(k, a);
    }
    return [...agg.entries()].map(([k, a]) => {
      const [weekday, hour] = k.split(":").map(Number);
      return {
        weekday: weekday!,
        hour: hour!,
        observed: a.observed,
        expected: a.expected || null,
        coverage: a.expected ? a.observed / a.expected : null,
        hoursSampled: a.hours,
      };
    });
  };
  const errorSummary = (events: ErrorEvent[]) => {
    const by = new Map<
      string,
      {
        code: string;
        count: number;
        firstSeen: string;
        lastSeen: string;
        httpStatus: number | null;
        lastReason: string | null;
      }
    >();
    for (const e of events) {
      const cur = by.get(e.code);
      if (!cur)
        by.set(e.code, {
          code: e.code,
          count: e.count,
          firstSeen: e.firstSeen,
          lastSeen: e.lastSeen,
          httpStatus: e.httpStatus,
          lastReason: e.reason,
        });
      else {
        cur.count += e.count;
        if (e.firstSeen < cur.firstSeen) cur.firstSeen = e.firstSeen;
        if (e.lastSeen > cur.lastSeen) {
          cur.lastSeen = e.lastSeen;
          cur.lastReason = e.reason;
        }
      }
    }
    return [...by.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  };

  async function build(
    req: { params: { sourceId: string }; query: unknown },
    part: "all" | "heatmap" | "errors" | "rate-limits",
  ) {
    const q = parseQuery(Q, req.query);
    const id = req.params.sourceId;
    const wm = await known(id);
    const t = clock();
    const out: Record<string, unknown> = { sourceId: id, windowDays: q.days, watermark: wm };
    if (part === "all" || part === "heatmap") {
      const h = await guarded(() => src.heatmap(id, q.days, t));
      out.heatmap = { ...h, weekdayHour: weekdayHour(h.cells) };
    }
    if (part === "all" || part === "errors") {
      const e = await guarded(() => src.errors(id, q.days, t));
      out.errors = { ...e, byCode: errorSummary(e.events) };
    }
    if (part === "all" || part === "rate-limits")
      out.rateLimits = await guarded(() => src.rateLimits(id, q.days, t));
    return { q, out };
  }
  async function withByteCeiling(
    s: Awaited<ReturnType<typeof authenticate>>,
    q: z.infer<typeof Q>,
    id: string,
    out: Record<string, unknown>,
  ) {
    if (!q.workspaceId || id !== "near-bigquery" || !out.rateLimits) return out;
    const wsId = q.workspaceId;
    const bytes = await kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, wsId);
      let daily: Array<{ day: string; bytes: string }> = [];
      let policy:
        { dimension_limits: Record<string, number>; period_start: Date; period_days: number } | undefined;
      try {
        daily = (
          await tx.query<{ day: string; bytes: string }>(
            `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, sum(quantity)::text AS bytes
             FROM runtime.cost_ledger WHERE workspace_id = $1 AND dimension = 'bigquery_bytes_billed' AND state = 'settled' AND created_at >= now() - ($2 || ' days')::interval
             GROUP BY 1 ORDER BY 1`,
            [ws.id, String(q.days)],
          )
        ).rows;
        policy = (
          await tx.query<NonNullable<typeof policy>>(
            "SELECT dimension_limits, period_start, period_days FROM runtime.cost_policies WHERE workspace_id = $1",
            [ws.id],
          )
        ).rows[0];
      } catch {
        return null;
      }
      const limit = policy?.dimension_limits?.bigquery_bytes_billed;
      return {
        workspaceId: ws.id,
        dailyBytesBilled: daily.map((d) => ({ day: d.day, bytes: Number(d.bytes) })),
        limitBytesInPeriod: typeof limit === "number" ? limit : null,
        periodStart: policy ? policy.period_start.toISOString() : null,
        periodDays: policy?.period_days ?? null,
      };
    });
    return {
      ...out,
      rateLimits: {
        ...(out.rateLimits as object),
        byteCeiling: bytes ?? { state: "unavailable", reason: "Cost ledger is not available." },
      },
    };
  }

  app.get<P>("/v1/sources/:sourceId/health", async (req) => {
    const s = await authenticate(req);
    const { q, out } = await build(req, "all");
    return withByteCeiling(s, q, req.params.sourceId, out);
  });
  app.get<P>("/v1/sources/:sourceId/health/heatmap", async (req) => {
    await authenticate(req);
    return (await build(req, "heatmap")).out;
  });
  app.get<P>("/v1/sources/:sourceId/health/errors", async (req) => {
    await authenticate(req);
    return (await build(req, "errors")).out;
  });
  app.get<P>("/v1/sources/:sourceId/health/rate-limits", async (req) => {
    const s = await authenticate(req);
    const { q, out } = await build(req, "rate-limits");
    return withByteCeiling(s, q, req.params.sourceId, out);
  });
};
