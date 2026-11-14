/**
 * Claim scan for fixture runs (16b G09 mode notes). A `FIXTURE` run may never produce the wording "OutLayer-verified",
 * "TEE-verified" or an unqualified `attested` badge. The only allowed wording for fixture evidence is
 * "fixture evidence, not OutLayer-backed" (or the qualified badge `attested (fixture trust root, not OutLayer-backed)`).
 * Sentences that negate the claim ("only when ...", "not ...") are descriptions of the rule, not claims.
 */
export interface ClaimViolation {
  text: string;
  pattern: string;
}
const PATTERNS: Array<[string, RegExp]> = [
  ["OutLayer-verified", /\bOutLayer[-‑ ]verified\b/i],
  ["TEE-verified", /\bTEE[-‑ ]verified\b/i],
  ["unqualified attested", /(?<![\w_-])attested\b(?!\s*\(fixture trust root, not OutLayer-backed\))/i],
];
const NEGATING = /\b(only when|not|never|no)\b/i;

export function scanFixtureClaims(texts: string[]): { violations: ClaimViolation[] } {
  const violations: ClaimViolation[] = [];
  for (const t of texts)
    for (const sentence of t.split(/(?<=[.!?\n])\s+|\\n/)) {
      for (const [name, re] of PATTERNS) {
        if (!re.test(sentence)) continue;
        if (NEGATING.test(sentence) && name !== "unqualified attested") continue;
        if (
          name === "unqualified attested" &&
          /\b(not|never|no)\s+(an?\s+)?attested\b|attested.*not OutLayer-backed/i.test(sentence)
        )
          continue;
        violations.push({ text: sentence.slice(0, 160), pattern: name });
      }
    }
  return { violations };
}
