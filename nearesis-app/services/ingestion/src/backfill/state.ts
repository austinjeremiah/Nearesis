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

/** Local checkpoint file (atomic write: temp + rename). */
export class StateStore {
  state: BackfillState;
  constructor(
    readonly path: string,
    from: string,
    to: string,
  ) {
    try {
      this.state = JSON.parse(readFileSync(path, "utf8")) as BackfillState;
    } catch {
      this.state = emptyState(from, to);
    }
  }
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
  isDone(id: string): boolean {
    return this.state.chunks[id] !== undefined;
  }
  markDone(c: ChunkDone): void {
    this.state.chunks[c.id] = c;
    this.state.billedByQuotaDay[c.quotaDay] = (this.state.billedByQuotaDay[c.quotaDay] ?? 0) + c.billedBytes;
    this.save();
  }
}
