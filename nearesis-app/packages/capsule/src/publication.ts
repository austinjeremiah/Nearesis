/**
 * Publication check (V06): every number in published prose must carry a citation `[R:<resultId>]` on the same line, the
 * cited result must exist, and the number must appear in that result's value. Anything else blocks publication.
 * Exempt (not claims): ISO dates, hex digests, URLs, ordered-list markers, fenced code, and the citation tags themselves.
 */
export interface CitableResult {
  id: string;
  value: string;
}
export interface PublicationViolation {
  line: number;
  number: string;
  kind: "MISSING_CITATION" | "UNKNOWN_RESULT" | "VALUE_NOT_IN_RESULT";
  text: string;
}
export interface PublicationCheck {
  ok: boolean;
  violations: PublicationViolation[];
  numbersChecked: number;
}

const CITE = /\[R:([A-Za-z0-9][A-Za-z0-9._-]*)\]/g;
const NUM = /(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?%?(?!\d)/g;

const norm = (s: string): string => s.replace(/,/g, "").replace(/^\+/, "").replace(/%$/, "");

export function checkPublication(markdown: string, results: CitableResult[]): PublicationCheck {
  const byId = new Map(results.map((r) => [r.id, r.value]));
  const violations: PublicationViolation[] = [];
  let numbersChecked = 0;
  let inFence = false;
  markdown.split("\n").forEach((rawLine, idx) => {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const cites = [...rawLine.matchAll(CITE)].map((m) => m[1]!);
    const stripped = rawLine
      .replace(CITE, " ")
      .replace(/^\s*\d+[.)]\s+/, "")
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/\b[0-9a-f]{16,}\b/gi, " ")
      .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, " ");
    for (const m of stripped.matchAll(NUM)) {
      const num = m[0];
      numbersChecked++;
      const v = (kind: PublicationViolation["kind"]) =>
        violations.push({ line: idx + 1, number: num, kind, text: rawLine.slice(0, 160) });
      if (cites.length === 0) {
        v("MISSING_CITATION");
        continue;
      }
      const known = cites.filter((c) => byId.has(c));
      if (known.length !== cites.length) {
        v("UNKNOWN_RESULT");
        continue;
      }
      const n = norm(num);
      const present = known.some((c) => {
        const val = norm(byId.get(c)!);
        return val === n || val.split(/[^\d.-]+/).includes(n);
      });
      if (!present) v("VALUE_NOT_IN_RESULT");
    }
  });
  return { ok: violations.length === 0, violations, numbersChecked };
}
