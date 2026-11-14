import type { ClickHouseClient } from "@clickhouse/client";
import type { BigQueryLike } from "../adapters/bigquery.ts";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import { aggregateToDaily, buildPriceRows, eachDay, PRICE_ADAPTER_VERSION } from "../adapters/price.ts";
import type { RawArchive } from "../archive/archive.ts";
import type { BudgetLedger } from "../backfill/budget.ts";
import type { BudgetedBigQuery } from "../backfill/bq-runner.ts";
import { coverageRows, insertLive, priceRows } from "../backfill/ch.ts";
import type { ChunkSink } from "../backfill/orchestrator.ts";
import { addDays, type Chunk } from "../backfill/plan.ts";
import { PRICE_BASIS, parseHourlyPoints, priceWindows } from "../backfill/price-phase.ts";
import { chunkSql } from "../backfill/sql.ts";
import type { StateStore } from "../backfill/state.ts";
import { IngestionError } from "../errors.ts";
import { ALLOW_COINGECKO_PUBLIC, HttpClient } from "../http/client.ts";
import type { CredentialSource } from "../http/credentials.ts";
import type { SchedulerConfig } from "./config.ts";
import { pendingBqDays, pendingPriceDays } from "./plan.ts";
import type { SchedulerStateStore } from "./state.ts";

const HOUR = 3_600_000;

export const dayChunks = (day: string): Chunk[] =>
  (["transactions", "receivers"] as const).map((family) => ({
    id: `${family}:${day}`,
    family,
    from: day,
    to: addDays(day, 1),
  }));

// ---------------------------------------------------------------- BigQuery (last completed UTC day)

export interface BqDailyResult {
  completed: string[];
  budgetSkipped: Array<{ id: string; estimateBytes: number }>;
  /** Days that returned no rows yet (provider lag): left pending and retried, not written as gaps. */
  retryLater: string[];
  gapsRecorded: string[];
}

export async function runBqDaily(d: {
  runner: BudgetedBigQuery;
  bqStore: StateStore;
  sched: SchedulerStateStore;
  sink: ChunkSink;
  ledger: BudgetLedger;
  location: string;
  cfg: SchedulerConfig;
  nowMs: () => number;
  log?: (m: string) => void;
}): Promise<BqDailyResult> {
  const log = d.log ?? (() => undefined);
  const res: BqDailyResult = { completed: [], budgetSkipped: [], retryLater: [], gapsRecorded: [] };
  const days = pendingBqDays(d.nowMs(), (id) => d.bqStore.isDone(id)).slice(0, d.cfg.bqMaxDaysPerRun);
  for (const day of days) {
    const empty = d.sched.state.bqEmpty[day];
    if (
      empty &&
      empty.count < d.cfg.emptyDayRetries &&
      d.nowMs() - empty.lastAtMs < d.cfg.emptyDayRetrySpacingMs
    ) {
      res.retryLater.push(day);
      continue;
    }
    for (const chunk of dayChunks(day)) {
      if (d.bqStore.isDone(chunk.id)) continue;
      // Dry run, 2% fit check against today's remaining budget and maximumBytesBilled all happen inside runChunk.
      const o = await d.runner.runChunk(chunk, d.ledger, d.location);
      if (o.status === "budget") {
        res.budgetSkipped.push({ id: chunk.id, estimateBytes: o.estimateBytes });
        log(`defer ${chunk.id}: ${o.reason} (est ${o.estimateBytes} B, remaining ${o.remaining} B)`);
        continue;
      }
      const prev = d.sched.state.bqEmpty[day];
      if (o.rows.length === 0 && (prev?.count ?? 0) + 1 < d.cfg.emptyDayRetries) {
        d.sched.state.bqEmpty[day] = { count: (prev?.count ?? 0) + 1, lastAtMs: d.nowMs() };
        d.sched.save();
        res.retryLater.push(day);
        log(`${chunk.id}: no rows yet, retrying later`);
        break;
      }
      const rows = await d.sink(chunk, o); // an empty day is written as a gap + unavailable coverage, never as zeros
      if (o.rows.length === 0) res.gapsRecorded.push(chunk.id);
      d.bqStore.markDone({
        id: chunk.id,
        family: chunk.family,
        from: chunk.from,
        to: chunk.to,
        rows,
        estimateBytes: o.estimateBytes,
        billedBytes: o.billedBytes,
        jobId: o.jobId,
        rawObjectHash: o.objectHash,
        completedAtUTC: new Date(d.nowMs()).toISOString(),
        quotaDay: new Date(d.nowMs()).toISOString().slice(0, 10),
      });
      res.completed.push(chunk.id);
      log(`done ${chunk.id}: ${rows} rows, billed ${o.billedBytes} B`);
    }
  }
  return res;
}

