import type { Doc } from "./verify.ts";

export interface CompareRow {
  what: string;
  original: string | null;
  reproduced: string | null;
  delta: string | null;
}

const num = (v: string | null): number | null =>
  v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
const deltaOf = (a: string | null, b: string | null): string | null => {
  const x = num(a);
  const y = num(b);
  return x === null || y === null ? null : String(Number((y - x).toPrecision(12)));
};

/** The series a chart's sentence describes: its recorded primary column, else the first. */
export const primarySeries = (c: Doc | undefined): Doc | undefined => {
  const list = (c?.series ?? []) as Doc[];
  return (typeof c?.primary === "string" ? list.find((s) => s.name === c.primary) : undefined) ?? list[0];
};

const firstLastPeak = (
  series: Doc | undefined,
): { first: string | null; last: string | null; peak: string | null } => {
  const vals = ((series?.values ?? []) as Array<string | null>).filter((v): v is string => v !== null);
  if (!vals.length) return { first: null, last: null, peak: null };
  let peak = vals[0]!;
  for (const v of vals) if (Number(v) > Number(peak)) peak = v;
  return { first: vals[0]!, last: vals[vals.length - 1]!, peak };
};

/**
 * Rows comparing an ORIGINAL thesis with a REPRODUCED one: verdict, n, window, each test number, and per chart first, last and
 * peak of its first series. `match`: every row equal. `different`: the verdict, n or window differ (not the same data).
 * `drift`: same verdict, n and window, but at least one number differs.
 */
export function compareDocs(
  orig: Doc,
  repro: Doc,
): { outcome: "match" | "drift" | "different"; rows: CompareRow[] } {
  const rows: CompareRow[] = [];
  const row = (what: string, a: unknown, b: unknown): CompareRow => {
    const o = a === undefined || a === null ? null : String(a);
    const r = b === undefined || b === null ? null : String(b);
    const x: CompareRow = { what, original: o, reproduced: r, delta: deltaOf(o, r) };
    rows.push(x);
    return x;
  };
  const vOrig = row("verdict", orig.verdict?.status, repro.verdict?.status);
  const structural: CompareRow[] = [vOrig];
  if (orig.test || repro.test) {
    structural.push(row("aligned days (n)", orig.test?.n, repro.test?.n));
    structural.push(row("window from", orig.test?.window?.from, repro.test?.window?.from));
    structural.push(row("window to", orig.test?.window?.to, repro.test?.window?.to));
    row("same-day Pearson correlation", orig.test?.pearson, repro.test?.pearson);
    if (orig.test?.level || repro.test?.level) {
      row("level correlation (plan's pairing)", orig.test?.level?.value, repro.test?.level?.value);
      row("correlation of day-over-day changes", orig.test?.change?.value, repro.test?.change?.value);
      row("rank (Spearman) correlation", orig.test?.spearman?.value, repro.test?.spearman?.value);
      row("interval low", orig.test?.interval?.lo, repro.test?.interval?.lo);
      row("interval high", orig.test?.interval?.hi, repro.test?.interval?.hi);
    }
    const lo = (orig.test?.lag ?? []) as Doc[];
    const lr = (repro.test?.lag ?? []) as Doc[];
    for (const l of lo)
      row(
        `Pearson correlation at a lag of ${String(l.days)} days`,
        l.value,
        lr.find((x) => x.days === l.days)?.value,
      );
  }
  const reproCharts = new Map<string, Doc>(((repro.charts ?? []) as Doc[]).map((c) => [String(c.id), c]));
  for (const c of (orig.charts ?? []) as Doc[]) {
    const other = reproCharts.get(String(c.id));
    const a = firstLastPeak(primarySeries(c));
    const b = firstLastPeak(primarySeries({ ...other, primary: c.primary }));
    row(`${String(c.title)}: first value`, a.first, b.first);
    row(`${String(c.title)}: last value`, a.last, b.last);
    row(`${String(c.title)}: peak`, a.peak, b.peak);
  }
  if (structural.some((r) => r.original !== r.reproduced)) return { outcome: "different", rows };
  return { outcome: rows.every((r) => r.original === r.reproduced) ? "match" : "drift", rows };
}
