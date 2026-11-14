import { addDays } from "../backfill/plan.ts";
import {
  ALL_TASKS,
  FORWARD_FROM_DAY,
  type SchedulerConfig,
  type TaskName,
  type PrivacyMode,
} from "./config.ts";
import type { SchedulerState } from "./state.ts";

const DAY_MS = 86_400_000;
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const dayStartMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** The most recent UTC day that has fully ended. */
export const lastCompletedDay = (nowMs: number): string => addDays(utcDay(nowMs), -1);

/** Days in [from, to] inclusive, oldest first. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** BigQuery chunk ids for one day: both families. */
export const bqChunkIds = (day: string): string[] => [`transactions:${day}`, `receivers:${day}`];

/** Days (oldest first) that still need BigQuery data: every completed day since the forward start with an unfinished family. */
export function pendingBqDays(nowMs: number, isDone: (chunkId: string) => boolean): string[] {
  const last = lastCompletedDay(nowMs);
  if (last < FORWARD_FROM_DAY) return [];
  return daysBetween(FORWARD_FROM_DAY, last).filter((d) => !bqChunkIds(d).every(isDone));
}

export function pendingPriceDays(nowMs: number, st: SchedulerState["price"]): string[] {
  const last = lastCompletedDay(nowMs);
  if (last < FORWARD_FROM_DAY) return [];
  const settled = new Set([...st.doneDays, ...st.gapDays]);
  return daysBetween(FORWARD_FROM_DAY, last).filter((d) => !settled.has(d));
}

export interface Facts {
  bqPending: number;
  pricePending: number;
  explorerInflight: boolean;
  /** Pending days of the enabled forward jobs (0 when every flag is off). Optional so older callers keep working. */
  forwardPending?: number;
}

/**
 * Which tasks are due now. Daily tasks wait for `dailyDelayMs` after UTC midnight so the previous day is complete at the
 * providers; a failed task honours its backoff (`nextAttemptAtMs`).
 */
export function dueTasks(
  nowMs: number,
  st: SchedulerState,
  cfg: SchedulerConfig,
  f: Facts,
  only: readonly TaskName[] = ALL_TASKS,
): TaskName[] {
  const due: TaskName[] = [];
  const sinceMidnight = nowMs - dayStartMs(utcDay(nowMs));
  const ready = (t: TaskName): boolean => nowMs >= st.tasks[t].nextAttemptAtMs;
  const elapsed = (t: TaskName, every: number): boolean =>
    st.tasks[t].lastOkAtMs === null || nowMs - st.tasks[t].lastOkAtMs >= every;
  for (const t of only) {
    if (!ready(t)) continue;
    if (t === "bq" && f.bqPending > 0 && sinceMidnight >= cfg.dailyDelayMs) due.push(t);
    if (t === "forward" && (f.forwardPending ?? 0) > 0 && sinceMidnight >= cfg.dailyDelayMs) due.push(t);
    if (t === "price" && f.pricePending > 0 && sinceMidnight >= cfg.dailyDelayMs) due.push(t);
    if (t === "explorer" && (f.explorerInflight || elapsed("explorer", cfg.explorerIntervalMs))) due.push(t);
    if (t === "quotes" && st.quotes.completedBucketMs !== quoteBucket(nowMs, cfg.quoteIntervalMs))
      due.push(t);
  }
  return due;
}

export const quoteBucket = (nowMs: number, intervalMs: number): number =>
  Math.floor(nowMs / intervalMs) * intervalMs;

/** Backoff after a failure: 1, 2, 4 ... up to 30 minutes. */
export const backoffMs = (failures: number): number =>
  Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, failures - 1));

// ---------- 1Click quote grid (ch.07: ~10 routes x 4 notionals x public/basic/advanced where supported) ----------

export interface RouteDef {
  originAsset: string;
  destinationAsset: string;
}
/** Real asset ids from GET /v0/tokens (checked 2026-11-11). Routes whose asset is no longer listed become `unavailable` slots. */
export const DEFAULT_ROUTES: RouteDef[] = [
  {
    originAsset: "nep141:wrap.near",
    destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  },
  {
    originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    destinationAsset: "nep141:wrap.near",
  },
  {
    originAsset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    destinationAsset: "nep141:wrap.near",
  },
  {
    originAsset: "nep141:wrap.near",
    destinationAsset: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  },
  {
    originAsset: "nep141:eth.omft.near",
    destinationAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  },
  {
    originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    destinationAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  },
  {
    originAsset: "nep141:sol.omft.near",
    destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  },
  {
    originAsset: "nep141:btc.omft.near",
    destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  },
  {
    originAsset: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    destinationAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
  },
  {
    originAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    destinationAsset: "nep141:eth.omft.near",
  },
];

