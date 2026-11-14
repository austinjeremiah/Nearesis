import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { createClient } from "@clickhouse/client";
import { KernelError } from "@nearesis/kernel";
import type { Session } from "@nearesis/kernel";

/** Read model of the opt-in near-real-time NEAR feed (`nearesis_live.rt_*`, written by services/ingestion/src/realtime). */
export interface RealtimeWatermark {
  height: number;
  blockHash: string;
  blockTime: string;
  headHeight: number;
  observedAt: string;
  ingestedAt: string;
  lagSeconds: number;
  firstBlockTime: string;
  skippedHeights: number;
  state: string;
  provider: string;
}
export interface RealtimeMinute {
  minute: string;
  state: "final" | "provisional";
  complete: boolean;
  txCount: number;
  receiptCount: number | null;
  gasBurnt: string;
  tokensBurntYocto: string;
  activeSigners: number;
}
export interface RealtimeRecon {
  day: string;
  status: string;
  bqTxCount: number | null;
  rtTxCount: number;
  diff: number | null;
  diffPct: number | null;
  note: string;
}
export interface RealtimeSource {
  watermark(): Promise<RealtimeWatermark | null>;
  minutesSince(fromIso: string): Promise<RealtimeMinute[]>;
  reconciliation(limit: number): Promise<RealtimeRecon[]>;
  anomalyCount(sinceIso: string): Promise<number>;
}
export interface RealtimeRoutesOptions {
  authenticate(req: FastifyRequest): Promise<Session>;
  source?: RealtimeSource;
  now?: () => number;
}

export const REALTIME_LIMITATIONS = [
  "Forward-only: the feed starts at the final head when first run; there is no real-time history before that.",
  "Only blocks with `final` finality are stored. A minute still accumulating is reported as provisional and is excluded from finalized totals.",
  "Public-RPC mode: transactions, signers and per-receiver counts are exact per block; receipts are NULL unless the feed runs with --with-receipts (then they are the receipts carried in new chunks, not executed outcomes); gas and tokens burnt are the chunk-header values reported in that block, i.e. the previous block's execution (exact in total, shifted one block).",
  "Daily BigQuery loads stay the historical authority; real-time days are reconciled against them and any difference is reported, never silently corrected.",
] as const;

const iso = (ms: number): string => new Date(ms).toISOString();
const sqlTs = (ms: number): string => iso(ms).replace("T", " ").replace("Z", "");

export function buildFreshness(
  wm: RealtimeWatermark | null,
  recon: RealtimeRecon[],
  anomalies24h: number,
  nowMs: number,
) {
  if (!wm)
    return {
      status: "NO_DATA" as const,
      reason: "The real-time feed has not run (it is opt-in: scripts/ops/supervise.sh start realtime).",
      limitations: REALTIME_LIMITATIONS,
    };
  const ageSeconds = Math.max(0, (nowMs - Date.parse(wm.ingestedAt)) / 1000);
  // The feed writes its watermark every ~5 s; older than 120 s means the collector is not running, whatever the stored state says.
  const state = ageSeconds > 120 ? "stopped" : wm.state;
  const today = iso(nowMs).slice(0, 10);
  const warnings: string[] = [];
  if (state === "stopped") warnings.push("Collector heartbeat is older than 120 s: the feed is not running.");
  if (state === "catching_up") warnings.push("Collector is behind the final head and catching up.");
  if (state === "stalled") warnings.push("Newest ingested block is more than 60 s old at the head.");
  if (anomalies24h > 0)
    warnings.push(
      `${anomalies24h} integrity anomalies recorded in the last 24 h (gap or final-hash conflict).`,
    );
  warnings.push(
    `${today} is a partial day: real-time totals for it are not reconciled until BigQuery lands the day.`,
  );
  if (recon.some((r) => r.status === "DIFF"))
    warnings.push("At least one reconciled day differs from BigQuery beyond tolerance.");
  return {
    status: "OK" as const,
    provider: wm.provider,
    finality: "final" as const,
    lastObservationTime: wm.observedAt,
    lastIngestionTime: wm.ingestedAt,
    watermark: { height: wm.height, blockHash: wm.blockHash, blockTime: wm.blockTime },
    collectorLagSeconds: wm.lagSeconds,
    blocksBehindHead: Math.max(0, wm.headHeight - wm.height),
    collectorState: state,
    heartbeatAgeSeconds: ageSeconds,
    historicalCoverage: {
      from: wm.firstBlockTime,
      to: wm.blockTime,
      skippedHeights: wm.skippedHeights,
      forwardOnly: true,
    },
    reconciliation: { authority: "bigquery-daily", recent: recon },
    partialDayWarnings: warnings,
    dataVintageLimitations: REALTIME_LIMITATIONS,
  };
}

