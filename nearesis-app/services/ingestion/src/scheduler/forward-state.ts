import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ForwardEntry {
  /** `billed`: the job ran and its raw rows are archived but not yet loaded (a restart reloads from the archive, never re-bills). */
  status: "billed" | "loaded" | "not_applicable" | "refused";
  kind: string;
  day: string;
  estimateBytes: number | null;
  billedBytes: number | null;
  jobId: string | null;
  rawObjectHash: string | null;
  rows: number | null;
  completedAtUTC: string;
  quotaDay: string | null;
  /** Why a job did not bill: PRIVATE_ERA, OVER_JOB_CEILING, ... */
  reason: string | null;
}

/** Checkpoint of the forward daily BigQuery jobs (atomic write). An id with an entry is never billed a second time. */
export class ForwardStateStore {
  entries: Record<string, ForwardEntry> = {};
  constructor(readonly path: string) {
    try {
      this.entries =
        (JSON.parse(readFileSync(path, "utf8")) as { entries?: Record<string, ForwardEntry> }).entries ?? {};
    } catch {
      this.entries = {};
    }
  }
  get(id: string): ForwardEntry | undefined {
    return this.entries[id];
  }
  /** Terminal for scheduling: loaded, not applicable or refused (a refused job is not retried with other parameters). */
  isSettled(id: string): boolean {
    const s = this.entries[id]?.status;
    return s === "loaded" || s === "not_applicable" || s === "refused";
  }
  put(id: string, e: ForwardEntry): void {
    this.entries[id] = e;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: this.entries }, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
