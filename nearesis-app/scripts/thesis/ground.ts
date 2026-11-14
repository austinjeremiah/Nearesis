/**
 * Number grounding for the thesis bundle. Every number that reaches THESIS.md, a chart sentence or an evidence-against note
 * is read from a frozen file through the Ledger, which records `file#pointer` and the exact text that was shown. The scanner
 * then re-checks the finished text on its own: each numeric token must sit on a line (or in a sentence) that cites a ledger
 * entry whose recorded text contains that token. Modelled on checkPublication (packages/capsule), which is not edited.
 * Exempt (not claims): ISO dates and timestamps, hex digests, snapshot/version identifiers, URLs, ordered-list markers,
 * fenced code and the citation tags themselves.
 */

export type Json = unknown;

const NUM = /(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?%?(?!\d)/g;
const CITE = /\[([^[\]\s|]+#[^[\]\s|]+)\]/g;

export const norm = (s: string): string => s.replace(/,/g, "").replace(/^\+/, "").replace(/%$/, "");

/** Numeric tokens of a text after the exemptions above, normalised. */
export function numericTokens(text: string): string[] {
  const stripped = text
    .replace(CITE, " ")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b[0-9a-f]{16,}\b/gi, " ")
    .replace(/\b(?:cap-)?live-\d{8}-\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{12}\b/g, " ")
    .replace(/\bv-[0-9a-f]{12}\b/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, " ");
  return [...stripped.matchAll(NUM)].map((m) => norm(m[0]));
}

/** 3 significant digits, plain decimal notation (never exponent); integers of 100 or more are rounded to whole numbers. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) throw new Error("fmt: non-finite number");
  if (n === 0) return "0";
  if (Number.isInteger(n) && Math.abs(n) < 1000) return String(n);
  const a = Math.abs(n);
  if (a >= 1000) return commas(String(Math.round(n)));
  const decimals = Math.min(20, Math.max(0, 2 - Math.floor(Math.log10(a))));
  const out = n.toFixed(decimals);
  return out === "-0" ? "0" : out;
}
export function commas(s: string): string {
  const neg = s.startsWith("-");
  const [i = "", f] = (neg ? s.slice(1) : s).split(".");
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${g}${f !== undefined ? `.${f}` : ""}`;
}
export const fmtPct = (ratio: number): string => fmt(ratio * 100);

/** Resolves `/a/b/0` against a parsed JSON value ( ~1 and ~0 escapes ); undefined when absent. */
export function resolvePointer(doc: Json, pointer: string): Json {
  if (pointer === "" || pointer === "/") return doc;
  let cur: any = doc; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object" || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export interface LedgerEntry {
  id: string;
  /** Text the reader sees for this reference; numbers in it are grounded. */
  texts: Set<string>;
}

/** Registry of grounded values: read from loaded files only, remembers which references each fill used. */
export class Ledger {
  readonly entries = new Map<string, LedgerEntry>();
  private frames: Set<string>[] = [];
  constructor(private readonly files: Map<string, Json>) {}

  private touch(id: string, text: string): void {
    let e = this.entries.get(id);
    if (!e) this.entries.set(id, (e = { id, texts: new Set() }));
    e.texts.add(text);
    for (const f of this.frames) f.add(id);
  }
  /** Raw value at `file#pointer`; throws when absent so nothing is invented. */
  get(file: string, pointer: string): Json {
    const doc = this.files.get(file);
    if (doc === undefined) throw new Error(`ledger: unknown file ${file}`);
    const v = resolvePointer(doc, pointer);
    if (v === undefined) throw new Error(`ledger: ${file}#${pointer} does not exist`);
    return v;
  }
  /** A number read from `file#pointer`, shown through `show` (default: 3 significant digits). */
  n(file: string, pointer: string, show: (x: number) => string = fmt): string {
    const raw = this.get(file, pointer);
    const x = typeof raw === "string" ? Number(raw) : raw;
    if (typeof x !== "number" || !Number.isFinite(x))
      throw new Error(`ledger: ${file}#${pointer} is not a finite number`);
    const text = show(x);
    this.touch(`${file}#${pointer}`, text);
    return text;
  }
  /** A string read from `file#pointer`, shown verbatim. */
  s(file: string, pointer: string): string {
    const raw = this.get(file, pointer);
    if (typeof raw !== "string") throw new Error(`ledger: ${file}#${pointer} is not a string`);
    this.touch(`${file}#${pointer}`, raw);
    return raw;
  }
  /** A value computed from several pointers of one file; the id names the computation and its inputs. */
  derived(file: string, op: string, inputs: string[], text: string): string {
    for (const p of inputs) this.get(file, p);
    this.touch(`${file}#${op}(${inputs.join(",")})`, text);
    return text;
  }
  /** Registers an object-level reference (no displayed number) and returns its bracketed citation. */
  ref(file: string, pointer: string): string {
    this.get(file, pointer);
    this.touch(`${file}#${pointer}`, "");
    return `[${file}#${pointer}]`;
  }
  /** Registers one more accepted rendering of the value at `file#pointer` (used for authored analysis blocks). */
  derivedText(file: string, pointer: string, text: string): void {
    this.get(file, pointer);
    this.touch(`${file}#${pointer}`, text);
  }
  /** A computed value that is not a number of the file itself (counts of rows): cited by the object it counts. */
  count(file: string, pointer: string, value: number): string {
    this.get(file, pointer);
    const text = String(value);
    this.touch(`${file}#count(${pointer})`, text);
    return text;
  }
  /** Runs `fn`, returning its text and every distinct reference it touched, in first-use order. */
  collect(fn: () => string): { text: string; refs: string[] } {
    const set = new Set<string>();
    this.frames.push(set);
    try {
      return { text: fn(), refs: [...set] };
    } finally {
      this.frames.pop();
    }
  }
  /** `text` followed by its citations, one line. */
  line(fn: () => string): string {
    const { text, refs } = this.collect(fn);
    return refs.length ? `${text} ${refs.map((r) => `[${r}]`).join("")}` : text;
  }
}

export interface GroundViolation {
  line: number;
  number: string;
  kind: "MISSING_CITATION" | "UNKNOWN_REFERENCE" | "VALUE_NOT_IN_REFERENCE";
  text: string;
}
export interface GroundCheck {
  ok: boolean;
  violations: GroundViolation[];
  numbersChecked: number;
}

function allowedTokens(refs: string[], ledger: Ledger): Set<string> | null {
  const out = new Set<string>();
  for (const r of refs) {
    const e = ledger.entries.get(r);
    if (!e) return null;
    for (const t of e.texts) {
      out.add(norm(t));
      for (const n of numericTokens(t)) out.add(n);
      // numbers inside strings: exempt-pattern stripping would hide dates only, which are not numbers here
      for (const m of t.matchAll(NUM)) out.add(norm(m[0]));
    }
  }
  return out;
}

/** Line-by-line scan of markdown: numbers must be on a line that cites existing ledger entries containing them. */
export function scanGrounding(markdown: string, ledger: Ledger): GroundCheck {
  const violations: GroundViolation[] = [];
  let checked = 0;
  let fence = false;
  markdown.split("\n").forEach((line, idx) => {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const refs = [...line.matchAll(CITE)].map((m) => m[1]!);
    for (const num of numericTokens(line)) {
      checked++;
      const v = (kind: GroundViolation["kind"]) =>
        violations.push({ line: idx + 1, number: num, kind, text: line.slice(0, 160) });
      if (refs.length === 0) {
        v("MISSING_CITATION");
        continue;
      }
      const ok = allowedTokens(refs, ledger);
      if (!ok) {
        v("UNKNOWN_REFERENCE");
        continue;
      }
      if (!ok.has(num)) v("VALUE_NOT_IN_REFERENCE");
    }
  });
  return { ok: violations.length === 0, violations, numbersChecked: checked };
}

/** A chart sentence or note carries its references beside it (not inline); same rule, one text. */
export function scanSentence(text: string, refs: string[], ledger: Ledger): GroundCheck {
  return scanGrounding(`${text} ${refs.map((r) => `[${r}]`).join("")}`, ledger);
}
