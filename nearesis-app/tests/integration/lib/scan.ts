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
