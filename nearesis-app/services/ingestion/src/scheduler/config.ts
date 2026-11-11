import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialSource } from "../http/credentials.ts";
import { APP_ROOT } from "../backfill/env.ts";
import { fixtureAddress } from "./fixture-addresses.ts";

export const SCHEDULER_DIR = join(APP_ROOT, ".data", "scheduler");
export const SCHEDULER_STATE_PATH = join(SCHEDULER_DIR, "state.json");
export const SCHEDULER_BQ_STATE_PATH = join(SCHEDULER_DIR, "bq-state.json");
export const SCHEDULER_ACCOUNT_STATE_PATH = join(SCHEDULER_DIR, "account-state.json");
export const SCHEDULER_LOAD_STATE_PATH = join(SCHEDULER_DIR, "explorer-load.json");
export const SCHEDULER_RAW_DIR = join(SCHEDULER_DIR, "raw");
export const SCHEDULER_CONTROL_PATH = join(SCHEDULER_DIR, "control.json");
export const SCHEDULER_LEASE_KEY = "ingestion:lease:scheduler";

/** First day the scheduler owns: the backfill window ends 2026-11-09 (ADR-20261110-005). */
export const FORWARD_FROM_DAY = "2026-11-10";

export const PRIVACY_MODES = ["public", "basic", "advanced"] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];
export type TaskName = "bq" | "price" | "explorer" | "quotes";
export const ALL_TASKS: readonly TaskName[] = ["bq", "price", "explorer", "quotes"];

export interface SchedulerConfig {
  tickMs: number;
  /** BigQuery and price daily tasks start this long after UTC midnight. */
  dailyDelayMs: number;
  /** Cap on days (each is 2 BigQuery queries) processed per BigQuery run. */
  bqMaxDaysPerRun: number;
  /** A day with no BigQuery rows is retried this many times (provider lag) before it is recorded as a gap. */
  emptyDayRetries: number;
  emptyDayRetrySpacingMs: number;
  priceAttemptsBeforeGap: number;
  explorerIntervalMs: number;
  /** Re-fetch this much before the forward watermark so late status changes of recent swaps are applied. */
  explorerOverlapMs: number;
  explorerMaxPagesPerTick: number;
  quoteIntervalMs: number;
  quotePaceMs: number;
  quoteNotionalsUsd: number[];
  quotePrivacyModes: PrivacyMode[];
  /** Hard cap on quotes per round (the live check uses a small value). 0 = the whole grid. */
  quoteLimit: number;
}

const num = (v: string | undefined, d: number): number => {
  const n = v === undefined || v === "" ? Number.NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  const modes = (env.NEARESIS_QUOTE_MODES ?? PRIVACY_MODES.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is PrivacyMode => (PRIVACY_MODES as readonly string[]).includes(s));
  const notionals = (env.NEARESIS_QUOTE_NOTIONALS_USD ?? "10,100,1000,10000")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return {
    tickMs: num(env.NEARESIS_SCHED_TICK_MS, 60_000),
    dailyDelayMs: num(env.NEARESIS_SCHED_DAILY_DELAY_MS, 2 * 3_600_000),
    bqMaxDaysPerRun: num(env.NEARESIS_SCHED_BQ_MAX_DAYS, 3),
    emptyDayRetries: 4,
    emptyDayRetrySpacingMs: 6 * 3_600_000,
    priceAttemptsBeforeGap: 3,
    explorerIntervalMs: num(env.NEARESIS_SCHED_EXPLORER_INTERVAL_MS, 3_600_000),
    explorerOverlapMs: num(env.NEARESIS_SCHED_EXPLORER_OVERLAP_MS, 2 * 3_600_000),
    explorerMaxPagesPerTick: num(env.NEARESIS_SCHED_EXPLORER_MAX_PAGES, 40),
    quoteIntervalMs: num(env.NEARESIS_QUOTE_INTERVAL_MS, 3_600_000),
    quotePaceMs: num(env.NEARESIS_QUOTE_PACE_MS, 1500),
    quoteNotionalsUsd: notionals.length ? notionals : [10, 100, 1000, 10000],
    quotePrivacyModes: modes.length ? modes : [...PRIVACY_MODES],
    quoteLimit: num(env.NEARESIS_QUOTE_LIMIT, 0),
  };
}

/**
 * Recipient / refund addresses per chain come from configuration (env or .env), never from a wallet or a key.
 * NEARESIS_QUOTE_RECIPIENT_<CHAIN> / NEARESIS_QUOTE_REFUND_<CHAIN>, or NEARESIS_QUOTE_ADDRESS_<CHAIN> for both; otherwise the
 * committed `config/quote-fixture-addresses.json` (label "quote-only fixture, non-owned"); chains without one are unavailable.
 */
export function quoteAddress(
  creds: Pick<CredentialSource, "get" | "has">,
  kind: "recipient" | "refund",
  chain: string,
): string | null {
  const c = chain.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  for (const name of [`NEARESIS_QUOTE_${kind.toUpperCase()}_${c}`, `NEARESIS_QUOTE_ADDRESS_${c}`])
    if (creds.has(name)) return creds.get(name) ?? null;
  // Committed, documented quote-only fixtures (non-owned) cover the chains that have an official public example.
  return fixtureAddress(chain);
}

const TRUE = /^(1|true|yes|on)$/i;

/**
 * Loop-mode switch for the quote sampler. Default OFF. Enabled by NEARESIS_QUOTE_ENABLED=1 or, without a restart, by
 * `{"quotesEnabled": true}` in .data/scheduler/control.json (re-read every tick; the file wins when it sets the flag).
 * `--once --force --only quotes` is an explicit operator action and does not consult this switch.
 */
export function quotesEnabled(
  env: NodeJS.ProcessEnv = process.env,
  controlPath: string = SCHEDULER_CONTROL_PATH,
): boolean {
  try {
    if (existsSync(controlPath)) {
      const j = JSON.parse(readFileSync(controlPath, "utf8")) as { quotesEnabled?: unknown };
      if (typeof j.quotesEnabled === "boolean") return j.quotesEnabled;
    }
  } catch {
    // unreadable control file: fall back to the environment (default off)
  }
  return TRUE.test(env.NEARESIS_QUOTE_ENABLED ?? "");
}
