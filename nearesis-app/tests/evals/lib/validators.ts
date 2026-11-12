import type { Probe, Question } from "./schema.ts";
import { getPath, num, relDiff } from "./util.ts";

export interface ProbeResult {
  label: string;
  kind: Probe["kind"];
  ok: boolean;
  observed: unknown;
  expected: unknown;
  detail: string;
}

export interface ProbeIo {
  apiGet(path: string): Promise<{ status: number; body: unknown }>;
  chScalar(sql: string): Promise<number>;
}

const sum = (v: unknown): number => (Array.isArray(v) ? v.reduce<number>((a, x) => a + num(x), 0) : num(v));

/** Deterministic probe: compares API output with an independent ClickHouse query or a structural invariant. Never a model. */
export async function runProbe(p: Probe, io: ProbeIo): Promise<ProbeResult> {
  const base = { label: p.label, kind: p.kind };
  try {
    if (p.kind === "ch_check") {
      const got = await io.chScalar(p.ch);
      return {
        ...base,
        ok: got === p.expect,
        observed: got,
        expected: p.expect,
        detail: got === p.expect ? "source fact holds" : `clickhouse ${got}, expected ${p.expect}`,
      };
    }
    const r = await io.apiGet(p.api);
    if (p.kind === "api_field") {
      const v = getPath(r.body, p.json);
      const okStatus = r.status === p.httpStatus;
      const okVal =
        p.equals !== undefined
          ? v === p.equals
          : p.matches !== undefined
            ? new RegExp(p.matches, "i").test(String(v))
            : v !== undefined;
      return {
        ...base,
        ok: okStatus && okVal,
        observed: { status: r.status, value: v },
        expected: { status: p.httpStatus, equals: p.equals, matches: p.matches },
        detail: okStatus && okVal ? "ok" : "field or status differs",
      };
    }
    if (r.status !== 200)
      return { ...base, ok: false, observed: r.status, expected: 200, detail: `api answered ${r.status}` };
    if (p.kind === "ch_equals") {
      const raw = getPath(r.body, p.json);
      const got = Array.isArray(raw) ? sum(raw) : num(raw);
      const want = await io.chScalar(p.ch);
      const ok = Number.isFinite(got) && Number.isFinite(want) && relDiff(got, want) <= p.rel;
      return {
        ...base,
        ok,
        observed: got,
        expected: want,
        detail: ok ? "matches independent query" : `api ${got} vs clickhouse ${want}`,
      };
    }
    if (p.kind === "sum_equals") {
      const got = p.parts.reduce((a, x) => a + sum(getPath(r.body, x)), 0);
      const want = p.total !== undefined ? sum(getPath(r.body, p.total)) : (p.totalValue ?? Number.NaN);
      const ok = Number.isFinite(got) && Number.isFinite(want) && Math.abs(got - want) <= p.abs;
      return {
        ...base,
        ok,
        observed: got,
        expected: want,
        detail: ok ? "partition invariant holds" : `parts ${got} vs total ${want}`,
      };
    }
    const v = num(getPath(r.body, p.json));
    const ok =
      Number.isFinite(v) && (p.min === undefined || v >= p.min) && (p.max === undefined || v <= p.max);
    return {
      ...base,
      ok,
      observed: v,
      expected: { min: p.min, max: p.max },
      detail: ok ? "in range" : "out of range",
    };
  } catch (e) {
    return {
      ...base,
      ok: false,
      observed: null,
      expected: null,
      detail: `probe error: ${(e as Error).message.slice(0, 200)}`,
    };
  }
}

/** Claims no answer may make, whatever the question. Per-question patterns are added on top. */
export const GLOBAL_FORBIDDEN = [
  {
    id: "overclaim",
    pattern: "\\b(proves?|proven|guarantees?|guaranteed|definitely|undeniabl[ey])\\b",
    flags: "i",
    why: "certainty language is never earned by descriptive aggregates",
  },
  {
    id: "significance_without_test",
    pattern: "statistically significant|p\\s*[<=]\\s*0?\\.\\d+",
    flags: "i",
    why: "significance needs a validated test result tied to a ResultRef",
  },
  {
    id: "accounts_are_people",
    pattern: "\\b(unique (users|people|humans|persons)|real (users|people)|number of people)\\b",
    flags: "i",
    why: "an account is not a person",
  },
];

export const forbiddenHits = (text: string, q: Pick<Question, "forbiddenClaims">): string[] =>
  [...GLOBAL_FORBIDDEN, ...q.forbiddenClaims]
    .filter((f) => new RegExp(f.pattern, f.flags).test(text))
    .map((f) => f.id);

/** Numbers of three or more digits in prose (dates, ids and years are skipped). */
export function proseNumbers(text: string): string[] {
  const cleaned = text
    .replace(/\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, " ")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, " ")
    .replace(/\b[0-9a-f]{32,}\b/gi, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ");
  return (cleaned.match(/\d[\d,]*\.?\d*/g) ?? [])
    .map((n) => n.replace(/,/g, ""))
    .filter((n) => n.replace(/\D/g, "").length >= 3);
}

/** Prose numbers that are neither a fact value nor an observed probe value: a number the answer cannot source. */
export function ungroundedNumbers(text: string, grounded: Iterable<string>): string[] {
  const g = [...grounded].map((x) => x.replace(/,/g, ""));
  return proseNumbers(text).filter((n) => !g.some((x) => x === n || x.startsWith(n) || n.startsWith(x)));
}
