import { IngestionError } from "../errors.ts";

export const WINDOW_FROM = "2025-11-10";
export const WINDOW_TO = "2026-11-09"; // inclusive; 365 days
export type QueryFamily = "transactions" | "receivers";
export const FAMILIES: readonly QueryFamily[] = ["transactions", "receivers"];

/** Receiver-day interactions below this are folded into contract_interactions_below_threshold (exact totals kept). */
export const RECEIVER_THRESHOLD = 100;

export interface Chunk {
  id: string; // `${family}:${from}`
  family: QueryFamily;
  from: string; // inclusive YYYY-MM-DD
  to: string; // exclusive YYYY-MM-DD
}

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ms = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  return iso(ms(day) + n * DAY_MS);
}

/** Calendar-month chunks covering [from, to] inclusive. First/last chunks may be partial months. */
export function monthRanges(from: string, to: string): Array<{ from: string; to: string }> {
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to)
    throw new IngestionError("INVALID_INPUT", false, { reason: "bad window" });
  const out: Array<{ from: string; to: string }> = [];
  const end = addDays(to, 1); // exclusive
  let cur = from;
  while (cur < end) {
    const d = new Date(ms(cur));
    const nextMonth = iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const upper = nextMonth < end ? nextMonth : end;
    out.push({ from: cur, to: upper });
    cur = upper;
  }
  return out;
}

/** Newest month first: recent data is the most valuable if the budget runs out. Transactions are planned before receivers. */
export function planChunks(from = WINDOW_FROM, to = WINDOW_TO): Chunk[] {
  const months = monthRanges(from, to).reverse();
  const out: Chunk[] = [];
  for (const family of FAMILIES)
    for (const m of months) out.push({ id: `${family}:${m.from}`, family, from: m.from, to: m.to });
  return out;
}

/** The quota day starts at midnight Pacific = 08:00 UTC (project convention in ADR-20261110-005). */
export function quotaDayStart(nowMs: number): Date {
  const d = new Date(nowMs);
  const today8 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8);
  return new Date(today8 <= nowMs ? today8 : today8 - DAY_MS);
}

export const nextQuotaReset = (nowMs: number): Date => new Date(quotaDayStart(nowMs).getTime() + DAY_MS);
