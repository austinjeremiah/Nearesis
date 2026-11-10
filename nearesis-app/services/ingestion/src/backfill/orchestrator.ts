import type { ClickHouseClient } from "@clickhouse/client";
import { BudgetLedger } from "./budget.ts";
import type { BudgetedBigQuery, ChunkOutcome } from "./bq-runner.ts";
import { coverageRows, insertLive, receiverRows, transactionRows, bqScalar, type Row } from "./ch.ts";
import { addDays, quotaDayStart, type Chunk } from "./plan.ts";
import type { StateStore } from "./state.ts";

type Done = Extract<ChunkOutcome, { status: "done" }>;

/** Loads one finished chunk and returns the number of fact rows written. Must be idempotent (ReplacingMergeTree). */
export type ChunkSink = (chunk: Chunk, outcome: Done) => Promise<number>;

export interface BqPhaseResult {
  completed: string[];
  skippedForBudget: Array<{ id: string; estimateBytes: number }>;
  remaining: string[];
  stopReason: "all_chunks_done" | "daily_budget";
}

export function chunkDays(c: Pick<Chunk, "from" | "to">): string[] {
  const out: string[] = [];
  for (let d = c.from; d < c.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Days of the chunk with no result row are gaps (never zero rows): NEAR has transactions every day. */
export function coverageForChunk(
  chunk: Chunk,
  presentDays: Set<string>,
  version: number,
): { coverage: Row[]; gaps: Row[] } {
  const dataset = chunk.family === "transactions" ? "near_daily_tx" : "contract_interactions";
  const coverage = coverageRows(
    chunkDays(chunk).map((day) => ({
      provider_id: "near-bigquery",
      dataset,
      day,
      state: presentDays.has(day) ? ("complete" as const) : ("unavailable" as const),
      reason: presentDays.has(day) ? null : "PROVIDER_GAP",
      version,
    })),
  );
  const gaps: Row[] = chunkDays(chunk)
    .filter((d) => !presentDays.has(d))
    .map((day) => ({
      provider_id: "near-bigquery",
      dataset,
      from_utc: `${day}T00:00:00.000Z`,
      to_utc: `${day}T23:59:59.999Z`,
      state: "unavailable",
      reason_code: "PROVIDER_GAP",
      source_label: "LIVE",
      version,
    }));
  return { coverage, gaps };
}

export function makeChSink(ch: ClickHouseClient): ChunkSink {
  return async (chunk, o) => {
    const p = { rawObjectHash: o.objectHash, fetchedAtUTC: o.fetchedAtUTC };
    const present = new Set(o.rows.map((r) => bqScalar(r.block_date, "block_date").slice(0, 10)));
    let n = 0;
    if (chunk.family === "transactions") {
      n += await insertLive(ch, "near_daily_tx", transactionRows(o.rows, p));
    } else {
      const { named, below } = receiverRows(o.rows, p);
      n += await insertLive(ch, "contract_interactions", named);
      n += await insertLive(ch, "contract_interactions_below_threshold", below);
    }
    const { coverage, gaps } = coverageForChunk(chunk, present, Date.parse(o.fetchedAtUTC));
    await insertLive(ch, "source_coverage", coverage);
    await insertLive(ch, "quality_gaps", gaps);
    return n;
  };
}

export interface BqPhaseDeps {
  runner: BudgetedBigQuery;
  store: StateStore;
  ledger: BudgetLedger;
  location: string;
  sink: ChunkSink;
  chunks: Chunk[];
  nowMs: () => number;
  log?: (msg: string) => void;
}

/**
 * Runs pending chunks in plan order. A chunk whose dry-run estimate does not fit today's remaining budget is skipped (a
 * smaller later chunk may still fit); the phase ends when nothing pending fits. Each finished chunk is loaded then checkpointed.
 */
export async function runBigQueryPhase(d: BqPhaseDeps): Promise<BqPhaseResult> {
  const log = d.log ?? (() => undefined);
  const completed: string[] = [];
  const skipped: BqPhaseResult["skippedForBudget"] = [];
  for (const chunk of d.chunks) {
    if (d.store.isDone(chunk.id)) continue;
    const o = await d.runner.runChunk(chunk, d.ledger, d.location);
    if (o.status === "budget") {
      skipped.push({ id: chunk.id, estimateBytes: o.estimateBytes });
      log(`skip ${chunk.id}: est ${o.estimateBytes} B, remaining ${o.remaining} B`);
      continue;
    }
    const rows = await d.sink(chunk, o);
    d.store.markDone({
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
      quotaDay: quotaDayStart(d.nowMs()).toISOString().slice(0, 10),
    });
    completed.push(chunk.id);
    log(`done ${chunk.id}: ${rows} rows, billed ${o.billedBytes} B, today ${d.ledger.billedToday} B`);
  }
  const remaining = d.chunks.filter((c) => !d.store.isDone(c.id)).map((c) => c.id);
  return {
    completed,
    skippedForBudget: skipped,
    remaining,
    stopReason: remaining.length === 0 ? "all_chunks_done" : "daily_budget",
  };
}
