import { createHash } from "node:crypto";

/** Pure helpers for `pnpm thesis:data` (no I/O). */

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Plain decimal string for a number printed by ClickHouse or BigQuery: no exponent, no '+', no trailing fractional zeros,
 * no leading zeros. The digits are never rounded (string arithmetic only), so a shortest round-trip float print stays exact
 * as printed. Returns null for null/empty; throws on anything that is not a finite decimal.
 */
export function toPlainDecimal(input: string | number | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (s === "") return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m || ((m[2] ?? "") === "" && (m[3] ?? "") === "")) throw new Error(`not a finite decimal: ${s}`);
  const sign = m[1] === "-" ? "-" : "";
  const exp = m[4] ? Number(m[4]) : 0;
  let digits = `${m[2] ?? ""}${m[3] ?? ""}`;
  let point = (m[2] ?? "").length + exp; // position of the decimal point within `digits`
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  } else if (point > digits.length) digits = digits + "0".repeat(point - digits.length);
  let int = digits.slice(0, point).replace(/^0+/, "");
  const frac = digits.slice(point).replace(/0+$/, "");
  if (int === "") int = "0";
  const out = frac === "" ? int : `${int}.${frac}`;
  return out === "0" ? "0" : `${sign}${out}`;
}

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Inclusive list of YYYY-MM-DD between from and to. */
export function eachDay(from: string, to: string): string[] {
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) throw new Error("bad window");
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** Window days with no row (a null value does not count as present). Never fills anything. */
export function missingDays(
  rows: ReadonlyArray<readonly unknown[]>,
  from: string,
  to: string,
  valueCol = 1,
): string[] {
  const present = new Set(rows.filter((r) => r[valueCol] !== null).map((r) => String(r[0])));
  return eachDay(from, to).filter((d) => !present.has(d));
}

export interface RawColumn {
  name: string;
  type: string;
}

/** Deterministic raw file text: one row per line. */
export function serializeRaw(columns: RawColumn[], rows: ReadonlyArray<readonly (string | null)[]>): string {
  return `{"columns":${JSON.stringify(columns)},"rows":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
}

export interface SeriesComparison {
  keys: string;
  daysLocal: number;
  daysOther: number;
  daysCompared: number;
  daysEqual: number;
  maxAbsDiff: string;
  maxAbsDiffDay: string | null;
}

/** Compares two day -> integer-string series on the days both hold. Exact (BigInt). */
export function compareIntSeries(
  local: ReadonlyArray<readonly [string, string | null]>,
  other: ReadonlyArray<readonly [string, string | null]>,
): SeriesComparison {
  const o = new Map(other.filter((r) => r[1] !== null).map((r) => [r[0], BigInt(r[1] as string)]));
  const l = local.filter((r) => r[1] !== null);
  let compared = 0;
  let equal = 0;
  let max = 0n;
  let maxDay: string | null = null;
  for (const [d, v] of l) {
    const b = o.get(d);
    if (b === undefined) continue;
    compared++;
    const diff = BigInt(v as string) - b;
    const abs = diff < 0n ? -diff : diff;
    if (abs === 0n) equal++;
    if (abs > max) {
      max = abs;
      maxDay = d;
    }
  }
  return {
    keys: "day",
    daysLocal: l.length,
    daysOther: o.size,
    daysCompared: compared,
    daysEqual: equal,
    maxAbsDiff: max.toString(),
    maxAbsDiffDay: maxDay,
  };
}

/** Size of the intersection of the first `n` ids of two ranked lists. */
export function topOverlap(a: readonly string[], b: readonly string[], n: number): number {
  const s = new Set(b.slice(0, n));
  return a.slice(0, n).filter((x) => s.has(x)).length;
}

/** First block of `--` header lines is replaced by `header`; the query text is kept verbatim. */
export function withHeader(header: string[], query: string): string {
  return `${header.map((l) => `-- ${l}`).join("\n")}\n${query.trim()}\n`;
}
