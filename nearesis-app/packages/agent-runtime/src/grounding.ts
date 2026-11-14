/**
 * Numeric-grounding scanner (A19 e). Every quantitative token in conclusion text must match a fact value within the
 * token's printed precision. Incidental tokens are excluded ONLY by the frozen grammar below (16a A19); each exclusion
 * records the rule used. Rules run in order; a masked span cannot be reused by a later rule.
 *
 *   iso_datetime      ISO-8601 date-times            2026-11-10T09:00:00Z
 *   iso_date          ISO-8601 dates                 2026-11-10
 *   iso_time          ISO-8601 clock times           09:00:00
 *   interval_date     textual calendar dates equal to a declared query-interval bound (Nov 3, 2026)
 *   uuid              UUIDs
 *   hash              sha256: prefixed / >=16-char hex digests, 0x hex IDs
 *   test_id           test/gate/phase IDs            A19, A20-P, G04, P04
 *   ticket_id         FND-/BLK-/ADR-/RUN-/TASK-/INV-/T- IDs, run_ and task_ prefixed IDs
 *   semver            semantic versions              1.3.0, v2, v1.2
 *   schema_version    "schema version 3", schema_version=2
 *   metric_id         dotted metric ids / account ids intents.swap_count_24h, alice.near, capability@1
 *   member_id         snake_case identifiers containing digits   swap_count_24h
 *   list_ordinal      list ordinals and markdown numbering at a line start: "1.", "2)", "(3)", "## 4.2"
 */
