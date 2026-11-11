import { IngestionError } from "../errors.ts";
import { OneClickQuoteSampler, type SamplerAttemptResult } from "../adapters/oneclick.ts";
import type { CredentialSource } from "../http/credentials.ts";
import { quoteAddress, type SchedulerConfig } from "./config.ts";
import {
  DEFAULT_ROUTES,
  limitSlots,
  planQuoteGrid,
  quoteBucket,
  type PlannedSlot,
  type RouteDef,
  type TokenInfo,
} from "./plan.ts";
import type { SchedulerStateStore } from "./state.ts";

export type QuoteRow = Record<string, unknown>;

export interface QuoteRoundDeps {
  sampler: OneClickQuoteSampler;
  creds: Pick<CredentialSource, "get" | "has">;
  cfg: SchedulerConfig;
  store: SchedulerStateStore;
  nowMs: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Writes rows to nearesis_live.quote_attempts. */
  insert: (rows: QuoteRow[]) => Promise<void>;
  routes?: RouteDef[];
  shouldStop?: () => boolean;
  log?: (m: string) => void;
}

export interface QuoteRoundResult {
  bucketUTC: string;
  planned: number;
  attempted: number;
  unavailable: number;
  classes: Record<string, number>;
  complete: boolean;
}

const DEC = /^\d+(\.\d{1,18})?$/;
const dec = (v: unknown): string | null => (typeof v === "string" && DEC.test(v) ? v : null);

/** Fields recorded from a quote response body. Everything stays null when the body does not carry it. */
export function parseQuoteFacts(payload: Uint8Array | null): {
  amountInUsd: string | null;
  amountOutUsd: string | null;
  timeEstimateS: number | null;
  quoteTimestamp: string | null;
} {
  const none = { amountInUsd: null, amountOutUsd: null, timeEstimateS: null, quoteTimestamp: null };
  if (!payload) return none;
  try {
    const j = JSON.parse(new TextDecoder().decode(payload)) as {
      timestamp?: unknown;
      quote?: { amountInUsd?: unknown; amountOutUsd?: unknown; timeEstimate?: unknown };
    };
    const ts = typeof j.timestamp === "string" && !Number.isNaN(Date.parse(j.timestamp)) ? j.timestamp : null;
    const te = j.quote?.timeEstimate;
    return {
      amountInUsd: dec(j.quote?.amountInUsd),
      amountOutUsd: dec(j.quote?.amountOutUsd),
      timeEstimateS: typeof te === "number" && Number.isFinite(te) ? te : null,
      quoteTimestamp: ts,
    };
  } catch {
    return none;
  }
}

const base = (s: PlannedSlot, bucketIso: string): QuoteRow => ({
  route_id: s.routeId,
  origin_asset: s.originAsset,
  destination_asset: s.destinationAsset,
  origin_chain: s.originChain,
  destination_chain: s.destinationChain,
  notional_usd: s.notionalUsd,
  amount_base_units: s.amountBaseUnits ?? "",
  privacy_mode: s.privacyMode,
  scheduled_bucket_utc: bucketIso,
  attempt_no: 1,
  dry: 1,
  source_label: "LIVE",
});

export const unavailableRow = (
  s: PlannedSlot,
  bucketIso: string,
  reason: string,
  nowMs: number,
): QuoteRow => ({
  ...base(s, bucketIso),
  slot: "unavailable",
  class: null,
  reason,
  version: nowMs,
});

export function observedRow(
  s: PlannedSlot,
  bucketIso: string,
  r: SamplerAttemptResult,
  latencyMs: number,
): QuoteRow {
  const a = r.attempt;
  const f = parseQuoteFacts(r.payload);
  return {
    ...base(s, bucketIso),
    slot: "observed",
    class: a.class,
    reason: r.reason,
    http_status: r.status,
    amount_out_base_units: a.amountOutBaseUnits,
    amount_in_usd: f.amountInUsd,
    amount_out_usd: f.amountOutUsd,
    time_estimate_s: f.timeEstimateS,
    quote_timestamp: f.quoteTimestamp,
    latency_ms: Math.max(0, Math.round(latencyMs)),
    fetched_at: a.fetchedAtUTC,
    raw_object_hash: a.rawObjectHash,
    version: Date.parse(a.fetchedAtUTC),
  };
}