/** Last 60 complete minutes: finalized total from complete+final minutes; the open minute is provisional and kept separate. */
export function buildLastHour(mins: RealtimeMinute[], nowMs: number) {
  const hourStart = Math.floor(nowMs / 60_000) * 60_000 - 3_600_000;
  const inWin = mins.filter((m) => Date.parse(m.minute) >= hourStart);
  const fin = inWin.filter((m) => m.state === "final" && m.complete);
  const prov = inWin.filter((m) => m.state === "provisional");
  const sum = (xs: RealtimeMinute[]): number => xs.reduce((s, m) => s + m.txCount, 0);
  // receipts are NULL (never 0) when the source mode does not fetch them
  const receipts = fin.some((m) => m.receiptCount === null)
    ? null
    : fin.reduce((s, m) => s + (m.receiptCount ?? 0), 0);
  const gas = fin.reduce((s, m) => s + BigInt(m.gasBurnt), 0n);
  const covered = fin.length;
  return {
    status:
      covered === 0 ? ("INSUFFICIENT_DATA" as const) : covered < 60 ? ("PARTIAL" as const) : ("OK" as const),
    metric: "transactions_last_hour",
    window: { from: iso(hourStart), to: iso(hourStart + 3_600_000), minutes: 60 },
    finalized: {
      transactions: sum(fin),
      receipts,
      gasBurnt: gas.toString(),
      minutesCovered: covered,
    },
    provisional: {
      transactions: sum(prov),
      minutes: prov.length,
      note: "Open or unfinalized minutes; never part of the finalized figure.",
    },
    missingMinutes: 60 - covered,
    caveat:
      covered < 60
        ? "Fewer than 60 complete final minutes are available (feed started inside the window, was stopped, or is catching up); the figure is a lower bound, not zero-filled."
        : null,
    limitations: REALTIME_LIMITATIONS,
  };
}

