import { MAX_CONDITION_DEPTH, MAX_CONDITION_NODES, conditionShape } from "@nearesis/contracts";
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

/**
 * Three-valued, deterministic evaluation. A metric with no observation is `null` (unknown): unknown never satisfies a
 * comparison and never coerces to zero. `not(unknown)` is unknown; `and` is false if any term is false, else unknown if
 * any is unknown; `or` is true if any term is true, else unknown if any is unknown. Only `true` fires a rule.
 */
export function evaluateCondition(c: Condition, values: Readonly<Record<string, number>>): boolean | null {
  switch (c.kind) {
    case "compare": {
      const v = Object.hasOwn(values, c.metricId) ? values[c.metricId] : undefined;
      if (v === undefined || !Number.isFinite(v)) return null;
      return CMP[c.op](v, c.value);
    }
    case "not": {
      const r = evaluateCondition(c.term, values);
      return r === null ? null : !r;
    }
    case "and": {
      const rs = c.terms.map((t) => evaluateCondition(t, values));
      if (rs.includes(false)) return false;
      return rs.includes(null) ? null : true;
    }
    case "or": {
      const rs = c.terms.map((t) => evaluateCondition(t, values));
      if (rs.includes(true)) return true;
      return rs.includes(null) ? null : false;
    }
  }
}
