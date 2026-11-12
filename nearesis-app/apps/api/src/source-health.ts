import type { SourceHealth } from "@nearesis/contracts";
import { createCh } from "@nearesis/analytics";

/** Reads ingestion's recorded source state. Production: the live ClickHouse database; tests inject a fake. */
export interface SourceHealthPort {
  read(): Promise<SourceHealth[]>;
  close(): Promise<void>;
}

/** Coverage is measured over the last 90 days ending at the newest covered day of the provider. */
export const COVERAGE_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;
const iso = (v: string | null): string | null => {
  if (!v) return null;
  const t = Date.parse(v.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? "" : "Z"));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface WatermarkRow {
  provider_id: string;
  newest_event_time: string | null;
  gap_count: number | null;
  provider_lag_seconds: number | null;
  schema_version: string | null;
  state: string;
}
interface CoverageRow {
  provider_id: string;
  dataset: string;
  state: string;
  days: string | number;
  newest: string;
}
/** Recorded rate-limit history of a source over the recent window (only sources whose adapter records it appear). */
export interface RateLimitRow {
  provider_id: string;
  attempts: string | number;
  limited: string | number;
  last_attempt: string | null;
}
export const RATE_LIMIT_WINDOW_DAYS = 7;
interface GapRow {
  provider_id: string;
  dataset: string;
  state: string;
  reason_code: string;
  from_utc: string;
  to_utc: string;
}

/** Pure assembly of the per-source health list from the three recorded tables. */
export function assembleSourceHealth(
  watermarks: WatermarkRow[],
  coverage: CoverageRow[],
  gaps: GapRow[],
  windowDays = COVERAGE_WINDOW_DAYS,
  rateLimits: RateLimitRow[] = [],
): SourceHealth[] {
  const ids = [
    ...new Set([...watermarks.map((w) => w.provider_id), ...coverage.map((c) => c.provider_id)]),
  ].sort();
  return ids.map((id) => {
    const rl = rateLimits.find((x) => x.provider_id === id && Number(x.attempts) > 0);
    const w = watermarks.find((x) => x.provider_id === id);
    const cov = coverage.filter((c) => c.provider_id === id);
    const newest =
      cov
        .map((c) => c.newest)
        .sort()
        .at(-1) ?? null;
    const window = newest
      ? { from: day(Date.parse(newest) - (windowDays - 1) * DAY_MS), to: newest, days: windowDays }
      : null;
    const datasets = [...new Set(cov.map((c) => c.dataset))].sort().map((dataset) => {
      const n = (s: string) =>
        cov.filter((c) => c.dataset === dataset && c.state === s).reduce((a, c) => a + Number(c.days), 0);
      const completeDays = n("complete");
      const partialDays = n("partial");
      const unavailableDays = n("unavailable");
      const missingDays = Math.max(0, windowDays - completeDays - partialDays - unavailableDays);
      return {
        dataset,
        completeDays,
        partialDays,
        unavailableDays,
        missingDays,
        coveragePct: Math.round((Math.min(completeDays, windowDays) / windowDays) * 1000) / 10,
      };
    });
    const coveragePct = datasets.length
      ? Math.round((datasets.reduce((a, d) => a + d.coveragePct, 0) / datasets.length) * 10) / 10
      : null;
    return {
      sourceId: id,
      state: w?.state ?? "unknown",
      watermark: iso(w?.newest_event_time ?? null),
      lagSeconds: w?.provider_lag_seconds ?? null,
      gapCount: w?.gap_count ?? null,
      coveragePct,
      coverageWindow: window,
      datasets,
      recentErrors: gaps
        .filter((g) => g.provider_id === id)
        .slice(0, 5)
        .map((g) => ({
          dataset: g.dataset,
          reasonCode: g.reason_code,
          state: g.state,
          from: iso(g.from_utc) ?? g.from_utc,
          to: iso(g.to_utc) ?? g.to_utc,
        })),
      rateLimit: rl
        ? {
            status: Number(rl.limited) > 0 ? "limited" : "not_limited",
            detail: `${Number(rl.limited)} of ${Number(rl.attempts)} attempts answered HTTP 429 in the last ${RATE_LIMIT_WINDOW_DAYS} days (HTTP status only; response headers are not archived).`,
            attempts: Number(rl.attempts),
            limited: Number(rl.limited),
            windowDays: RATE_LIMIT_WINDOW_DAYS,
            lastAttemptAt: iso(rl.last_attempt),
          }
        : null,
      rateLimitRecorded: rl !== undefined,
      schemaVersion: w?.schema_version ?? null,
    };
  });
}

export function createSourceHealthPort(): SourceHealthPort {
  let ch: ReturnType<typeof createCh> | null = null;
  const q = async <T>(query: string): Promise<T[]> => {
    ch ??= createCh({ database: process.env.NEARESIS_CH_LIVE_DATABASE ?? "nearesis_live" });
    const rs = await ch.query({ query, format: "JSONEachRow" });
    return (await rs.json()) as T[];
  };
  return {
    async read() {
      const [w, c, g, rl] = await Promise.all([
        q<WatermarkRow>(
          "SELECT provider_id, toString(newest_event_time) AS newest_event_time, gap_count, provider_lag_seconds, schema_version, state FROM source_watermarks FINAL",
        ),
        q<CoverageRow>(
          `SELECT c.provider_id AS provider_id, c.dataset AS dataset, c.state AS state, count() AS days, toString(any(m.newest)) AS newest
             FROM source_coverage AS c FINAL
             INNER JOIN (SELECT provider_id, max(day) AS newest FROM source_coverage FINAL GROUP BY provider_id) AS m
               ON m.provider_id = c.provider_id
            WHERE c.day > m.newest - ${COVERAGE_WINDOW_DAYS}
            GROUP BY c.provider_id, c.dataset, c.state`,
        ),
        q<GapRow>(
          `SELECT provider_id, dataset, state, reason_code, toString(from_utc) AS from_utc, toString(to_utc) AS to_utc
             FROM quality_gaps FINAL ORDER BY from_utc DESC LIMIT 200`,
        ),
        // Only the 1Click quote sampler records rate-limit outcomes (quote_intel); a missing table means none recorded.
        q<RateLimitRow>(
          `SELECT 'intents-1click' AS provider_id, toString(countIf(availability != 'not_attempted')) AS attempts,
                  toString(countIf(rate_limit_status = 'limited')) AS limited, toString(maxIf(scheduled_bucket_utc, availability != 'not_attempted')) AS last_attempt
             FROM quote_intel FINAL WHERE scheduled_bucket_utc >= now() - INTERVAL ${RATE_LIMIT_WINDOW_DAYS} DAY`,
        ).catch(() => []),
      ]);
      return assembleSourceHealth(w, c, g, COVERAGE_WINDOW_DAYS, rl);
    },
    async close() {
      await ch?.close();
    },
  };
}