/** Dry-run estimates only (free): what the next BigQuery run would scan, and whether each chunk fits today's budget. */
export async function planBqDry(d: {
  bq: BigQueryLike;
  location: string;
  ledger: BudgetLedger;
  bqStore: StateStore;
  cfg: SchedulerConfig;
  nowMs: number;
}): Promise<Array<{ id: string; estimateBytes: number; fits: boolean; maximumBytesBilled: number | null }>> {
  const out: Array<{ id: string; estimateBytes: number; fits: boolean; maximumBytesBilled: number | null }> =
    [];
  const days = pendingBqDays(d.nowMs, (id) => d.bqStore.isDone(id)).slice(0, d.cfg.bqMaxDaysPerRun);
  for (const day of days)
    for (const chunk of dayChunks(day)) {
      if (d.bqStore.isDone(chunk.id)) continue;
      const sql = chunkSql(chunk);
      assertGuardedSql(sql);
      const [job] = await d.bq.createQueryJob({
        query: sql,
        dryRun: true,
        location: d.location,
        useQueryCache: false,
      });
      const est = Number(
        job.metadata.statistics?.totalBytesProcessed ??
          job.metadata.statistics?.query?.totalBytesProcessed ??
          Number.NaN,
      );
      const fit = d.ledger.check(est);
      out.push({
        id: chunk.id,
        estimateBytes: est,
        fits: fit.ok,
        maximumBytesBilled: fit.ok ? fit.maximumBytesBilled : null,
      });
    }
  return out;
}

// ---------------------------------------------------------------- CoinGecko daily price

export interface PriceDailyResult {
  requests: number;
  daysLoaded: string[];
  gapsRecorded: string[];
  retryLater: string[];
}

