import { concept } from "@nearesis/capsule";
import type { ExpectedSign } from "./rule.ts";

/**
 * Sorting of a run's findings and skeptic notes for the Evidence sections. Both the matching of a finding to the claim and the
 * grouping of notes are HEURISTIC (shared words and short phrase lists, no model); the thesis says so wherever it uses them.
 */
export type NoteGroup = "coverage" | "window" | "measurement" | "causation";
export const NOTE_GROUPS: NoteGroup[] = ["coverage", "window", "measurement", "causation"];
export const GROUP_TITLE: Record<NoteGroup, string> = {
  coverage: "Coverage",
  window: "Window choice",
  measurement: "Measurement",
  causation: "Causation",
};
const KEYWORDS: Record<Exclude<NoteGroup, "measurement">, string[]> = {
  causation: [
    "caus",
    "correlat",
    "association",
    "confound",
    "third",
    "shared external",
    "precede",
    "drives",
    "one-off event",
  ],
  coverage: ["gap", "partial", "coverage", "incomplete", "unknown value", "missing", "null", "not complete"],
  window: [
    "window",
    "endpoint",
    "start or end",
    "start and end",
    "day-to-day",
    "aggregation",
    "selected",
    "chosen",
    "choosing",
    "short-lived",
    "single unusual",
    "current only through",
    "later revisions",
  ],
};
export function classifyNote(text: string): NoteGroup {
  const t = text.toLowerCase();
  for (const g of ["causation", "coverage", "window"] as const)
    if (KEYWORDS[g].some((k) => t.includes(k))) return g;
  return "measurement";
}

const words = (t: string): Set<string> =>
  new Set(
    t
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
const jaccard = (a: Set<string>, b: Set<string>): number => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  const u = a.size + b.size - i;
  return u === 0 ? 1 : i / u;
};

export interface NoteItem {
  text: string;
  /** Pointer of the note in findings.json, for the reference list. */
  pointer: string;
  kind: "skeptic" | "limitation";
}
/** Deduplicated (exact after normalisation, or at least 80% shared words) notes, grouped, in first-seen order. */
export function groupNotes(items: NoteItem[]): Record<NoteGroup, NoteItem[]> {
  const out: Record<NoteGroup, NoteItem[]> = { coverage: [], window: [], measurement: [], causation: [] };
  const kept: Array<{ w: Set<string> }> = [];
  for (const it of items) {
    const w = words(it.text);
    if (kept.some((k) => jaccard(k.w, w) >= 0.8)) continue;
    kept.push({ w });
    out[classifyNote(it.text)].push(it);
  }
  return out;
}

/** Phrases by which a finding says there is NO general association (conservative; a heuristic). */
export const CONTRADICTION_PHRASES = [
  "not a general association",
  "no general association",
  "not a general relationship",
  "does not show a general",
  "does not establish a general",
  "no association",
  "no relationship",
  "no clear relationship",
  "no clear association",
  "no consistent relationship",
  "coincident spike",
  "not a sustained",
  "unrelated",
];
const FAVOUR_POSITIVE = [
  "moved together",
  "move together",
  "rose together",
  "fell together",
  "increased together",
  "tracked each other",
  "positively associated",
  "positive association",
  "both higher",
  "both rose",
];
const FAVOUR_NEGATIVE = [
  "moved in opposite directions",
  "move in opposite directions",
  "inverse relationship",
  "negative association",
  "negatively associated",
];
const IGNORE = new Set(["rate", "ratio", "share", "percent", "pct"]);

export type FindingRelation = "supports" | "contradicts" | "qualifies" | "none";
/**
 * A finding speaks to the claim when its statement uses a word of each series' name that the other series' name lacks.
 * It then contradicts (contains a phrase of CONTRADICTION_PHRASES), supports (contains a phrase that says the series moved
 * the way the plan expects) or qualifies (speaks to it, says neither).
 */
export function relationOfFinding(
  statement: string,
  x: string,
  y: string,
  expected: ExpectedSign,
): FindingRelation {
  const cx = concept(x).filter((t) => !IGNORE.has(t));
  const cy = concept(y).filter((t) => !IGNORE.has(t));
  const dx = cx.filter((t) => !cy.includes(t));
  const dy = cy.filter((t) => !cx.includes(t));
  const st = new Set(concept(statement));
  if (!(dx.some((t) => st.has(t)) && dy.some((t) => st.has(t)))) return "none";
  const low = statement.toLowerCase();
  if (CONTRADICTION_PHRASES.some((p) => low.includes(p))) return "contradicts";
  const fav =
    expected === "negative"
      ? FAVOUR_NEGATIVE
      : expected === "positive"
        ? FAVOUR_POSITIVE
        : [...FAVOUR_POSITIVE, ...FAVOUR_NEGATIVE];
  return fav.some((p) => low.includes(p)) ? "supports" : "qualifies";
}
export const relationOfFindings = (
  findings: Array<{ statement: string }>,
  x: string,
  y: string,
  expected: ExpectedSign,
): FindingRelation[] => findings.map((f) => relationOfFinding(f.statement, x, y, expected));