export interface Fact {
  value: string;
  unit?: string;
}
export interface ScanOptions {
  /** ISO dates (YYYY-MM-DD) that are query-interval bounds; textual forms of these dates are incidental. */
  intervalBounds?: string[];
}
export interface ScanToken {
  token: string;
  index: number;
}
export interface ScanReport {
  flagged: Array<ScanToken & { reason: string }>;
  supported: Array<ScanToken & { fact: string }>;
  excluded: Array<ScanToken & { rule: string }>;
  clean: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

type Rule = { name: string; re: RegExp; accept?: (m: RegExpExecArray, o: ScanOptions) => boolean };

function textualDateToIso(m: RegExpExecArray): string | null {
  const g = m.groups!;
  const mon = MONTHS.indexOf((g.mon ?? "").slice(0, 3).toLowerCase());
  if (mon < 0) return null;
  return `${g.y}-${String(mon + 1).padStart(2, "0")}-${String(g.d).padStart(2, "0")}`;
}

const RULES: Rule[] = [
  {
    name: "iso_datetime",
    re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  },
  { name: "iso_date", re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { name: "iso_time", re: /\b\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b/g },
  {
    name: "interval_date",
    re: new RegExp(`\\b(?<mon>${MONTH_RE})\\.?\\s+(?<d>\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?<y>\\d{4})\\b`, "g"),
    accept: (m, o) => {
      const iso = textualDateToIso(m);
      return !!iso && (o.intervalBounds ?? []).includes(iso);
    },
  },
  {
    name: "interval_date",
    re: new RegExp(`\\b(?<d>\\d{1,2})(?:st|nd|rd|th)?\\s+(?<mon>${MONTH_RE})\\.?,?\\s+(?<y>\\d{4})\\b`, "g"),
    accept: (m, o) => {
      const iso = textualDateToIso(m);
      return !!iso && (o.intervalBounds ?? []).includes(iso);
    },
  },
  { name: "uuid", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { name: "hash", re: /\b(?:sha256:)?(?:0x)?(?=[0-9]*[a-fA-F])[0-9a-fA-F]{16,}\b|\b0x[0-9a-fA-F]+\b/g },
  {
    name: "ticket_id",
    re: /\b(?:FND|BLK|ADR|RUN|TASK|INV|T)-[A-Z0-9]*\d[A-Z0-9-]*\b|\b(?:run|task)_[A-Za-z0-9]+\b/g,
  },
  { name: "test_id", re: /\b[A-Z]\d{2}(?:-[A-Z0-9]+)?\b/g },
  { name: "semver", re: /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b|\bv\d+(?:\.\d+)?\b/g },
  {
    name: "schema_version",
    re: /\b(?:schema|ABI|contract|api)[ _-]?version[ :=]*v?\d+(?:\.\d+)*\b/gi,
  },
  {
    name: "metric_id",
    re: /\b[a-z][a-z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+(?:@\d+)?\b|\b[a-z0-9_-]+\.(?:near|testnet)\b|\b[a-z][a-z0-9_]*@\d+\b/g,
  },
  { name: "member_id", re: /\b[a-z][a-z]*(?:_[a-z0-9]+)+\b/g },
  {
    name: "list_ordinal",
    re: /^[ \t]*(?:[-*+][ \t]+)?(?:\d+[.)]|\(\d+\)|#{1,6}[ \t]+\d+(?:\.\d+)*\.?)(?=[ \t])/gm,
  },
];

const NUM_RE =
  /(?<sign>[-+−])?(?<cur>[$€£])?(?<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?<pct>%)?(?:\s?(?<sc>[kKmMbB])\b)?/g;

function scaleOf(s: string | undefined): number {
  switch ((s ?? "").toLowerCase()) {
    case "k":
      return 1e3;
    case "m":
      return 1e6;
    case "b":
      return 1e9;
    default:
      return 1;
  }
}
function decimalsOf(numText: string): number {
  const i = numText.indexOf(".");
  return i < 0 ? 0 : numText.length - i - 1;
}
function parseFact(v: string): number | null {
  const m = /^\s*(-|−)?\$?\s*([\d,]*\.?\d+)\s*(%|[kKmMbB])?\s*$/.exec(v);
  if (!m) return null;
  const n = Number(m[2]!.replaceAll(",", ""));
  if (Number.isNaN(n)) return null;
  const sc = m[3] === "%" ? 1 : scaleOf(m[3]);
  return (m[1] ? -1 : 1) * n * sc;
}

export function groundingScan(text: string, facts: Fact[], opts: ScanOptions = {}): ScanReport {
  const excluded: ScanReport["excluded"] = [];
  let masked = text;
  for (const rule of RULES) {
    masked = masked.replace(rule.re, (...args) => {
      const groups =
        typeof args[args.length - 1] === "object"
          ? (args[args.length - 1] as Record<string, string>)
          : undefined;
      const full = args[0] as string;
      const offset = args.find((a, i) => i > 0 && typeof a === "number") as number;
      const m = Object.assign([full], { index: offset, groups }) as unknown as RegExpExecArray;
      if (rule.accept && !rule.accept(m, opts)) return full;
      if (/\d/.test(full)) excluded.push({ token: full.trim(), index: offset, rule: rule.name });
      return " ".repeat(full.length);
    });
  }
  const factNums = facts.map((f) => ({ f, n: parseFact(f.value) })).filter((x) => x.n !== null) as Array<{
    f: Fact;
    n: number;
  }>;
  const flagged: ScanReport["flagged"] = [];
  const supported: ScanReport["supported"] = [];
  for (const m of masked.matchAll(NUM_RE)) {
    const g = m.groups!;
    const raw = m[0].trim();
    const numText = g.num!.replaceAll(",", "");
    const value = Number(numText);
    const scale = scaleOf(g.sc);
    const tokenVal = (g.sign && g.sign !== "+" ? -1 : 1) * value * scale;
    const tol = 0.5 * Math.pow(10, -decimalsOf(numText)) * scale * (1 + 1e-9);
    const candidates = g.pct ? [tokenVal, tokenVal / 100] : [tokenVal];
    const hit = factNums.find((fn) =>
      candidates.some((c, i) => Math.abs(c - fn.n) <= (i === 1 ? tol / 100 : tol) + 1e-12),
    );
    // a percent token may also match a ratio fact (0.125 vs 12.5%)
    const hit2 =
      hit ??
      (g.pct
        ? factNums.find(
            (fn) =>
              Math.abs(tokenVal / 100 - fn.n) <= tol / 100 + 1e-12 ||
              Math.abs(tokenVal - fn.n * 100) <= tol + 1e-9,
          )
        : undefined);
    if (hit2) supported.push({ token: raw, index: m.index!, fact: hit2.f.value });
    else flagged.push({ token: raw, index: m.index!, reason: "no fact within printed precision" });
  }
  return { flagged, supported, excluded, clean: flagged.length === 0 };
}
