import { candidatesOf, relatednessOf, statementOf } from "@nearesis/capsule";
import type { Relatedness, RunPanel, TestPlan } from "@nearesis/capsule";
import type { CapsuleFacts } from "./facts.ts";
import { RULE_V2, ppmText } from "./rule.ts";
import { relationshipStats } from "./stats.ts";
import type { RelationshipStats } from "./stats.ts";

/** What both the generator and the verifier need to know about the test of a capsule, derived from its own files only. */
export function planOf(facts: CapsuleFacts): {
  plan: TestPlan;
  chosenBy: "planner" | "user" | "rule";
  named: boolean;
} {
  const sel = facts.index.selection;
  if (sel.plan)
    return { plan: sel.plan, chosenBy: sel.chosenBy ?? "rule", named: sel.namedForQuestion === true };
  const title = (h: string): string => facts.index.panels.find((p) => p.hash === h)?.title ?? h;
  const x = { panel: sel.x.panelHash, panelTitle: title(sel.x.panelHash), column: sel.x.column };
  const y = { panel: sel.y.panelHash, panelTitle: title(sel.y.panelHash), column: sel.y.column };
  return {
    chosenBy: "rule",
    named: false,
    plan: {
      x: { ...x, label: `${x.panelTitle}: ${x.column}`.slice(0, 200) },
      y: { ...y, label: `${y.panelTitle}: ${y.column}`.slice(0, 200) },
      relation: "moves_with",
      lagDays: 0,
      expectedSign: "either",
      statement: statementOf(x, y, "moves_with", 0, "either"),
      chosenBy: "rule",
      why: "Pair chosen by the original longest-overlap rule, not named for the question.",
    },
  };
}

/** The numbers of a test: attested ones from the verifier's results, recomputed ones from the frozen series. */
export interface TestNumbers {
  /** Aligned days in the window (verifier `n`). */
  n: number;
  /** Pairs used by the primary level correlation (n minus the lag). */
  pairs: number;
  lagDays: number;
  /** Primary level correlation: same-day for lag 0, otherwise the plan's lag (attested by the verifier). */
  levelPpm: bigint | null;
  pearsonPpm: bigint | null;
  lag7Ppm: bigint | null;
  stats: RelationshipStats;
}
export function testNumbers(
  results: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  input: Parameters<typeof relationshipStats>[0],
  lagDays: number,
  capsuleHash: string,
): TestNumbers {
  const big = (v: unknown): bigint | null => (v == null ? null : BigInt(v as string));
  const pearsonPpm = big(results.pearson_ppm);
  const lag7Ppm = big(results.lag_pearson_ppm?.[String(RULE_V2.lagDays)]);
  const stats = relationshipStats(input, lagDays, capsuleHash);
  const levelPpm = lagDays > 0 ? big(results.lag_pearson_ppm?.[String(lagDays)]) : pearsonPpm;
  return { n: Number(results.n), pairs: stats.pairs, lagDays, levelPpm, pearsonPpm, lag7Ppm, stats };
}

/** Mechanical-relation check of the plan's two columns on the given panels (heuristic). */
export function relatednessOfPlan(
  panels: Array<{ hash: string; title: string; body: object }>,
  plan: Pick<TestPlan, "x" | "y">,
): Relatedness | null {
  const { candidates } = candidatesOf(panels as unknown as RunPanel[]);
  const cx = candidates.find((c) => c.panelHash === plan.x.panel && c.column === plan.x.column);
  const cy = candidates.find((c) => c.panelHash === plan.y.panel && c.column === plan.y.column);
  if (!cx || !cy) return null;
  return relatednessOf(
    cx,
    cy,
    candidates.filter((c) => c.panelHash === cx.panelHash || c.panelHash === cy.panelHash),
  );
}
export const factsPanels = (facts: CapsuleFacts): Array<{ hash: string; title: string; body: object }> =>
  facts.index.panels.map((p) => ({ hash: p.hash, title: p.title, body: facts.panels.get(p.hash) ?? {} }));

/** The v2 numbers as the document records them (all ppm values as integer text and as ratio text). */
export function recordOf(t: TestNumbers): Record<string, unknown> {
  const pair = (v: bigint | null): { ppm: string | null; value: string | null } => ({
    ppm: v === null ? null : v.toString(),
    value: v === null ? null : ppmText(v),
  });
  const iv = t.stats.interval;
  return {
    level: pair(t.levelPpm),
    change: pair(t.stats.changePpm),
    spearman: pair(t.stats.spearmanPpm),
    interval: iv
      ? {
          levelPercent: RULE_V2.intervalPercent,
          lo: ppmText(iv.loPpm),
          hi: ppmText(iv.hiPpm),
          loPpm: iv.loPpm.toString(),
          hiPpm: iv.hiPpm.toString(),
          method: "moving-block bootstrap",
          blockDays: iv.blockLength,
          resamples: iv.resamples,
          validResamples: iv.validResamples,
          seed: iv.seed,
        }
      : null,
  };
}