/**
 * One sampling round for the current hourly bucket. Every grid slot ends as exactly one row (an attempt with its class, or
 * `unavailable` with the reason); a slot already recorded in this bucket is not repeated, so an interrupted round resumes.
 * Only GET /v0/tokens and POST /v0/quote with dry:true are reachable (OneClickQuoteSampler.call refuses everything else).
 */
export async function runQuoteRound(d: QuoteRoundDeps): Promise<QuoteRoundResult> {
  const log = d.log ?? (() => undefined);
  const q = d.store.state.quotes;
  const bucket = quoteBucket(d.nowMs(), d.cfg.quoteIntervalMs);
  const bucketIso = new Date(bucket).toISOString();
  if (q.bucketMs !== bucket) {
    q.bucketMs = bucket;
    q.slotsDone = [];
  }
  let tokens = new Map<string, TokenInfo>();
  let tokensFailed = false;
  try {
    const t = await d.sampler.fetchTokens();
    tokens = new Map(t.tokens.map((x) => [x.assetId, x]));
  } catch (e) {
    if (e instanceof IngestionError && (e.code === "ENDPOINT_NOT_ALLOWLISTED" || e.code === "DRY_REQUIRED"))
      throw e;
    tokensFailed = true;
    log(`tokens fetch failed: ${(e as Error).name}`);
  }
  const grid = planQuoteGrid({
    routes: d.routes ?? DEFAULT_ROUTES,
    tokens,
    notionalsUsd: d.cfg.quoteNotionalsUsd,
    modes: d.cfg.quotePrivacyModes,
    hasAddress: (kind, chain) => quoteAddress(d.creds, kind, chain) !== null,
  });
  const slots = limitSlots(grid, d.cfg.quoteLimit);
  const classes: Record<string, number> = {};
  let attempted = 0;
  let unavailable = 0;
  let stopped = false;
  for (const s of slots) {
    if (q.slotsDone.includes(s.key)) continue;
    if (d.shouldStop?.()) {
      stopped = true;
      break;
    }
    if (tokensFailed || s.unavailableReason !== null || s.amountBaseUnits === null) {
      await d.insert([
        unavailableRow(
          s,
          bucketIso,
          tokensFailed ? "TOKENS_FETCH_FAILED" : (s.unavailableReason ?? "UNPLANNED"),
          d.nowMs(),
        ),
      ]);
      q.slotsDone.push(s.key);
      unavailable++;
      d.store.save();
      continue;
    }
    const recipient = quoteAddress(d.creds, "recipient", s.destinationChain) as string;
    const refundTo = quoteAddress(d.creds, "refund", s.originChain) as string;
    const t0 = d.nowMs();
    let row: QuoteRow;
    try {
      const r = await d.sampler.attempt({
        routeId: s.routeId,
        originAsset: s.originAsset,
        destinationAsset: s.destinationAsset,
        amountBaseUnits: s.amountBaseUnits,
        privacyMode: s.privacyMode,
        scheduledBucketUTC: bucketIso,
        attemptNo: 1,
        recipient,
        refundTo,
        ...(s.destDecimals !== null ? { destDecimals: s.destDecimals } : {}),
      });
      row = observedRow(s, bucketIso, r, d.nowMs() - t0);
      classes[r.attempt.class] = (classes[r.attempt.class] ?? 0) + 1;
      attempted++;
      q.lastAttemptAtMs = d.nowMs();
      if (r.attempt.class === "OK") q.lastOkAtMs = d.nowMs();
    } catch (e) {
      // Policy violations abort the whole round; any other failure of this one slot is recorded, not hidden.
      if (e instanceof IngestionError && (e.code === "ENDPOINT_NOT_ALLOWLISTED" || e.code === "DRY_REQUIRED"))
        throw e;
      row = unavailableRow(s, bucketIso, `SAMPLER_ERROR:${(e as Error).name}`, d.nowMs());
      unavailable++;
    }
    await d.insert([row]);
    q.slotsDone.push(s.key);
    q.attempts = row.slot === "observed" ? q.attempts + 1 : q.attempts;
    d.store.save();
    if (d.cfg.quotePaceMs > 0) await d.sleep(d.cfg.quotePaceMs);
  }
  const complete = !stopped && slots.every((s) => q.slotsDone.includes(s.key));
  if (complete) {
    q.completedBucketMs = bucket;
    q.roundsCompleted++;
  }
  d.store.save();
  log(`quote round ${bucketIso}: attempted ${attempted}, unavailable ${unavailable}, complete ${complete}`);
  return { bucketUTC: bucketIso, planned: slots.length, attempted, unavailable, classes, complete };
}
