import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Chunk } from "./plan.ts";

export interface ChunkDone {
  id: string;
  family: Chunk["family"];
  from: string;
  to: string;
  rows: number;
  estimateBytes: number;
  billedBytes: number;
  jobId: string | null;
  rawObjectHash: string;
  completedAtUTC: string;
  quotaDay: string; // YYYY-MM-DD of the quota-day start in UTC
}

export interface BackfillState {
  version: 1;
  window: { from: string; to: string };
  discovery: { billingProject: string; datasetLocation: string; credentialPrincipal: string | null } | null;
  chunks: Record<string, ChunkDone>;
  /** bytes billed by this backfill per quota day (informational; the budget uses INFORMATION_SCHEMA) */
  billedByQuotaDay: Record<string, number>;
  explorer: {
    requests: number;
    pagesCommitted: number;
    swapsInserted: number;
    sessions: number;
    lastStatus: string | null;
    complete?: boolean;
    lastError?: string | null;
    lastStatusAtUTC?: string;
  };
  explorerLoad?: { afterVersionMs: number; afterKey: string };
  price: { done: boolean; requests: number; days: number } | null;
}

export const emptyState = (from: string, to: string): BackfillState => ({
  version: 1,
  window: { from, to },
  discovery: null,
  chunks: {},
  billedByQuotaDay: {},
  explorer: { requests: 0, pagesCommitted: 0, swapsInserted: 0, sessions: 0, lastStatus: null },
  price: null,
});

/**
 * Local checkpoint file (atomic write: temp + rename). Several phases may run as separate processes, so save() merges:
 * a section this process changed wins, a section it did not touch keeps whatever another process wrote; chunks are unioned.
 */
export class StateStore {
  state: BackfillState;
  private baseline: BackfillState;
  constructor(
    readonly path: string,
    from: string,
    to: string,
  ) {
    this.state = this.readDisk() ?? emptyState(from, to);
    this.baseline = structuredClone(this.state);
  }
  private readDisk(): BackfillState | null {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as BackfillState;
    } catch {
      return null;
    }
  }
  save(): void {
    const disk = this.readDisk();
    if (disk) {
      const merged = { ...disk } as Record<string, unknown>;
      for (const k of Object.keys(this.state) as Array<keyof BackfillState>) {
        if (JSON.stringify(this.state[k]) !== JSON.stringify(this.baseline[k])) merged[k] = this.state[k];
      }
      merged.chunks = { ...disk.chunks, ...this.state.chunks };
      this.state = merged as unknown as BackfillState;
    }
    // informational per-quota-day totals are always derived from the checkpointed chunks
    const byDay: Record<string, number> = {};
    for (const c of Object.values(this.state.chunks))
      byDay[c.quotaDay] = (byDay[c.quotaDay] ?? 0) + c.billedBytes;
    this.state.billedByQuotaDay = byDay;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(tmp, this.path);
    this.baseline = structuredClone(this.state);
  }
  isDone(id: string): boolean {
    return this.state.chunks[id] !== undefined;
  }
  markDone(c: ChunkDone): void {
    this.state.chunks[c.id] = c;
    this.save();
  }
}
