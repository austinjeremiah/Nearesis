/**
 * Wording and structure validator for user theses (rules of scripts/thesis/validate.ts, adapted to a document built from a
 * workspace run). Quoted text written by a model or by the user (findings, skeptic notes, the hypothesis) sits on lines that
 * start with `> ` or that cite the quoted record (findings.json, the hypothesis text); it is shown verbatim and attributed, so the wording rules look at the generated text around it only.
 */
export const SECTION_IDS = [
  "executive-claim",
  "what-would-change-our-mind",
  "sample-and-sources",
  "methods",
  "primary-benchmark",
  "evidence-for",
  "evidence-against",
  "confounders-and-blind-spots",
  "long-term-economic-mechanisms",
  "verdict-per-claim",
  "reproduction",
  "unable-to-compute",
  "source-index",
  "changes-since-previous-version",
] as const;

export const SECTION_TITLES = [
  "Executive claim",
  "What would change our mind",
  "Sample and sources",
  "Methods",
  "Primary benchmark",
  "Evidence for",
  "Evidence against",
  "Confounders and blind spots",
  "Long-term economic mechanisms",
  "Verdict per claim",
  "Reproduction",
  "Unable to compute",
  "Source index",
  "Changes since previous version",
] as const;

export const UNTESTED_NOTE = "No evidence against was recorded; treat this thesis as untested";

const CAUSAL_TERMS = ["causes", "drives", "leads to", "caused by", "driven by", "causal effect of"];
const CAUSAL_ALLOW = [
  "not cause",
  "does not cause",
  "no causal claim",
  "not a causal claim",
  "causality is excluded",
  "not causal",
  "does not show cause",
  "not show cause",
  "does not establish",
];
const BULLISH = ["bullish", "bearish", "will rally", "moon", "guaranteed", "to the moon"];
const SIGNIFICANCE =
  /(?<!not )(?<!no )statistically significant|\bsignificantly (better|improv\w+|different|higher|lower)/i;

export interface ThesisFailure {
  rule: string;
  detail: string;
}

/** The generated lines of a markdown text: quoted lines (`> `) are the attributed words of someone else. */
const QUOTING = /\[(?:findings\.json#|hypothesis\.json#\/(?:proposition|falsification))/;
export const generatedText = (md: string): string =>
  md
    .split("\n")
    .filter((l) => !/^\s*>/.test(l) && !QUOTING.test(l))
    .join("\n");

export function causalHits(md: string): { term: string; sentence: string }[] {
  const hits: { term: string; sentence: string }[] = [];
  for (const sent of generatedText(md).split(/(?<=[.!?])\s+|\n/)) {
    const s = sent.toLowerCase();
    for (const t of CAUSAL_TERMS) {
      if (new RegExp(`\\b${t.replace(/ /g, "\\s")}\\b`).test(s) && !CAUSAL_ALLOW.some((a) => s.includes(a)))
        hits.push({ term: t, sentence: sent.trim().slice(0, 160) });
    }
  }
  return hits;
}

interface DocLike {
  verdict: { status: string; headline: string; whatWouldChangeOurMind: string[] };
  sections: { id: string; title: string; markdown: string }[];
  charts: Record<string, unknown>[];
}

/** Wording of one generated text (no structure rules). */
export function wordingFailures(text: string, where: string): ThesisFailure[] {
  const out: ThesisFailure[] = [];
  const t = generatedText(text);
  for (const h of causalHits(text))
    out.push({ rule: "causal_language", detail: `${where}: ${h.term}: ${h.sentence}` });
  const low = t.toLowerCase();
  for (const b of BULLISH)
    if (new RegExp(`\\b${b.replace(/ /g, "\\s")}\\b`).test(low))
      out.push({ rule: "bullish_language", detail: `${where}: ${b}` });
  if (SIGNIFICANCE.test(t))
    out.push({
      rule: "significance_claim_without_valid_inference",
      detail: `${where}: statistical-significance wording`,
    });
  return out;
}

export function validateThesisDoc(doc: DocLike): { ok: boolean; failures: ThesisFailure[] } {
  const failures: ThesisFailure[] = [];
  const ids = doc.sections.map((s) => s.id);
  if (JSON.stringify(ids) !== JSON.stringify(SECTION_IDS))
    failures.push({ rule: "section_order", detail: ids.join(", ") });
  doc.sections.forEach((s, i) => {
    if (s.title !== SECTION_TITLES[i])
      failures.push({ rule: "section_title", detail: `${s.id}: ${s.title}` });
    if (!s.markdown.trim()) failures.push({ rule: "empty_section", detail: s.title });
    failures.push(...wordingFailures(s.markdown, s.title));
  });
  const byId = new Map(doc.sections.map((s) => [s.id, s.markdown]));
  const exec = byId.get("executive-claim") ?? "";
  if (!exec.includes(doc.verdict.status))
    failures.push({ rule: "executive_claim_omits_verdict", detail: doc.verdict.status });
  if (doc.verdict.status !== "SUPPORTED" && /\b(bullish|improved out-of-sample)\b/i.test(generatedText(exec)))
    failures.push({ rule: "unsupported_bullish_claim", detail: exec.slice(0, 120) });
  failures.push(...wordingFailures(doc.verdict.headline, "headline"));
  doc.verdict.whatWouldChangeOurMind.forEach((w, i) =>
    failures.push(...wordingFailures(w, `whatWouldChangeOurMind ${i}`)),
  );
  for (const c of doc.charts as Array<{ id: string; sentence: string; evidenceAgainst: string | null }>) {
    failures.push(...wordingFailures(c.sentence, `chart ${c.id} sentence`));
    if (c.evidenceAgainst)
      failures.push(...wordingFailures(c.evidenceAgainst, `chart ${c.id} evidenceAgainst`));
  }
  return { ok: failures.length === 0, failures };
}
