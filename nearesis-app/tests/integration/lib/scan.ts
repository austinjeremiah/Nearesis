/**
 * Numeric-claim scanner over the whole product surface (ch.16b B07). Free text goes through the frozen grammar of the
 * A19 scanner (agent-runtime groundingScan); a surface that scans 0 numeric strings is reported, never counted as clean.
 */
import { groundingScan, type Fact } from "../../../packages/agent-runtime/src/index.ts";

export interface SurfaceFact extends Fact {
  resultId: string;
  queryHash: string;
  snapshotId: string;
}
export interface SurfaceReport {
  surface: string;
  numericStrings: number;
  matched: Array<{ token: string; resultId: string; queryHash: string; snapshotId: string }>;
  unmatched: string[];
}

/** Numeric strings of `text` = supported + flagged tokens (excluded incidental tokens are not claims). */
export function scanSurface(
  surface: string,
  text: string,
  facts: SurfaceFact[],
  bounds: string[] = [],
): SurfaceReport {
  // citation tags carry a result id, not a quantity; strip them before scanning the prose
  const prose = text.replace(/\[R:[A-Za-z0-9._-]+\]/g, " ");
  const r = groundingScan(prose, facts, { intervalBounds: bounds });
  const byValue = new Map(facts.map((f) => [f.value, f]));
  return {
    surface,
    numericStrings: r.supported.length + r.flagged.length,
    matched: r.supported.map((s) => {
      const f = byValue.get(s.fact) ?? facts.find((x) => x.value === s.fact)!;
      return { token: s.token, resultId: f.resultId, queryHash: f.queryHash, snapshotId: f.snapshotId };
    }),
    unmatched: r.flagged.map((x) => x.token),
  };
}

import { checkPublication } from "../../../packages/capsule/src/index.ts";

/** Text lines of the capsule's plain-text PDF (strings shown with `'` or `Tj`). */
export function pdfText(b: Buffer): string {
  const s = b.toString("latin1");
  const lines = [...s.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*(?:'|Tj)/g)].map((m) =>
    m[1]!.replace(/\\([()\\])/g, "$1"),
  );
  // the PDF wraps long lines; a paragraph (lines up to the next blank line) is one claim line again
  const paras: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (l.trim() === "") {
      if (cur.length) paras.push(cur.join(" "));
      cur = [];
    } else cur.push(l);
  }
  if (cur.length) paras.push(cur.join(" "));
  return paras.join("\n");
}

/**
 * Documents that cite results (`[R:<id>]`) are scanned with the publication check (every number needs a citation to a
 * result that contains it); each number that passes is reported with its result id, query identity and snapshot.
 */
export function scanCited(
  surface: string,
  text: string,
  results: Array<{ id: string; value: string }>,
  ctx: { queryHash: string; snapshotId: string },
): SurfaceReport {
  const c = checkPublication(text, results);
  const bad = new Set(c.violations.map((v) => v.line));
  const matched: SurfaceReport["matched"] = [];
  text.split("\n").forEach((line, i) => {
    if (bad.has(i + 1)) return;
    for (const m of line.matchAll(/\[R:([A-Za-z0-9][A-Za-z0-9._-]*)\]/g))
      matched.push({ token: m[1]!, resultId: m[1]!, queryHash: ctx.queryHash, snapshotId: ctx.snapshotId });
  });
  return {
    surface,
    numericStrings: c.numbersChecked,
    matched,
    unmatched: c.violations.map((v) => `${v.number} (${v.kind}, line ${v.line})`),
  };
}
