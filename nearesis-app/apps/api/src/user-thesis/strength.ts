/**
 * Thesis strength: a deterministic 0..100 score with the parts that make it up. Pure: it reads the thesis document, the
 * receipt counts and the challenges, nothing else (no clock, no model, no database). Every number in a `detail` sentence is
 * read from the document or the counts. Missing points are the only penalty. Documents built before the test plan, the
 * interval or the rule changes simply score 0 on the parts they do not carry, and the detail says so.
 *
 * Fields read (all optional, tolerated when absent):
 *   workspace thesis:  test.plan { statement, lockedAt, sha256, chosenBy }, test.n, test.coverage.complete,
 *                      test.partOfWhole (true = the predictor is part of the outcome), test.reasons[],
 *                      test.interval { lo, hi } (or loPpm, hiPpm), verdict.status (INVALID_TEST scores 0 on valid_test), verification.capsule.status, verification.outlayer.status
 *   reference thesis:  origin.kind = "reference", claims[0].provenance (preregistration hash), verdict.intentsVsPrice.rows
 *                      (origins scored, adjusted p), sections methods (FDR q), charts (window, caveats), reproduce.hashes
 */

export interface StrengthPart {
  key: string;
  label: string;
  points: number;
  max: number;
  detail: string;
}
export type StrengthBand = "thin" | "fair" | "solid" | "strong";
export interface Strength {
  score: number;
  band: StrengthBand;
  parts: StrengthPart[];
}

