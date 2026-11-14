import { createHash } from "node:crypto";

/**
 * One question, identical inputs, consistent numbers across agents (ch.15 P10, ch.16b B12). Every child is dispatched
 * with the same context; a child handed a different snapshot is rejected at dispatch.
 */
export interface DispatchContext {
  question: string;
  snapshotId: string;
  metricVersionMap: Record<string, string>;
  preregistrationHash: string;
}
export const h = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const contextHashes = (c: DispatchContext) => ({
  question: h(c.question),
  snapshotId: c.snapshotId,
  metricVersionMap: h(
    Object.fromEntries(Object.entries(c.metricVersionMap).sort(([a], [b]) => (a < b ? -1 : 1))),
  ),
  preregistrationHash: c.preregistrationHash,
});

export class SnapshotMismatch extends Error {
  readonly reason_code = "snapshot_mismatch";
}

export type ContextHashes = ReturnType<typeof contextHashes>;

/**
 * The single enforcement rule behind both the in-memory `Dispatcher` and the runtime's real dispatch path
 * (`spawnTask`): a child's four hashes (question, snapshot, metric-version map, preregistration) must equal the run's
 * frozen context exactly. Returns the differing fields; empty means the child may run.
 */
export function contextDifferences(run: ContextHashes, child: Partial<ContextHashes> | undefined): string[] {
  if (!child) return ["question", "snapshotId", "metricVersionMap", "preregistrationHash"];
  const keys = ["question", "snapshotId", "metricVersionMap", "preregistrationHash"] as const;
  return keys.filter((k) => child[k] !== run[k]);
}

export class Dispatcher {
  readonly dispatched: Array<{ child: string; hashes: ReturnType<typeof contextHashes>; accepted: boolean }> =
    [];
  constructor(private readonly ctx: DispatchContext) {}
  /** Hands a child its context. A child that asks for a different snapshot is refused and recorded. */
  dispatch(child: string, requested?: Partial<DispatchContext>): ReturnType<typeof contextHashes> {
    const ctx = { ...this.ctx, ...requested };
    const hashes = contextHashes(ctx);
    const want = contextHashes(this.ctx);
    const accepted = contextDifferences(want, hashes).length === 0;
    this.dispatched.push({ child, hashes, accepted });
    if (!accepted) throw new SnapshotMismatch(`${child}: context differs from the run's frozen context`);
    return hashes;
  }
}

export interface Headline {
  source: string;
  metric: string;
  value: string;
  kind: "count" | "derived";
  snapshotId: string;
}
export interface Conflict {
  metric: string;
  values: Array<{ source: string; value: string }>;
  tolerance: number;
}

/** Cross-artifact agreement. Counts must be equal; derived values within `tolerance` (relative). Disagreement becomes a conflict record. */
export function reconcile(headlines: Headline[], expectedSnapshot: string, tolerance = 1e-6) {
  const included = headlines.filter((x) => x.snapshotId === expectedSnapshot);
  const excluded = headlines
    .filter((x) => x.snapshotId !== expectedSnapshot)
    .map((x) => ({ ...x, flag: "snapshot_mismatch" as const }));
  const conflicts: Conflict[] = [];
  const metrics = [...new Set(included.map((x) => x.metric))];
  for (const m of metrics) {
    const vs = included.filter((x) => x.metric === m);
    const first = vs[0]!;
    const agree = vs.every((x) => {
      if (first.kind === "count") return x.value === first.value;
      const a = Number(first.value);
      const b = Number(x.value);
      return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a));
    });
    if (!agree)
      conflicts.push({ metric: m, values: vs.map((x) => ({ source: x.source, value: x.value })), tolerance });
  }
  return { included, excluded, conflicts };
}
