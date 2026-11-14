/** Structural validator for THESIS.md: the rules of services/research/nearesis_research/thesis.py (validate_thesis), ported. */
import { CLAIM_FIELDS, SECTION_TITLES } from "./markdown.ts";

const CAUSAL_TERMS = ["causes", "drives", "leads to", "caused by", "driven by"];
const CAUSAL_ALLOW = [
  "not cause",
  "does not cause",
  "no causal claim",
  "not a causal claim",
  "causality is excluded",
  "not causal",
];
const BULLISH = ["bullish", "will rally", "moon", "guaranteed"];
const CITE = /\[[^[\]\s|]+#[^[\]\s|]+\]/;

export interface ThesisFailure {
  rule: string;
  detail: string;
}

export function parseSections(md: string): [string, string][] {
  const parts = md.split(/^## (.+)$/m);
  const out: [string, string][] = [];
  for (let i = 1; i < parts.length - 1; i += 2) out.push([parts[i]!.trim(), parts[i + 1]!.trim()]);
  return out;
}

export function parseClaimTable(section: string): Record<string, string>[] {
  const lines = section.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 3) return [];
  const cells = (l: string): string[] =>
    l
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const head = cells(lines[0]!);
  return lines.slice(2).map((l) => Object.fromEntries(cells(l).map((c, i) => [head[i] ?? `col${i}`, c])));
}

export function causalHits(md: string): { term: string; sentence: string }[] {
  const hits: { term: string; sentence: string }[] = [];
  for (const sent of md.split(/(?<=[.!?])\s+|\n/)) {
    const s = sent.toLowerCase();
    for (const t of CAUSAL_TERMS) {
      if (new RegExp(`\\b${t.replace(/ /g, "\\s")}\\b`).test(s) && !CAUSAL_ALLOW.some((a) => s.includes(a)))
        hits.push({ term: t, sentence: sent.trim().slice(0, 160) });
    }
  }
  return hits;
}

export function validateThesisMarkdown(
  md: string,
  status: string,
): { ok: boolean; failures: ThesisFailure[] } {
  const failures: ThesisFailure[] = [];
  const secs = parseSections(md);
  const names = secs.map(([n]) => n);
  const titles = [...SECTION_TITLES] as string[];
  for (const t of titles) if (!names.includes(t)) failures.push({ rule: "missing_section", detail: t });
  if (!failures.length && JSON.stringify(names.filter((n) => titles.includes(n))) !== JSON.stringify(titles))
    failures.push({ rule: "section_order", detail: names.join(", ") });
  const d = new Map(secs);
  for (const name of ["Evidence against", "What would change our mind"]) {
    const body = d.get(name) ?? "";
    if (!body.trim()) failures.push({ rule: "empty_section", detail: name });
    else if (!CITE.test(body)) failures.push({ rule: "no_computed_result_reference", detail: name });
  }
  const forLen = (d.get("Evidence for") ?? "").length;
  const againstLen = (d.get("Evidence against") ?? "").length;
  if (againstLen < forLen)
    failures.push({ rule: "evidence_against_less_prominent", detail: `${againstLen} < ${forLen}` });
  const table = parseClaimTable(d.get("Verdict per claim") ?? "");
  if (!table.length) failures.push({ rule: "claim_table_missing", detail: "Verdict per claim" });
  table.forEach((row, i) => {
    for (const f of CLAIM_FIELDS)
      if (!(row[f] ?? "").trim()) failures.push({ rule: "claim_field_empty", detail: `row ${i + 1}: ${f}` });
  });
  for (const h of causalHits(md))
    failures.push({ rule: "causal_language", detail: `${h.term}: ${h.sentence}` });
  const ex = d.get("Executive claim") ?? "";
  if (!ex.includes(status)) failures.push({ rule: "executive_claim_omits_verdict", detail: status });
  if (
    status !== "SUPPORTED" &&
    [...BULLISH, "improved out-of-sample"].some((t) => ex.toLowerCase().includes(t))
  )
    failures.push({ rule: "unsupported_bullish_claim", detail: ex.slice(0, 120) });
  if (/(?<!not )(?<!no )statistically significant|\bsignificantly (better|improv\w+|different)/i.test(md))
    failures.push({
      rule: "significance_claim_without_valid_inference",
      detail: "statistical-significance wording",
    });
  return { ok: failures.length === 0, failures };
}