/** The receipt counts the strength reads (the route's counts object carries more fields). */
export interface StrengthCounts {
  verified: number;
  reproduced: number;
}
/** The challenge fields the strength reads. */
export interface StrengthChallenge {
  outcome: string;
  notes: Array<{ severity: string }>;
  answer: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

export const bandOf = (score: number): StrengthBand =>
  score < 40 ? "thin" : score < 60 ? "fair" : score < 80 ? "solid" : "strong";

const isRef = (doc: Doc): boolean => doc.origin?.kind === "reference";
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const sectionText = (doc: Doc, id: string): string =>
  String(
    (doc.sections as Array<{ id: string; markdown: string }> | undefined)?.find((s) => s.id === id)
      ?.markdown ?? "",
  );

interface Row {
  label?: unknown;
  value?: unknown;
}
const rowsOf = (doc: Doc): Row[] =>
  Array.isArray(doc.verdict?.intentsVsPrice?.rows) ? doc.verdict.intentsVsPrice.rows : [];
const PRE_HASH = /preregistration sha256:([0-9a-f]{64})/;
const preregistration = (doc: Doc): string | null => {
  for (const c of (doc.claims ?? []) as Array<{ provenance?: unknown }>) {
    const m = PRE_HASH.exec(String(c.provenance ?? ""));
    if (m) return m[1]!;
  }
  return null;
};

function planLocked(doc: Doc): StrengthPart {
  const base = { key: "plan_locked", label: "Plan locked in advance", max: 15 };
  if (isRef(doc)) {
    const h = preregistration(doc);
    return h
      ? {
          ...base,
          points: 15,
          detail: `The claim, models and thresholds come from a preregistration (sha256 ${h.slice(0, 12)}) recorded before the results.`,
        }
      : { ...base, points: 0, detail: "The reference thesis carries no preregistration hash." };
  }
  const plan = doc.test?.plan;
  if (!plan || typeof plan !== "object")
    return {
      ...base,
      points: 0,
      detail:
        "This thesis was built without a test plan, so nothing was put on record before the data was seen.",
    };
  if (!str(plan.statement))
    return {
      ...base,
      points: 0,
      detail: "The test plan has no written statement: the pair was chosen by rule, not named in advance.",
    };
  const at = str(plan.lockedAt);
  if (!at || !str(plan.sha256))
    return {
      ...base,
      points: 0,
      detail: "The test plan was written but not locked (no lock time and hash recorded).",
    };
  return {
    ...base,
    points: 15,
    detail: `The test plan was locked at ${at} (sha256 ${String(plan.sha256).slice(0, 12)}), before the investigation ran.`,
  };
}

function daysOfData(doc: Doc): StrengthPart {
  const base = { key: "days_of_data", label: "Days of data", max: 15 };
  let n: number | null;
  let one: string;
  let many: string;
  if (isRef(doc)) {
    // the first "Origins scored" row is the primary horizon
    const row = rowsOf(doc).find((r) => /^origins scored/i.test(String(r.label ?? "")));
    n = num(row?.value);
    one = "scored forecast origin at the primary horizon";
    many = "scored forecast origins at the primary horizon";
  } else {
    n = num(doc.test?.n);
    one = "aligned day";
    many = "aligned days";
  }
  if (n === null)
    return {
      ...base,
      points: 0,
      detail: "The number of days or scored origins is not recorded in this thesis.",
    };
  const points = n >= 180 ? 15 : n >= 60 ? 10 : n >= 30 ? 5 : 0;
  return {
    ...base,
    points,
    detail: `${plural(n, one, many)} (180 or more gives full points, 60 two thirds, 30 one third).`,
  };
}

function coverage(doc: Doc): StrengthPart {
  const base = { key: "coverage_complete", label: "Coverage complete", max: 10 };
  if (isRef(doc)) {
    const charts = (doc.charts ?? []) as Array<{
      id?: string;
      x?: unknown[];
      xKind?: string;
      caveats?: string[];
      window?: { from?: string; to?: string };
    }>;
    const partial = charts.find((c) => (c.caveats ?? []).some((t) => /marked partial/i.test(t)));
    if (partial)
      return {
        ...base,
        points: 0,
        detail: `The ${partial.id ?? "a"} chart notes a day marked partial in the source coverage, so the data is not complete for every day of the window.`,
      };
    const daily = charts.filter((c) => c.xKind === "date" && c.window?.from && c.window?.to);
    const short = daily.find((c) => {
      const days =
        Math.round(
          (Date.parse(`${c.window!.to}T00:00:00Z`) - Date.parse(`${c.window!.from}T00:00:00Z`)) / 86_400_000,
        ) + 1;
      return (c.x?.length ?? 0) < days;
    });
    if (!daily.length)
      return {
        ...base,
        points: 0,
        detail: "No daily chart states its window, so completeness cannot be read.",
      };
    if (short)
      return {
        ...base,
        points: 0,
        detail: `The ${short.id ?? "a"} chart has fewer rows than days in its window.`,
      };
    return {
      ...base,
      points: 10,
      detail: `Every daily chart has a row for every day of its window and no chart notes a partial day.`,
    };
  }
  const c = doc.test?.coverage?.complete;
  if (c === true) return { ...base, points: 10, detail: "Both series are complete for every day used." };
  if (c === false)
    return {
      ...base,
      points: 0,
      detail: "At least one of the two series is not complete for the days used.",
    };
  return { ...base, points: 0, detail: "The coverage of the days used is not stated in this thesis." };
}

function validTest(doc: Doc): StrengthPart {
  const base = { key: "valid_test", label: "Valid test", max: 10 };
  if (isRef(doc)) {
    const pre = preregistration(doc);
    const excl = /Intents-generated accounts excluded/i.test(sectionText(doc, "methods"));
    if (pre && excl)
      return {
        ...base,
        points: 10,
        detail:
          "The comparison was named in advance and the outcome excludes Intents-generated accounts, so the predictor is not part of the outcome.",
      };
    return {
      ...base,
      points: 0,
      detail: pre
        ? "The thesis does not state that the predictor is kept out of the outcome."
        : "The comparison was not named in advance.",
    };
  }
  const t = doc.test ?? {};
  const reasons: unknown[] = Array.isArray(t.reasons) ? t.reasons : [];
  if (
    doc.verdict?.status === "INVALID_TEST" ||
    reasons.some((r) => /INVALID_TEST|MECHANICAL/i.test(String(r)))
  )
    return {
      ...base,
      points: 0,
      detail:
        "The two series are mechanically related (one is part of the other or a ratio of it), so the test is not valid.",
    };
  if (t.partOfWhole === true || reasons.some((r) => /PART_OF_WHOLE/i.test(String(r))))
    return {
      ...base,
      points: 0,
      detail: "One series is a part of the other, so a correlation between them is partly built in.",
    };
  const by = str(t.plan?.chosenBy);
  if (by === "user" || by === "planner")
    return {
      ...base,
      points: 10,
      detail: `The pair was named in the test plan (${by === "user" ? "by the user" : "by the planner"}), not picked by the data, and neither series is part of the other.`,
    };
  if (by === "rule")
    return {
      ...base,
      points: 0,
      detail: "The pair was chosen by rule after the data was seen, not named in advance.",
    };
  return {
    ...base,
    points: 0,
    detail: "This thesis does not record who chose the pair, so it counts as chosen by rule.",
  };
}

function intervalPart(doc: Doc): StrengthPart {
  const base = {
    key: "interval_or_not_supported",
    label: "Interval excludes zero or clear NOT_SUPPORTED",
    max: 10,
  };
  if (isRef(doc)) {
    const row = rowsOf(doc).find((r) => /^adjusted p-value/i.test(String(r.label ?? "")));
    const p = num(row?.value);
    const q = /Benjamini-Hochberg control at q ([0-9.]+)/.exec(sectionText(doc, "methods"));
    const qn = q ? num(q[1]) : null;
    if (p === null || qn === null)
      return {
        ...base,
        points: 0,
        detail: "The thesis does not state both the adjusted p-value and the false-discovery-rate level.",
      };
    return p < qn
      ? {
          ...base,
          points: 10,
          detail: `The adjusted p-value ${p} is below the false-discovery-rate level ${qn}.`,
        }
      : {
          ...base,
          points: 0,
          detail: `The adjusted p-value ${p} is not below the false-discovery-rate level ${qn}.`,
        };
  }
  const iv = doc.test?.interval;
  const ppm = (v: unknown): number | null => (num(v) === null ? null : num(v)! / 1_000_000);
  const lo = num(iv?.lo ?? iv?.low) ?? ppm(iv?.loPpm);
  const hi = num(iv?.hi ?? iv?.high) ?? ppm(iv?.hiPpm);
  if (lo !== null && hi !== null) {
    return lo > 0 || hi < 0
      ? { ...base, points: 10, detail: `The interval ${lo} to ${hi} does not include zero.` }
      : { ...base, points: 0, detail: `The interval ${lo} to ${hi} includes zero.` };
  }
  if (doc.verdict?.status === "NOT_SUPPORTED")
    return {
      ...base,
      points: 10,
      detail: "The verdict is NOT_SUPPORTED under the thesis's own rule: a clear negative result.",
    };
  return {
    ...base,
    points: 0,
    detail: "No interval is recorded for this thesis and the verdict is not a clear NOT_SUPPORTED.",
  };
}

function capsulePart(doc: Doc, counts: StrengthCounts): StrengthPart {
  const base = { key: "capsule_verifies", label: "Capsule verifies", max: 10 };
  if (isRef(doc)) {
    const hashes = Array.isArray(doc.reproduce?.hashes) ? doc.reproduce.hashes.length : 0;
    if (!hashes) return { ...base, points: 0, detail: "The reference thesis lists no file hashes to check." };
    return counts.verified > 0
      ? {
          ...base,
          points: 10,
          detail: `${plural(hashes, "file hash is", "file hashes are")} listed and the bundle has passed verification ${plural(counts.verified, "time", "times")}.`,
        }
      : {
          ...base,
          points: 0,
          detail: `${plural(hashes, "file hash is", "file hashes are")} listed but no verification of the bundle is recorded yet.`,
        };
  }
  const s = doc.verification?.capsule?.status;
  if (s === "reproduced")
    return {
      ...base,
      points: 10,
      detail: "The capsule re-computed the same numbers when the thesis was built.",
    };
  if (s === "mismatch")
    return {
      ...base,
      points: 0,
      detail: "The capsule re-computation did not match when the thesis was built.",
    };
  return { ...base, points: 0, detail: "No capsule verification is recorded in this thesis." };
}

function outlayerPart(doc: Doc): StrengthPart {
  const base = { key: "outlayer_proof", label: "OutLayer proof verified", max: 10 };
  const o = doc.verification?.outlayer;
  if (!o) return { ...base, points: 0, detail: "No OutLayer proof exists for this thesis." };
  if (o.status === "verified")
    return { ...base, points: 10, detail: "An OutLayer proof of the capsule was verified." };
  return { ...base, points: 0, detail: `The OutLayer proof state is ${String(o.status)}, not verified.` };
}

function verifiedPart(counts: StrengthCounts): StrengthPart {
  const base = { key: "independently_verified", label: "Verified by someone", max: 5 };
  return counts.verified > 0
    ? {
        ...base,
        points: 5,
        detail: `Verified ${plural(counts.verified, "time", "times")} (free check of hashes and numbers).`,
      }
    : { ...base, points: 0, detail: "Nobody has verified it yet." };
}

function reproducedPart(counts: StrengthCounts): StrengthPart {
  const base = { key: "reproduced", label: "Reproduced with a match", max: 10 };
  return counts.reproduced > 0
    ? {
        ...base,
        points: 10,
        detail: `Reproduced with a match ${plural(counts.reproduced, "time", "times")}.`,
      }
    : { ...base, points: 0, detail: "No reproduction has matched yet." };
}

const material = (c: StrengthChallenge): boolean => c.notes.some((n) => n.severity === "material");
function challengePart(challenges: StrengthChallenge[]): StrengthPart {
  const base = { key: "challenges_answered", label: "No unanswered material challenge", max: 5 };
  const open = challenges.filter((c) => material(c) && !c.answer);
  if (open.length)
    return {
      ...base,
      points: 0,
      detail: `${plural(open.length, "challenge with material notes has", "challenges with material notes have")} no answer from the owner.`,
    };
  const answered = challenges.filter((c) => material(c)).length;
  if (answered)
    return {
      ...base,
      points: 5,
      detail: `${plural(answered, "challenge with material notes was", "challenges with material notes were")} answered by the owner.`,
    };
  return {
    ...base,
    points: 5,
    detail: challenges.length
      ? "No challenge has raised a material note."
      : "No challenge has been run, so none is unanswered.",
  };
}

export function strengthOf(doc: Doc, counts: StrengthCounts, challenges: StrengthChallenge[]): Strength {
  const parts = [
    planLocked(doc),
    daysOfData(doc),
    coverage(doc),
    validTest(doc),
    intervalPart(doc),
    capsulePart(doc, counts),
    outlayerPart(doc),
    verifiedPart(counts),
    reproducedPart(counts),
    challengePart(challenges),
  ];
  const score = parts.reduce((a, p) => a + p.points, 0);
  return { score, band: bandOf(score), parts };
}