export interface TokenInfo {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number | null;
}

export interface PlannedSlot {
  key: string;
  routeId: string;
  originAsset: string;
  destinationAsset: string;
  originChain: string;
  destinationChain: string;
  notionalUsd: number;
  privacyMode: PrivacyMode;
  /** Present when the slot can be attempted. */
  amountBaseUnits: string | null;
  destDecimals: number | null;
  /** Present when the slot cannot be attempted: recorded as `unavailable`, never silently dropped. */
  unavailableReason: string | null;
}

/** USD notional -> origin base units: floor(usd * 10^decimals / price), price scaled to 1e8 (grid sizing only; the amount sent is recorded). */
export function notionalBaseUnits(usd: number, decimals: number, price: number): string | null {
  if (!(price > 0) || !Number.isFinite(price) || !Number.isInteger(decimals) || decimals < 0) return null;
  const scaledPrice = BigInt(Math.round(price * 1e8));
  if (scaledPrice <= 0n) return null;
  const amount = (BigInt(usd) * 10n ** BigInt(decimals) * 100_000_000n) / scaledPrice;
  return amount > 0n ? amount.toString() : null;
}

export const routeIdOf = (o: TokenInfo | null, d: TokenInfo | null, r: RouteDef): string =>
  `${o ? `${o.symbol}.${o.blockchain}` : r.originAsset}>${d ? `${d.symbol}.${d.blockchain}` : r.destinationAsset}`;

/**
 * The full grid for one round, deterministic order. `hasAddress(kind, chain)` says whether recipient/refund config exists.
 * `limit` > 0 keeps the first N attemptable slots (used by the bounded live check), spread across routes.
 */
export function planQuoteGrid(d: {
  routes: RouteDef[];
  tokens: Map<string, TokenInfo>;
  notionalsUsd: number[];
  modes: PrivacyMode[];
  hasAddress: (kind: "recipient" | "refund", chain: string) => boolean;
}): PlannedSlot[] {
  const out: PlannedSlot[] = [];
  for (const r of d.routes) {
    const o = d.tokens.get(r.originAsset) ?? null;
    const t = d.tokens.get(r.destinationAsset) ?? null;
    const routeId = routeIdOf(o, t, r);
    for (const usd of d.notionalsUsd) {
      for (const mode of d.modes) {
        let amount: string | null = null;
        let reason: string | null = null;
        if (!o || !t) reason = "ASSET_NOT_LISTED";
        else if (!d.hasAddress("refund", o.blockchain)) reason = `NO_REFUND_ADDRESS_CONFIG:${o.blockchain}`;
        else if (!d.hasAddress("recipient", t.blockchain))
          reason = `NO_RECIPIENT_ADDRESS_CONFIG:${t.blockchain}`;
        else {
          amount = notionalBaseUnits(usd, o.decimals, o.price ?? 0);
          if (amount === null) reason = "NO_PRICE_REFERENCE";
        }
        out.push({
          key: `${routeId}|${usd}|${mode}`,
          routeId,
          originAsset: r.originAsset,
          destinationAsset: r.destinationAsset,
          originChain: o?.blockchain ?? "unknown",
          destinationChain: t?.blockchain ?? "unknown",
          notionalUsd: usd,
          privacyMode: mode,
          amountBaseUnits: amount,
          destDecimals: t?.decimals ?? null,
          unavailableReason: reason,
        });
      }
    }
  }
  return out;
}

/** First `limit` attemptable slots, taking one per route first so a small subset still covers several routes. */
export function limitSlots(slots: PlannedSlot[], limit: number): PlannedSlot[] {
  if (limit <= 0) return slots;
  const attemptable = slots.filter((s) => s.unavailableReason === null);
  const byRoute = new Map<string, PlannedSlot[]>();
  for (const s of attemptable) byRoute.set(s.routeId, [...(byRoute.get(s.routeId) ?? []), s]);
  const picked: PlannedSlot[] = [];
  for (let i = 0; picked.length < limit; i++) {
    let any = false;
    for (const list of byRoute.values()) {
      const s = list[i];
      if (s && picked.length < limit) {
        picked.push(s);
        any = true;
      }
    }
    if (!any) break;
  }
  const keep = new Set(picked.map((s) => s.key));
  return slots.filter((s) => keep.has(s.key));
}

export { DAY_MS };
