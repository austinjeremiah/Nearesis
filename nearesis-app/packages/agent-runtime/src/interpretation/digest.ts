import type { Cell, PanelResult } from "./types.ts";

export const MAX_DIGEST_ROWS = 28;

/** Numeric value of a cell: a number, or an exact decimal string. Null/boolean/non-numeric text is not a number. */
export function numeric(c: Cell): number | null {
  if (typeof c === "number") return Number.isFinite(c) ? c : null;
  if (typeof c === "string" && /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(c.trim())) return Number(c);
  return null;
}

export const columnIndex = (p: PanelResult, name: string): number =>
  p.columns.findIndex((c) => c.name === name);
const timeColumn = (p: PanelResult): number => p.columns.findIndex((c) => c.type === "time");
const isMeasure = (t: string): boolean => t === "number" || t === "decimal";

/** Stable row id for a ResultRef: the row's time cell when the panel has one, else its position. */
export function rowIdOf(p: PanelResult, row: number): string {
  const t = timeColumn(p);
  const v = t >= 0 ? p.rows[row]?.[t] : undefined;
  return typeof v === "string" && v ? v : `row:${row}`;
}

/** Which rows the model is shown: the ends, each measure's extremes and largest steps, then an even spread. */
export function digestRows(p: PanelResult, max = MAX_DIGEST_ROWS): number[] {
  const n = p.rows.length;
  if (n <= max) return p.rows.map((_r, i) => i);
  const pick = new Set<number>([0, 1, 2, n - 3, n - 2, n - 1]);
  p.columns.forEach((c, ci) => {
    if (!isMeasure(c.type)) return;
    let hi = -1;
    let lo = -1;
    const steps: Array<{ i: number; d: number }> = [];
    let prev: number | null = null;
    p.rows.forEach((r, i) => {
      const v = numeric(r[ci] ?? null);
      if (v === null) return;
      if (hi < 0 || v > numeric(p.rows[hi]![ci] ?? null)!) hi = i;
      if (lo < 0 || v < numeric(p.rows[lo]![ci] ?? null)!) lo = i;
      if (prev !== null) steps.push({ i, d: Math.abs(v - prev) });
      prev = v;
    });
    if (hi >= 0) pick.add(hi);
    if (lo >= 0) pick.add(lo);
    steps.sort((a, b) => b.d - a.d);
    for (const s of steps.slice(0, 2)) pick.add(s.i);
  });
  for (let k = 0; pick.size < max && k < max; k++) pick.add(Math.round((k * (n - 1)) / (max - 1)));
  return [...pick]
    .filter((i) => i >= 0 && i < n)
    .sort((a, b) => a - b)
    .slice(0, max + 8);
}

const fmt = (c: Cell): string => (c === null ? "null" : String(c));

/** Compact text of one panel for the model: envelope facts, per-measure statistics and the digest rows with their indices. */
export function panelDigest(p: PanelResult): string {
  const lines: string[] = [];
  lines.push(
    `panel ${p.panelId} "${p.title}" queryHash=${p.queryHash.slice(0, 12)} certification=${p.certification} completeness=${p.completeness} rows=${p.rows.length} nulls=${p.nullCount} partial=${p.partialCount} gaps=${p.gaps.length}${p.truncated ? " TRUNCATED" : ""}`,
  );
  lines.push(
    "columns: " + p.columns.map((c) => `${c.name}(${c.type}${c.unit ? `, ${c.unit}` : ""})`).join("; "),
  );
  for (const g of p.gaps.slice(0, 5)) lines.push(`gap ${g.from} .. ${g.to}: ${g.reason}`);
  p.columns.forEach((c, ci) => {
    if (!isMeasure(c.type)) return;
    const vals = p.rows
      .map((r, i) => ({ i, v: numeric(r[ci] ?? null) }))
      .filter((x): x is { i: number; v: number } => x.v !== null);
    if (!vals.length) {
      lines.push(`stats ${c.name}: no known values`);
      return;
    }
    const max = vals.reduce((a, b) => (b.v > a.v ? b : a));
    const min = vals.reduce((a, b) => (b.v < a.v ? b : a));
    lines.push(
      `stats ${c.name}: known=${vals.length} first[${vals[0]!.i}]=${fmt(p.rows[vals[0]!.i]![ci]!)} last[${vals.at(-1)!.i}]=${fmt(p.rows[vals.at(-1)!.i]![ci]!)} max[${max.i}]=${fmt(p.rows[max.i]![ci]!)} min[${min.i}]=${fmt(p.rows[min.i]![ci]!)}`,
    );
  });
  lines.push("rows (index | " + p.columns.map((c) => c.name).join(" | ") + "):");
  for (const i of digestRows(p)) lines.push(`[${i}] ${p.rows[i]!.map(fmt).join(" | ")}`);
  return lines.join("\n");
}
