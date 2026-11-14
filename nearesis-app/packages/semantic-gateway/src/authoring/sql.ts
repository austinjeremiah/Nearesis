import type { MetricAggregation, MetricFilter } from "@nearesis/contracts";
import type { CompiledTable } from "./compiler.ts";

/**
 * SQL rendering. Every identifier below comes from the generated catalogue (and is re-checked against a strict regex);
 * every value is a bound query parameter. There is no code path that interpolates proposal text.
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const id = (s: string): string => {
  if (!IDENT.test(s)) throw new Error(`refusing identifier ${JSON.stringify(s)}`);
  return `\`${s}\``;
};

export interface Stmt {
  sql: string;
  params: Record<string, unknown>;
}

const OPS = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;

function filterSql(t: CompiledTable, f: MetricFilter, i: number, params: Record<string, unknown>): string {
  const c = t.columns[f.column.column];
  if (!c) throw new Error("filter column missing from catalogue");
  const col = id(f.column.column);
  if (f.op === "is_null") return `isNull(${col})`;
  if (f.op === "not_null") return `isNotNull(${col})`;
  const p = `f${i}`;
  const isDate = /^(Nullable\()?Date(\)|$)/.test(c.chType);
  let ref: string;
  if (c.kind === "measure") {
    if (c.decimalScale !== null) {
      params[p] = String(f.values[0]);
      ref = `toDecimal256({${p}:String}, ${Math.min(c.decimalScale, 76)})`;
    } else {
      params[p] = f.values[0];
      ref = `{${p}:Float64}`;
    }
  } else if (c.kind === "time") {
    params[p] = String(f.values[0]);
    ref = isDate ? `{${p}:Date}` : `parseDateTime64BestEffort({${p}:String}, 3, 'UTC')`;
  } else {
    params[p] = f.values[0];
    ref = `{${p}:String}`;
  }
  if (f.op === "in") {
    if (c.kind === "measure") {
      params[p] = f.values.map(Number);
      return `${col} IN {${p}:Array(Float64)}`;
    }
    if (c.kind === "time") {
      params[p] = f.values.map(String);
      return isDate ? `${col} IN {${p}:Array(Date)}` : `toDate(${col}, 'UTC') IN {${p}:Array(Date)}`;
    }
    params[p] = f.values.map(String);
    return `${col} IN {${p}:Array(String)}`;
  }
  return `${col} ${OPS[f.op]} ${ref}`;
}

export const dayExpr = (t: CompiledTable) =>
  t.timeIsDate ? id(t.timeColumn) : `toDate(${id(t.timeColumn)}, 'UTC')`;

export function bucketExpr(t: CompiledTable, grain: "day" | "week" | "month"): string {
  const d = dayExpr(t);
  return grain === "day" ? d : grain === "week" ? `toStartOfWeek(${d}, 1)` : `toStartOfMonth(${d})`;
}

export function aggExpr(t: CompiledTable, a: MetricAggregation, propagate: boolean): string {
  const col = a.column ? id(a.column.column) : "";
  const c = a.column ? t.columns[a.column.column] : undefined;
  const scale = c?.decimalScale ?? (c && /Float/.test(c.chType) ? 9 : 18);
  let e: string;
  switch (a.fn) {
    case "count":
      return "count()";
    case "count_distinct":
      e = `uniqExact(${col})`;
      break;
    case "sum":
      e =
        c?.decimalScale === null && !/Float/.test(c?.chType ?? "")
          ? `sum(${col})`
          : `toDecimal256(sum(${col}), ${scale})`;
      break;
    case "avg":
      e = `toDecimal256(sum(${col}), ${scale}) / nullIf(count(${col}), 0)`;
      break;
    case "min":
      e = `min(${col})`;
      break;
    case "max":
      e = `max(${col})`;
      break;
  }
  return propagate && c?.nullable ? `if(countIf(isNull(${col})) > 0, NULL, ${e})` : e;
}

function from(t: CompiledTable): string {
  return `${id(t.database)}.${id(t.table)}${t.final ? " FINAL" : ""}`;
}

function where(t: CompiledTable, params: Record<string, unknown>, win: { from: string; to: string }): string {
  params.wf = win.from;
  params.wt = win.to;
  const parts = [`${dayExpr(t)} >= {wf:Date}`, `${dayExpr(t)} < {wt:Date}`];
  t.filters.forEach((f, i) => parts.push(filterSql(t, f, i, params)));
  return parts.join(" AND ");
}

/** Grouped statement: one row per (time bucket, dimensions). Aggregates are returned as exact strings. */
export function bucketStmt(
  t: CompiledTable,
  grain: "day" | "week" | "month",
  propagate: boolean,
  win: { from: string; to: string },
): Stmt {
  const params: Record<string, unknown> = {};
  const dims = t.dims.map((d, i) => `toString(${id(d)}) AS d${i}`);
  const aggs = t.aggs.map((a) => `toString(${aggExpr(t, a, propagate)}) AS ${id(`a_${a.id}`)}`);
  const w = where(t, params, win);
  const group = ["bucket", ...t.dims.map((_, i) => `d${i}`)].join(", ");
  return {
    sql: `SELECT toString(${bucketExpr(t, grain)}) AS bucket${dims.length ? ", " + dims.join(", ") : ""}, ${aggs.join(", ")}
FROM ${from(t)} WHERE ${w} GROUP BY ${group} ORDER BY ${group}`,
    params,
  };
}

/** Independent statement: one aggregate over an arbitrary window, no grouping (used for reconciliation against raw). */
export function rawAggStmt(
  t: CompiledTable,
  a: MetricAggregation,
  propagate: boolean,
  win: { from: string; to: string },
): Stmt {
  const params: Record<string, unknown> = {};
  const w = where(t, params, win);
  return { sql: `SELECT toString(${aggExpr(t, a, propagate)}) AS v FROM ${from(t)} WHERE ${w}`, params };
}
