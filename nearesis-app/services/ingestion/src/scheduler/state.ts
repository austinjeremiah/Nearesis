import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskName } from "./config.ts";

export interface TaskStatus {
  lastRunAtMs: number | null;
  lastOkAtMs: number | null;
  lastError: string | null;
  failures: number;
  nextAttemptAtMs: number;
}

export interface SchedulerState {
  version: 1;
  tasks: Record<TaskName, TaskStatus>;
  /** BigQuery days whose result was empty so far (provider lag): count and last attempt. */
  bqEmpty: Record<string, { count: number; lastAtMs: number }>;
  price: {
    doneDays: string[];
    gapDays: string[];
    attempts: Record<string, number>;
    requests: number;
  };
  explorer: {
    /** End (exclusive, epoch ms) of the last fully collected forward window. Null before the first window completes. */
    watermarkMs: number | null;
    inflight: { startUnix: number; endUnix: number; streamKey: string } | null;
    gapRecordedFor: string | null;
    requests: number;
    swapsInserted: number;
    lastFullScanAtMs: number | null;
  };
  quotes: {
    /** Bucket whose round is in progress, and the last bucket whose round finished. */
    bucketMs: number | null;
    completedBucketMs: number | null;
    slotsDone: string[];
    roundsCompleted: number;
    attempts: number;
    lastAttemptAtMs: number | null;
    lastOkAtMs: number | null;
  };
}

const task = (): TaskStatus => ({
  lastRunAtMs: null,
  lastOkAtMs: null,
  lastError: null,
  failures: 0,
  nextAttemptAtMs: 0,
});

export const emptySchedulerState = (): SchedulerState => ({
  version: 1,
  tasks: { bq: task(), price: task(), explorer: task(), quotes: task(), forward: task() },
  bqEmpty: {},
  price: { doneDays: [], gapDays: [], attempts: {}, requests: 0 },
  explorer: {
    watermarkMs: null,
    inflight: null,
    gapRecordedFor: null,
    requests: 0,
    swapsInserted: 0,
    lastFullScanAtMs: null,
  },
  quotes: {
    bucketMs: null,
    completedBucketMs: null,
    slotsDone: [],
    roundsCompleted: 0,
    attempts: 0,
    lastAttemptAtMs: null,
    lastOkAtMs: null,
  },
});

/** The scheduler's own checkpoint (atomic temp + rename). Never the backfill's state file. */
export class SchedulerStateStore {
  state: SchedulerState;
  constructor(readonly path: string) {
    this.state = this.read() ?? emptySchedulerState();
  }
  private read(): SchedulerState | null {
    try {
      const j = JSON.parse(readFileSync(this.path, "utf8")) as SchedulerState;
      const e = emptySchedulerState();
      return { ...e, ...j, tasks: { ...e.tasks, ...j.tasks } };
    } catch {
      return null;
    }
  }
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
