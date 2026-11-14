import { createHash } from "node:crypto";

/** `a.b[0].c` and `a[*].b` (the latter returns every element's value). Returns undefined when the path does not resolve. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown[] = [obj];
  for (const raw of path.split(".")) {
    const m = /^([^[\]]*)(?:\[(\d+|\*)\])?$/.exec(raw);
    if (!m) return undefined;
    const next: unknown[] = [];
    for (const c of cur) {
      const v: unknown = m[1] ? (c as Record<string, unknown> | null)?.[m[1]] : c;
      if (m[2] === undefined) next.push(v);
      else if (Array.isArray(v)) {
        if (m[2] === "*") next.push(...v);
        else next.push(v[Number(m[2])]);
      } else next.push(undefined);
    }
    cur = next;
    if (cur.every((x) => x === undefined)) return undefined;
  }
  return path.includes("[*]") ? cur : cur[0];
}

/** Number from a JSON value (numbers and numeric strings, as the API renders exact decimals); NaN otherwise. */
export const num = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Relative difference |a-b| / max(|a|,|b|,1). */
export const relDiff = (a: number, b: number): number =>
  Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1);
