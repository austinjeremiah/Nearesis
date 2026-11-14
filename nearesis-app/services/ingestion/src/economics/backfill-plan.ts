import { addDays } from "../backfill/plan.ts";
import type { EconomicsChunk, EconomicsFamily } from "./sql.ts";
import { ECONOMICS_FAMILIES } from "./sql.ts";

/** Approved 90-day backfill window (owner 2026-11-13): 2026-08-12..2026-11-09 minus the seven pilot days 2026-11-03..09. */
const dayEnv = (name: string, fallback: string): string =>
  /^\d{4}-\d{2}-\d{2}$/.test(process.env[name] ?? "") ? (process.env[name] as string) : fallback;
/** NEARESIS_ECON_FROM / NEARESIS_ECON_TO_EXCLUSIVE extend the window to later days (a new plan with its own digest). */
export const BACKFILL_FROM = dayEnv("NEARESIS_ECON_FROM", "2026-08-12");
export const BACKFILL_TO_EXCLUSIVE = dayEnv("NEARESIS_ECON_TO_EXCLUSIVE", "2026-11-03");
/** Owner approval bound: 21 GiB of dry-run bytes for the whole plan. */
export const BACKFILL_APPROVED_MAX_BYTES = 22_548_578_304;

/** One chunk per (day, family), newest day first, so the most valuable days load first if the quota defers the rest. */
export function planBackfillChunks(
  from = BACKFILL_FROM,
  toExclusive = BACKFILL_TO_EXCLUSIVE,
  families: readonly EconomicsFamily[] = ECONOMICS_FAMILIES,
): EconomicsChunk[] {
  const days: string[] = [];
  for (let d = from; d < toExclusive; d = addDays(d, 1)) days.push(d);
  days.reverse();
  return days.flatMap((d) =>
    families.map((family) => ({ id: `${family}:${d}`, family, from: d, to: addDays(d, 1) })),
  );
}
