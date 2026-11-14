import {
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  MIN_ZSCORE_SAMPLES,
  conditionShape,
} from "@nearesis/contracts";
import type { Condition } from "@nearesis/contracts";
import { KernelError } from "../errors.ts";

/** Bounds beyond the schema: a rule's AST is small by construction. */
export function assertConditionBounds(c: Condition): void {
  const s = conditionShape(c);
  if (s.depth > MAX_CONDITION_DEPTH || s.nodes > MAX_CONDITION_NODES)
    throw new KernelError(
      "VALIDATION_FAILED",
      "CONDITION_TOO_COMPLEX",
      "Condition is too deep or too large.",
      {
        details: [
          { path: "condition", issue: `depth<=${MAX_CONDITION_DEPTH}, nodes<=${MAX_CONDITION_NODES}` },
        ],
      },
    );
}

const CMP = {
  gt: (a: number, b: number) => a > b,
  gte: (a: number, b: number) => a >= b,
  lt: (a: number, b: number) => a < b,
  lte: (a: number, b: number) => a <= b,
  eq: (a: number, b: number) => a === b,
  ne: (a: number, b: number) => a !== b,
} as const;

export interface ZscoreStat {
  z: number | null;
  mean: number | null;
  sd: number | null;
  n: number;
  absoluteGt: number;
}
/** Optional inputs for conditions that need history. `stats` is filled with the computed statistics (evidence). */
export interface EvalContext {
  /** Previous finalized observations of `metricId` inside the window, oldest first. */
  history?: (metricId: string, windowDays: number) => readonly number[];
  stats?: Record<string, ZscoreStat>;
}

/** Sample z-score (n-1). Null when there is too little history or no variance: unknown, never zero. */
export function zscore(
  x: number,
  history: readonly number[],
): { z: number | null; mean: number | null; sd: number | null } {
  const n = history.length;
  if (n < MIN_ZSCORE_SAMPLES) return { z: null, mean: null, sd: null };
  const mean = history.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(history.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  if (!(sd > 0)) return { z: null, mean, sd };
  return { z: (x - mean) / sd, mean, sd };
}

/** Every metric id a condition reads (for catalog validation). */
export function conditionMetrics(c: Condition): string[] {
  if (c.kind === "compare" || c.kind === "zscore") return [c.metricId];
  return (c.kind === "not" ? [c.term] : c.terms).flatMap(conditionMetrics);
}

export function conditionHasHistory(c: Condition): boolean {
  if (c.kind === "zscore") return true;
  if (c.kind === "compare") return false;
  return (c.kind === "not" ? [c.term] : c.terms).some(conditionHasHistory);
}

/**
 * Three-valued, deterministic evaluation. A metric with no observation is `null` (unknown): unknown never satisfies a
 * comparison and never coerces to zero. `not(unknown)` is unknown; `and` is false if any term is false, else unknown if
 * any is unknown; `or` is true if any term is true, else unknown if any is unknown. Only `true` fires a rule.
 */
export function evaluateCondition(
  c: Condition,
  values: Readonly<Record<string, number>>,
  ctx: EvalContext = {},
): boolean | null {
  switch (c.kind) {
    case "compare": {
      const v = Object.hasOwn(values, c.metricId) ? values[c.metricId] : undefined;
      if (v === undefined || !Number.isFinite(v)) return null;
      return CMP[c.op](v, c.value);
    }
    case "zscore": {
      const v = Object.hasOwn(values, c.metricId) ? values[c.metricId] : undefined;
      if (v === undefined || !Number.isFinite(v) || !ctx.history) return null;
      const h = ctx.history(c.metricId, c.windowDays);
      const r = zscore(v, h);
      if (ctx.stats) ctx.stats[c.metricId] = { ...r, n: h.length, absoluteGt: c.absoluteGt };
      return r.z === null ? null : Math.abs(r.z) > c.absoluteGt;
    }
    case "not": {
      const r = evaluateCondition(c.term, values, ctx);
      return r === null ? null : !r;
    }
    case "and": {
      const rs = c.terms.map((t) => evaluateCondition(t, values, ctx));
      if (rs.includes(false)) return false;
      return rs.includes(null) ? null : true;
    }
    case "or": {
      const rs = c.terms.map((t) => evaluateCondition(t, values, ctx));
      if (rs.includes(true)) return true;
      return rs.includes(null) ? null : false;
    }
  }
}
