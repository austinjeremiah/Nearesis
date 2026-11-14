import { IngestionError } from "../errors.ts";

export const NEAR_DATASET = "crypto_near_mainnet_us";
export const ONE_GIB = 1024 ** 3;
export const MAX_BYTES_BILLED_CAP = ONE_GIB;

export interface TableRef {
  project: string;
  dataset: string;
  table: string;
  alias: string; // alias or table name
}

const stripComments = (sql: string): string =>
  sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

/** Table references appearing after FROM / JOIN. Supports backticked and plain three-part names. */
export function parseTableRefs(sqlIn: string): TableRef[] {
  const sql = stripComments(sqlIn);
  const re =
    /\b(?:FROM|JOIN)\s+`?([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_$]+)`?(?:\.[A-Za-z0-9_]+)?(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  const kw = new Set([
    "WHERE",
    "JOIN",
    "ON",
    "GROUP",
    "ORDER",
    "LIMIT",
    "LEFT",
    "RIGHT",
    "INNER",
    "OUTER",
    "CROSS",
    "FULL",
    "USING",
    "UNION",
    "HAVING",
    "WINDOW",
    "QUALIFY",
  ]);
  const out: TableRef[] = [];
  for (const m of sql.matchAll(re)) {
    const alias = m[4] && !kw.has(m[4].toUpperCase()) ? m[4] : (m[3] as string);
    out.push({ project: m[1] as string, dataset: m[2] as string, table: m[3] as string, alias });
  }
  return out;
}

/** DECLARE x DATE DEFAULT DATE '2026-08-01'; -> {x: "2026-08-01"} */
function declaredDates(sql: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const x of sql.matchAll(
    /DECLARE\s+([A-Za-z_]\w*)\s+DATE\s+DEFAULT\s+DATE\s*\(?\s*'(\d{4}-\d{2}-\d{2})'\s*\)?/gi,
  ))
    m.set((x[1] as string).toLowerCase(), x[2] as string);
  return m;
}

const DATE_VALUE = String.raw`(?:DATE\s*\(?\s*'(\d{4}-\d{2}-\d{2})'\s*\)?|'(\d{4}-\d{2}-\d{2})'|([A-Za-z_]\w*))`;

export interface BlockDateBounds {
  lower: string | null;
  upper: string | null;
}

/** Finite lower+upper literal bounds for `<ref>.block_date` (or bare block_date when the query has one table). */
export function blockDateBounds(sqlIn: string, ref: TableRef, singleTable: boolean): BlockDateBounds {
  const sql = stripComments(sqlIn);
  const vars = declaredDates(sql);
  const resolve = (a?: string, b?: string, v?: string): string | null =>
    a ?? b ?? (v ? (vars.get(v.toLowerCase()) ?? null) : null);
  const prefix = String.raw`(?:${escapeRe(ref.alias)}\.|${escapeRe(ref.table)}\.)`;
  const colPat = singleTable ? String.raw`${prefix}?block_date` : String.raw`${prefix}block_date`;
  const b: BlockDateBounds = { lower: null, upper: null };
  const between = new RegExp(
    String.raw`\b${colPat}\s+BETWEEN\s+${DATE_VALUE}\s+AND\s+${DATE_VALUE}`,
    "i",
  ).exec(sql);
  if (between) {
    b.lower = resolve(between[1], between[2], between[3]);
    b.upper = resolve(between[4], between[5], between[6]);
  }
  for (const m of sql.matchAll(new RegExp(String.raw`\b${colPat}\s*(>=|>|<=|<|=)\s*${DATE_VALUE}`, "gi"))) {
    const v = resolve(m[2], m[3], m[4]);
    if (!v) continue;
    if (m[1] === ">=" || m[1] === ">") b.lower = v;
    else if (m[1] === "<=" || m[1] === "<") b.upper = v;
    else {
      b.lower = v;
      b.upper = v;
    }
  }
  return b;
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface GuardVerdict {
  ok: boolean;
  tables: Array<TableRef & { bounded: boolean; bounds: BlockDateBounds }>;
  reasons: string[];
}

/** Static check. Pure; performs no I/O. */
export function checkSql(sqlIn: string): GuardVerdict {
  const sql = stripComments(sqlIn);
  const reasons: string[] = [];
  const stmts = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of stmts) {
    if (!/^(SELECT|WITH|DECLARE)\b/i.test(s)) reasons.push("only SELECT/WITH/DECLARE statements are allowed");
  }
  if (
    /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|EXPORT|CALL)\b/i.test(
      sql.replace(/'[^']*'/g, "''"),
    )
  )
    reasons.push("DML/DDL keyword present");
  const refs = parseTableRefs(sql).filter(
    (r) => r.dataset === NEAR_DATASET && r.table.toUpperCase() !== "INFORMATION_SCHEMA",
  );
  const hasInfoSchema = /\bINFORMATION_SCHEMA\b/i.test(sql);
  if (refs.length === 0 && !hasInfoSchema) reasons.push("no crypto_near_mainnet_us table reference found");
  const tables = refs.map((r) => {
    const bounds = blockDateBounds(sql, r, refs.length === 1);
    let bounded =
      bounds.lower !== null &&
      bounds.upper !== null &&
      /^\d{4}-\d{2}-\d{2}$/.test(bounds.lower) &&
      /^\d{4}-\d{2}-\d{2}$/.test(bounds.upper);
    if (bounded && (bounds.lower as string) > (bounds.upper as string)) bounded = false;
    if (!bounded) reasons.push(`table ${r.table} (${r.alias}) lacks a finite block_date predicate`);
    return { ...r, bounded, bounds };
  });
  if (tables.length && /\bWHERE\b[\s\S]*\bOR\b/i.test(sql))
    reasons.push("OR in WHERE can defeat partition pruning");
  return { ok: reasons.length === 0, tables, reasons };
}

export function assertGuardedSql(sql: string): GuardVerdict {
  const v = checkSql(sql);
  if (!v.ok) throw new IngestionError("BQ_REJECTED", false, { reason: v.reasons.join("; ") });
  return v;
}