export async function runPriceDaily(d: {
  ch: ClickHouseClient;
  archive: RawArchive;
  creds: CredentialSource;
  sched: SchedulerStateStore;
  cfg: SchedulerConfig;
  nowMs: () => number;
  fetchImpl?: ConstructorParameters<typeof HttpClient>[0]["fetchImpl"];
  log?: (m: string) => void;
}): Promise<PriceDailyResult> {
  const log = d.log ?? (() => undefined);
  const st = d.sched.state.price;
  const res: PriceDailyResult = { requests: 0, daysLoaded: [], gapsRecorded: [], retryLater: [] };
  const pending = pendingPriceDays(d.nowMs(), st);
  if (pending.length === 0) return res;
  const hasKey = d.creds.has("COINGECKO_API_KEY");
  const http = new HttpClient({
    allow: [ALLOW_COINGECKO_PUBLIC],
    credentials: d.creds,
    ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}),
  });
  const cfg = { coinId: "near", symbol: "NEAR", quoteCurrency: "usd" };
  const nowIso = (): string => new Date(d.nowMs()).toISOString();
  // One request per window of at most 89 days (hourly points), whole UTC days only.
  for (const w of priceWindows(pending[0] as string, pending[pending.length - 1] as string)) {
    const url = `https://api.coingecko.com/api/v3/coins/near/market_chart/range?vs_currency=usd&from=${Date.parse(`${w.from}T00:00:00Z`) / 1000}&to=${Date.parse(`${w.to}T00:00:00Z`) / 1000}`;
    const r = await http.request({
      method: "GET",
      url,
      ...(hasKey
        ? { auth: { credential: "COINGECKO_API_KEY", header: "x-cg-demo-api-key", scheme: "" as const } }
        : {}),
    });
    st.requests++;
    res.requests++;
    if (r.status !== 200)
      throw new IngestionError("AUTH_REJECTED", true, { reason: "coingecko non-200", status: r.status });
    const fetchedAtUTC = new Date(r.receivedAtMs).toISOString();
    const a = await d.archive.archive({
      providerId: "coingecko",
      adapterVersion: PRICE_ADAPTER_VERSION,
      method: "GET",
      url,
      sourceEnvironment: "live",
      fetchedAtUTC,
      receivedAtUTC: fetchedAtUTC,
      providerEventAtUTC: null,
      providerEventAtNullReason: "range of hourly price points; no single event time",
      responseStatus: 200,
      contentType: "application/json",
      payload: r.body,
      privacyVisibility: "public",
      completeness: "complete",
    });
    const fromMs = Date.parse(`${w.from}T00:00:00Z`);
    const toMs = Date.parse(`${w.to}T00:00:00Z`);
    const inWin = parseHourlyPoints(r.body).filter((c) => c.tsMs >= fromMs && c.tsMs < toMs);
    const dedup = [...new Map(inWin.map((c) => [c.tsMs, c])).values()];
    const daily = aggregateToDaily(dedup, HOUR); // only days with all 24 samples; the rest stay gaps
    const bytes = new TextEncoder().encode(
      `[${daily.map((c) => `[${c.tsMs},${c.open},${c.high},${c.low},${c.close}]`).join(",")}]`,
    );
    const lastDay = addDays(w.to, -1);
    const built = buildPriceRows({ ...cfg, window: { from: w.from, to: lastDay } }, [
      { fileBytes: bytes, fetchedAtUTC, rawObjectHash: a.observation.payloadObjectHash, sourceLabel: "LIVE" },
    ]);
    const have = new Set(built.rows.map((x) => x.bucketStartUTC.slice(0, 10)));
    const v = d.nowMs();
    await insertLive(d.ch, "price_candles", priceRows(built.rows, PRICE_BASIS));
    const gapRows: Array<Record<string, unknown>> = [];
    const covRows: Parameters<typeof coverageRows>[0] = [];
    for (const day of eachDay(w.from, lastDay)) {
      if (st.doneDays.includes(day) || st.gapDays.includes(day)) continue;
      if (have.has(day)) {
        st.doneDays.push(day);
        res.daysLoaded.push(day);
        covRows.push({
          provider_id: "coingecko",
          dataset: "price_candles",
          day,
          state: "complete",
          reason: null,
          version: v,
        });
        continue;
      }
      // Incomplete day: retried a few times (the provider may still be filling it), then a recorded gap. Never filled.
      st.attempts[day] = (st.attempts[day] ?? 0) + 1;
      if (st.attempts[day] >= d.cfg.priceAttemptsBeforeGap) {
        st.gapDays.push(day);
        res.gapsRecorded.push(day);
        covRows.push({
          provider_id: "coingecko",
          dataset: "price_candles",
          day,
          state: "unavailable",
          reason: "PROVIDER_GAP",
          version: v,
        });
        gapRows.push({
          provider_id: "coingecko",
          dataset: "price_candles",
          from_utc: `${day}T00:00:00.000Z`,
          to_utc: `${day}T23:59:59.999Z`,
          state: "unavailable",
          reason_code: "PROVIDER_GAP",
          source_label: "LIVE",
          version: v,
        });
      } else res.retryLater.push(day);
    }
    await insertLive(d.ch, "source_coverage", coverageRows(covRows));
    await insertLive(d.ch, "quality_gaps", gapRows);
    d.sched.save();
    log(
      `price window ${w.from}..${w.to}: ${dedup.length} hourly points, ${daily.length} complete days (${nowIso()})`,
    );
  }
  return res;
}
