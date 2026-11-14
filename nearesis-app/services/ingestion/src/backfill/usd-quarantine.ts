import { createHash } from "node:crypto";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Db } from "../db.ts";
import { insertLive } from "./ch.ts";
import { EXPLORER_DATASET, EXPLORER_PROVIDER } from "./explorer-coverage.ts";

/**
 * Quarantine rule for provider-stated USD values of Explorer swaps (never a silent drop, never a cap).
 *
 * RULE `USD_IMPLAUSIBLE`: a swap whose provider-stated `amount_in_usd` or `amount_out_usd` exceeds USD 1,000,000,000 is
 * quarantined. The swap row stays in `intents_swaps` untouched (counts, status and raw amounts are not altered); what is
 * excluded is its USD value from any USD volume metric that applies the rule, and each such swap is recorded as a `partial`
 * quality gap (reason `USD_IMPLAUSIBLE:<hash prefix>`) so every response that covers it reports the gap.
 *
 * Why this rule and this threshold (evidence from the 5.0M loaded swaps, 2026-11-12): the largest SUCCESS swap is USD 3.09M and
 * the 99.999th percentile is USD 1.4M; the only values above USD 1e7 are four REFUNDED swaps carrying USD 1.9e10, 3.0e13 and 6.7e16
 * (two BTC "swaps" of 1e12 BTC and one USDC "swap" of 3e13 USDC: amounts far beyond circulating supply). The provider USD value is
 * consistent with its own (absurd) token amount, so a USD-versus-amount x price check cannot catch them; a magnitude bound can.
 * USD 1e9 is 300x the largest settled swap and below every observed absurd value. Revisit with evidence, never to fit a result.
 */
export const USD_IMPLAUSIBLE_REASON = "USD_IMPLAUSIBLE";
export const USD_IMPLAUSIBLE_THRESHOLD_USD = 1_000_000_000;

export interface ImplausibleSwap {
  swapKey: string;
  createdAt: string;
  status: string;
  amountInUsd: string | null;
  amountOutUsd: string | null;
}

/** The gap reason for a swap; the swap key (a deposit address) is hashed, never stored in a gap. */
export const usdImplausibleCode = (swapKey: string): string =>
  `${USD_IMPLAUSIBLE_REASON}:${createHash("sha256").update(swapKey).digest("hex").slice(0, 16)}`;

export async function findImplausibleUsdSwaps(
  ch: ClickHouseClient,
  thresholdUsd: number = USD_IMPLAUSIBLE_THRESHOLD_USD,
): Promise<ImplausibleSwap[]> {
  const rows = (await (
    await ch.query({
      query: `SELECT swap_key, formatDateTime(created_at, '%Y-%m-%dT%H:%i:%S', 'UTC') || '.' || lpad(toString(toUnixTimestamp64Milli(created_at) % 1000), 3, '0') || 'Z' AS created,
                     status, toString(amount_in_usd) AS in_usd, toString(amount_out_usd) AS out_usd
                FROM intents_swaps FINAL
               WHERE amount_in_usd > {t:UInt64} OR amount_out_usd > {t:UInt64}
               ORDER BY created_at`,
      query_params: { t: thresholdUsd },
      format: "JSONEachRow",
    })
  ).json()) as Array<{
    swap_key: string;
    created: string;
    status: string;
    in_usd: string | null;
    out_usd: string | null;
  }>;
  return rows.map((r) => ({
    swapKey: r.swap_key,
    createdAt: r.created,
    status: r.status,
    amountInUsd: r.in_usd,
    amountOutUsd: r.out_usd,
  }));
}

/** Records each quarantined swap as a `partial` quality gap (ClickHouse + Postgres). Idempotent. Returns the count. */
export async function recordUsdQuarantine(
  db: Pick<Db, "query">,
  ch: ClickHouseClient,
  swaps: ImplausibleSwap[],
  version: number = Date.now(),
): Promise<number> {
  for (const s of swaps) {
    const from = s.createdAt;
    const to = new Date(Date.parse(from) + 1).toISOString();
    const code = usdImplausibleCode(s.swapKey);
    await insertLive(ch, "quality_gaps", [
      {
        provider_id: EXPLORER_PROVIDER,
        dataset: EXPLORER_DATASET,
        from_utc: from,
        to_utc: to,
        state: "partial",
        reason_code: code,
        source_label: "LIVE",
        version,
      },
    ]);
    await db.query(
      `INSERT INTO ingestion.quality_gaps(provider_id, dataset, from_utc, to_utc, state, reason_code)
       SELECT $1, $2, $3, $4, 'partial', $5
        WHERE NOT EXISTS (SELECT 1 FROM ingestion.quality_gaps WHERE provider_id = $1 AND dataset = $2 AND reason_code = $5)`,
      [EXPLORER_PROVIDER, EXPLORER_DATASET, from, to, code],
    );
  }
  return swaps.length;
}