export const realtimeRoutes: FastifyPluginAsync<RealtimeRoutesOptions> = async (app, opts) => {
  let client: ReturnType<typeof createClient> | undefined;
  const ch = (): ReturnType<typeof createClient> => {
    client ??= createClient({
      url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
      username: process.env.NEARESIS_CH_USER ?? "nearesis",
      password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
      database: "nearesis_live",
    });
    return client;
  };
  const rows = async <T>(query: string, p: Record<string, unknown> = {}): Promise<T[]> =>
    (await (await ch().query({ query, query_params: p, format: "JSONEachRow" })).json()) as T[];
  const src: RealtimeSource = opts.source ?? {
    async watermark() {
      const r = await rows<Record<string, string | number>>(
        `SELECT provider, height, block_hash, formatDateTime(block_ts, '%Y-%m-%dT%H:%i:%S.000Z', 'UTC') AS bt, head_height,
                formatDateTime(observed_at, '%Y-%m-%dT%H:%i:%S.000Z', 'UTC') AS oa, formatDateTime(ingested_at, '%Y-%m-%dT%H:%i:%S.000Z', 'UTC') AS ia,
                lag_seconds, formatDateTime(first_block_ts, '%Y-%m-%dT%H:%i:%S.000Z', 'UTC') AS fb, skipped_heights, state
         FROM rt_watermark FINAL WHERE feed_id = 'near-mainnet-final' LIMIT 1`,
      );
      const x = r[0];
      return x
        ? {
            provider: String(x.provider),
            height: Number(x.height),
            blockHash: String(x.block_hash),
            blockTime: String(x.bt),
            headHeight: Number(x.head_height),
            observedAt: String(x.oa),
            ingestedAt: String(x.ia),
            lagSeconds: Number(x.lag_seconds),
            firstBlockTime: String(x.fb),
            skippedHeights: Number(x.skipped_heights),
            state: String(x.state),
          }
        : null;
    },
    async minutesSince(fromIso) {
      const r = await rows<Record<string, string | number>>(
        `SELECT formatDateTime(minute, '%Y-%m-%dT%H:%i:00.000Z', 'UTC') AS m, state, complete, toString(tx_count) AS tx, toString(receipt_count) AS rc,
                toString(gas_burnt) AS gas, toString(tokens_burnt_yocto) AS tok, active_signers
         FROM rt_minutes FINAL WHERE minute >= parseDateTime64BestEffort({f:String}, 0, 'UTC') ORDER BY minute`,
        { f: fromIso },
      );
      return r.map((x) => ({
        minute: String(x.m),
        state: x.state === "final" ? ("final" as const) : ("provisional" as const),
        complete: Number(x.complete) === 1,
        txCount: Number(x.tx),
        receiptCount: x.rc === null || x.rc === undefined ? null : Number(x.rc),
        gasBurnt: String(x.gas),
        tokensBurntYocto: String(x.tok),
        activeSigners: Number(x.active_signers),
      }));
    },
    async reconciliation(limit) {
      const r = await rows<Record<string, string | null>>(
        `SELECT toString(day) AS d, status, toString(bq_tx_count) AS bq, toString(rt_tx_count) AS rt, toString(diff) AS diff, toString(diff_pct) AS pct, note
         FROM rt_reconciliation FINAL ORDER BY day DESC LIMIT {l:UInt32}`,
        { l: limit },
      );
      const n = (v: string | null | undefined): number | null =>
        v === null || v === undefined || v === "\\N" ? null : Number(v);
      return r.map((x) => ({
        day: String(x.d),
        status: String(x.status),
        bqTxCount: n(x.bq),
        rtTxCount: Number(x.rt),
        diff: n(x.diff),
        diffPct: n(x.pct),
        note: String(x.note ?? ""),
      }));
    },
    async anomalyCount(sinceIso) {
      const r = await rows<{ n: string }>(
        `SELECT toString(count()) AS n FROM rt_anomalies WHERE at >= parseDateTime64BestEffort({s:String}, 3, 'UTC')`,
        { s: sinceIso },
      );
      return Number(r[0]?.n ?? 0);
    },
  };
  const now = opts.now ?? Date.now;
  app.addHook("onClose", async () => {
    await client?.close();
  });
  async function guarded<T>(req: FastifyRequest, fn: () => Promise<T>): Promise<T> {
    await opts.authenticate(req);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof KernelError) throw e;
      req.log.error({ err: e }, "realtime source failed");
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "REALTIME_SOURCE_UNAVAILABLE",
        "The real-time data source is unavailable.",
        { retryable: true },
      );
    }
  }

  /** Freshness of the opt-in real-time layer: last observation/ingestion time, watermark, finality, coverage, lag, reconciliation. */
  app.get("/v1/realtime/freshness", (req) =>
    guarded(req, async () => {
      const t = now();
      const [wm, recon, an] = await Promise.all([
        src.watermark(),
        src.reconciliation(7),
        src.anomalyCount(sqlTs(t - 86_400_000)),
      ]);
      return buildFreshness(wm, recon, an, t);
    }),
  );
  /** Draft semantic metric `transactions_last_hour` served from final minutes only. */
  app.get("/v1/realtime/transactions-last-hour", (req) =>
    guarded(req, async () => {
      const t = now();
      return buildLastHour(await src.minutesSince(iso(Math.floor(t / 60_000) * 60_000 - 3_600_000)), t);
    }),
  );
};
