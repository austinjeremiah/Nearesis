import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CapsuleFileEntry, CapsuleManifest } from "@nearesis/contracts";
import { buildCapsule } from "./build.ts";
import type { BuildOptions } from "./build.ts";
import { sha256Hex } from "./canonical.ts";
import { checkPublication } from "./publication.ts";
import { chooseForQuestion, longestShared, planFor } from "./test-plan.ts";
import type { TestPlan, TestRequest } from "./test-plan.ts";

/**
 * Capsule from an automated workspace run.
 *
 * The snapshot holds the run's panel result tables exactly as the panel-data route returned them (one file per panel, each
 * with its sha256), an index of the panels (source ids, metric versions, window, coverage), the run's grounded findings and
 * the derived aligned daily series (`raw/daily_series.csv`) the pinned verifier recomputes. `buildCapsule` does the rest, so
 * the result is an ordinary capsule: local verification, WASM re-run, OutLayer proof and ownership all work unchanged.
 *
 * SERIES RULE (SERIES_RULE, version 1), a pure function of the panel tables:
 *  1. Candidate series: for each panel with a result table, take the first column whose every non-null cell is a calendar day
 *     (`YYYY-MM-DD`, or an ISO midnight timestamp read as that day). The panel must have one row per day, otherwise it is not
 *     a daily series and is skipped. Every other column whose non-null cells are all decimal numbers (JSON numbers or
 *     decimal strings, at least two of them) is a candidate, in panel order then column order. A null cell is a missing day.
 *  2. For every pair of candidates (i < j) find the longest run of strictly consecutive calendar days on which BOTH have a
 *     value. Pairs whose values are identical over that run are skipped (a series against itself says nothing).
 *  3. Pick the pair with the longest run; ties go to the lowest i, then the lowest j. Nothing is filled or dropped inside the
 *     run; days outside it are simply not in the verified window (the index file lists the candidates and their overlaps).
 *     A run longer than 4096 days keeps its latest 4096 days (`truncatedToLatest` in the index says so).
 *  4. Exact scaling: each series is multiplied by 10^p, p = the most decimal places any chosen value has, so every value is
 *     an exact integer. The series unit names the scale. A scaled magnitude above 1e15 is refused.
 *  5. Fewer than two shared days, fewer than two candidates, or an unscalable value: NotCapsulable with the reason.
 *  Metrics: `lag_pearson:7` (when n >= 9), `pearson`, `summary`.
 */
export const SERIES_RULE_VERSION = 1;
export const SERIES_RULE =
  "First pair of daily numeric panel columns (panel order, column order) with the longest run of consecutive shared days having values in both; exact decimal scaling to integers; at most the latest 4096 days.";
export const MAX_POINTS = 4096;
export const MAX_ABS_SCALED = 10n ** 15n;

/** The run cannot honestly become a capsule; `reason` is shown to the user as is. */
export class NotCapsulable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** One panel as the panel-data route returned it (`GET /v1/workspaces/:id/panels/:hash/data`). */
export interface RunPanel {
  hash: string;
  title: string;
  body: Record<string, unknown>;
  /** The column the canvas panel encodes as its (first) y; recorded in the index when known. */
  primaryColumn?: string | null;
}
export interface RunFinding {
  id: string;
  status: string;
  basis?: string;
  kind?: string;
  statement: string;
  facts: Array<{
    value: string;
    unit: string;
    resultRef: { column: string; rowIds: string[]; queryHash: string };
  }>;
}
export interface WorkspaceRunInput {
  workspaceId: string;
  runId: string;
  /** `fixture` runs build a SYNTHETIC capsule; anything else is LIVE. */
  source: string;
  /** Fixed at the run (its last update), so a rebuild is byte-identical. ISO date-time. */
  frozenAt: string;
  /** Short plain-language question of the run (manifest title only). */
  question: string | null;
  panels: RunPanel[];
  findings: RunFinding[];
  /** Explicit pair to test (used instead of the rule); the selection record says who chose it. */
  test?: TestRequest;
  /** Plain text of what the run is about (workspace objective and question), read by the question-matching chooser. */
  chooserText?: string | null;
}

// ---- exact decimals -------------------------------------------------------------------------------------------------
interface Dec {
  neg: boolean;
  int: string;
  frac: string;
}
const DEC = /^-?(0|[1-9]\d*)(\.\d+)?$/;

function parseDecimal(cell: unknown): Dec | null {
  let s: string;
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) return null;
    s = expand(String(cell));
  } else if (typeof cell === "string") s = cell.trim();
  else return null;
  if (!DEC.test(s)) return null;
  const neg = s.startsWith("-");
  const [int, frac = ""] = (neg ? s.slice(1) : s).split(".");
  return { neg, int: int!, frac: frac.replace(/0+$/, "") };
}
/** `1e-7` / `1.5e21` (JavaScript's own printing of a JSON number) -> plain decimal text, exactly. */
function expand(s: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = `${m[2]}${m[3] ?? ""}`;
  const point = m[2]!.length + Number(m[4]);
  const body =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${"0".repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${m[1]}${body}`;
}
/** Exact: value * 10^places as a bigint. `places` is at least the decimal places of `d`. */
export function scaleDecimal(d: Dec | string, places: number): bigint {
  const x = typeof d === "string" ? parseDecimal(d) : d;
  if (!x) throw new Error("not a decimal");
  const v = BigInt(`${x.int}${x.frac.padEnd(places, "0")}`);
  return x.neg ? -v : v;
}
export const decimalPlaces = (cell: string): number => parseDecimal(cell)?.frac.length ?? 0;

// ---- candidate series ------------------------------------------------------------------------------------------------
const DAYCELL = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0+)?Z)?$/;
const DAY_MS = 86_400_000;
const dayNum = (d: string): number => Date.parse(`${d}T00:00:00Z`) / DAY_MS;
const dayStr = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);

export interface Candidate {
  panelHash: string;
  panelTitle: string;
  column: string;
  unit: string | null;
  /** day number -> value as decimal text (nulls are absent). */
  values: Map<number, string>;
}
interface Table {
  columns: Array<{ name: string; unit: string | null }>;
  rows: unknown[][];
}
const tableOf = (body: Record<string, unknown>): Table | null => {
  const c = body.chart as { columns?: unknown; rows?: unknown } | null | undefined;
  if (!c || !Array.isArray(c.columns) || !Array.isArray(c.rows)) return null;
  return c as unknown as Table;
};

/** Index of the first column whose non-null cells are all calendar days (and at least one is present), else -1. */
const dayColumn = (t: Table): number =>
  t.columns.findIndex(
    (_, i) =>
      t.rows.some((r) => r[i] !== null && r[i] !== undefined) &&
      t.rows.every((r) => r[i] === null || (typeof r[i] === "string" && DAYCELL.test(r[i] as string))),
  );

export function candidatesOf(panels: RunPanel[]): { candidates: Candidate[]; skipped: string[] } {
  const candidates: Candidate[] = [];
  const skipped: string[] = [];
  for (const p of panels) {
    const t = tableOf(p.body);
    if (!t) {
      skipped.push(`${p.title}: no result table`);
      continue;
    }
    const ti = dayColumn(t);
    if (ti < 0) {
      skipped.push(`${p.title}: no day column`);
      continue;
    }
    const days = t.rows.map((r) => (r[ti] === null ? null : DAYCELL.exec(r[ti] as string)![1]!));
    const present = days.filter((d): d is string => d !== null);
    if (new Set(present).size !== present.length) {
      skipped.push(`${p.title}: more than one row per day`);
      continue;
    }
    t.columns.forEach((col, ci) => {
      if (ci === ti) return;
      const values = new Map<number, string>();
      let ok = true;
      t.rows.forEach((r, ri) => {
        const cell = r[ci];
        const d = days[ri];
        if (cell === null || cell === undefined || d === null || d === undefined) return;
        const dec = parseDecimal(cell);
        if (!dec) ok = false;
        else
          values.set(
            dayNum(d),
            `${dec.neg && (dec.int !== "0" || dec.frac) ? "-" : ""}${dec.int}${dec.frac ? `.${dec.frac}` : ""}`,
          );
      });
      if (ok && values.size >= 2)
        candidates.push({
          panelHash: p.hash,
          panelTitle: p.title,
          column: col.name,
          unit: col.unit ?? null,
          values,
        });
    });
  }
  return { candidates, skipped };
}

export interface Selection {
  x: Candidate;
  y: Candidate;
  days: number[];
  truncatedToLatest: boolean;
  overlapDays: number;
}

export function pickSeries(panels: RunPanel[]): Selection {
  const { candidates, skipped } = candidatesOf(panels);
  if (candidates.length < 2)
    throw new NotCapsulable(
      `The run has fewer than two daily numeric series in its panels (found ${candidates.length}${skipped.length ? `; skipped: ${skipped.join("; ")}` : ""}).`,
    );
  let best: { i: number; j: number; run: number[] } | null = null;
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length; j++) {
      const run = longestShared(candidates[i]!, candidates[j]!);
      if (run.length === 0) continue;
      if (run.every((d) => candidates[i]!.values.get(d) === candidates[j]!.values.get(d))) continue;
      if (!best || run.length > best.run.length) best = { i, j, run };
    }
  if (!best || best.run.length < 2)
    throw new NotCapsulable(
      `No two daily series in the run share at least two consecutive days with values in both (best overlap: ${best?.run.length ?? 0} day(s)).`,
    );
  const overlapDays = best.run.length;
  const days = overlapDays > MAX_POINTS ? best.run.slice(overlapDays - MAX_POINTS) : best.run;
  return {
    x: candidates[best.i]!,
    y: candidates[best.j]!,
    days,
    truncatedToLatest: overlapDays > MAX_POINTS,
    overlapDays,
  };
}

/** How the pair of a build was chosen. `legacy`: the original longest-overlap rule, which records nothing extra. */
export interface ChosenSeries {
  sel: Selection;
  plan: TestPlan | null;
  chosenBy: "planner" | "user" | "rule" | "legacy";
  namedForQuestion: boolean;
}

/** The pair an explicit test names: its two candidates and the longest run of shared days. */
export function pickExplicit(panels: RunPanel[], t: TestRequest): Selection {
  const { candidates } = candidatesOf(panels);
  const find = (p: { panelHash: string; column: string }) =>
    candidates.find((c) => c.panelHash === p.panelHash && c.column === p.column);
  const x = find(t.x);
  const y = find(t.y);
  if (!x || !y)
    throw new NotCapsulable(
      `TEST_PAIR_NOT_FOUND: the named series ${!x ? t.x.column : t.y.column} is not a daily numeric column of any panel of the run.`,
    );
  if (x === y) throw new NotCapsulable("TEST_PAIR_NOT_FOUND: the two named series are the same series.");
  const run = longestShared(x, y);
  if (run.length < 2)
    throw new NotCapsulable(
      `The two named series share fewer than two consecutive days with values in both (best overlap: ${run.length} day(s)).`,
    );
  const days = run.length > MAX_POINTS ? run.slice(run.length - MAX_POINTS) : run;
  return { x, y, days, truncatedToLatest: run.length > MAX_POINTS, overlapDays: run.length };
}

/** Explicit pair first, then the question-matching chooser, and only then the old rule. */
export function selectSeries(
  input: Pick<WorkspaceRunInput, "panels" | "test" | "chooserText">,
): ChosenSeries {
  if (input.test) {
    const sel = pickExplicit(input.panels, input.test);
    const chosenBy = input.test.chosenBy ?? "user";
    return {
      sel,
      chosenBy,
      namedForQuestion: true,
      plan: planFor(sel.x, sel.y, {
        chosenBy,
        why:
          input.test.why ??
          (chosenBy === "user"
            ? "The pair was named explicitly by the person who asked for the capsule."
            : "The pair was proposed with the hypothesis and validated against the run's real series."),
        ...(input.test.lagDays !== undefined ? { lagDays: input.test.lagDays } : {}),
        ...(input.test.expectedSign ? { expectedSign: input.test.expectedSign } : {}),
        ...(input.test.statement ? { statement: input.test.statement } : {}),
      }),
    };
  }
  const text = (input.chooserText ?? "").trim();
  if (text) {
    const { candidates } = candidatesOf(input.panels);
    const c = chooseForQuestion(candidates, text);
    if (c) {
      const run = longestShared(c.x, c.y);
      const days = run.length > MAX_POINTS ? run.slice(run.length - MAX_POINTS) : run;
      return {
        sel: { x: c.x, y: c.y, days, truncatedToLatest: run.length > MAX_POINTS, overlapDays: run.length },
        chosenBy: "rule",
        namedForQuestion: true,
        plan: planFor(c.x, c.y, { chosenBy: "rule", why: c.why, expectedSign: c.expectedSign }),
      };
    }
  }
  const sel = pickSeries(input.panels);
  return { sel, plan: null, chosenBy: "legacy", namedForQuestion: false };
}

// ---- rounding of long decimals --------------------------------------------------------------------------------------------
export const ROUND_PLACES = 6;
/** Rounds half-even to `places` decimals (exact, on the decimal text). */
export function roundHalfEven(d: Dec, places: number): Dec {
  if (d.frac.length <= places) return d;
  const kept = d.frac.slice(0, places);
  const rest = d.frac.slice(places);
  let up: boolean;
  const half = `5${"0".repeat(rest.length - 1)}`;
  if (rest > half) up = true;
  else if (rest < half) up = false;
  else up = (Number(kept.slice(-1) || d.int.slice(-1)) & 1) === 1;
  let v = BigInt(`${d.int}${kept.padEnd(places, "0")}`);
  if (up) v += 1n;
  const t = v.toString().padStart(places + 1, "0");
  const int = t.slice(0, t.length - places);
  return { neg: d.neg, int, frac: t.slice(t.length - places).replace(/0+$/, "") };
}
const decText = (d: Dec): string =>
  `${d.neg && (d.int !== "0" || d.frac) ? "-" : ""}${d.int}${d.frac ? `.${d.frac}` : ""}`;
const plain = (v: bigint, places: number): string => {
  const neg = v < 0n;
  const t = (neg ? -v : v).toString().padStart(places + 1, "0");
  const int = t.slice(0, t.length - places);
  const frac = t.slice(t.length - places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
};

export interface RoundingRecord {
  decimalsKept: number;
  /** Largest absolute difference between an original value and its rounded value, as an exact decimal. */
  maxAbsRoundingDifference: string;
}
/**
 * Exact integer scaling of one chosen series. Exact when it fits; a series that needs more than six decimal places AND would
 * not fit exactly (above 1e15 after scaling) is rounded half-even to six decimals first, and the rounding is recorded.
 */
export function scaleSeries(
  name: string,
  values: string[],
): { places: number; scaled: bigint[]; rounding: RoundingRecord | null; values: string[] } {
  const exactPlaces = Math.max(...values.map(decimalPlaces));
  const exact = values.map((v) => scaleDecimal(v, exactPlaces));
  const fits = (arr: bigint[]): boolean => arr.every((v) => (v < 0n ? -v : v) <= MAX_ABS_SCALED);
  if (fits(exact)) return { places: exactPlaces, scaled: exact, rounding: null, values };
  const refuse = (): never => {
    throw new NotCapsulable(
      `Column ${name} has a value above 1e15 after exact scaling to integers, which the verifier does not accept; nothing was rounded or capped.`,
    );
  };
  if (exactPlaces <= ROUND_PLACES) return refuse();
  const rounded = values.map((v) => decText(roundHalfEven(parseDecimal(v)!, ROUND_PLACES)));
  const p = Math.max(...rounded.map(decimalPlaces));
  const scaled = rounded.map((v) => scaleDecimal(v, p));
  if (!fits(scaled))
    throw new NotCapsulable(
      `Column ${name} has a value above 1e15 after scaling, even rounded half-even to ${ROUND_PLACES} decimal places; nothing was capped.`,
    );
  let maxDiff = 0n;
  values.forEach((v, i) => {
    const d = exact[i]! - scaleDecimal(rounded[i]!, exactPlaces);
    const a = d < 0n ? -d : d;
    if (a > maxDiff) maxDiff = a;
  });
  return {
    places: p,
    scaled,
    rounding: { decimalsKept: ROUND_PLACES, maxAbsRoundingDifference: plain(maxDiff, exactPlaces) },
    values: rounded,
  };
}

// ---- text helpers ----------------------------------------------------------------------------------------------------
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
/** Printable-ASCII text without digits (the publication check reads every digit in prose as a claim). */
const words = (s: string): string =>
  s
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .replace(/\d/g, (d) => `_${WORDS[Number(d)]}_`)
    .replace(/_+/g, "_")
    .replace(/_$/g, "")
    .replace(/^_/, "");
const nameOf = (c: Candidate, other: Candidate, which: "first" | "second"): string => {
  const n = words(c.column).replace(/[^A-Za-z0-9._:/-]/g, "_") || "series";
  return n === words(other.column).replace(/[^A-Za-z0-9._:/-]/g, "_") ? `${n}_${which}_panel` : n;
};
/** The pinned WASM verifier accepts series names and units of letters, digits and . _ : - / only (units at most 32 characters). */
const WASM_ID = /^[A-Za-z0-9._:/-]{1,32}$/;
const unitOf = (u: string | null, places: number): string => {
  const base =
    (u ?? "unitless")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_")
      .trim() || "unitless";
  // an unscaled unit that the verifier already accepts stays exactly as it was (existing capsules keep their bytes)
  if (places === 0 && WASM_ID.test(base)) return base;
  const id = base.replace(/[^A-Za-z0-9._:/-]+/g, "_").replace(/^_+|_+$/g, "") || "unitless";
  const suffix = places === 0 ? "" : `_x1e${places}`;
  return `${id.slice(0, 32 - suffix.length)}${suffix}`;
};
/** 16 hex digits -> 16 letters (a-p): an id with no digits, so ids in prose never read as numbers. */
const lettersOf = (hex: string): string =>
  [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
/**
 * Id of the capsule of a run. Without an explicit test it is the original id (so capsules built before tests existed keep it);
 * with one, the pair, lag, expected sign and sentence are part of the id, so a different test of the same run is a different capsule.
 */
export const workspaceRunCapsuleId = (
  workspaceId: string,
  runId: string,
  test?: TestRequest | null,
): string => {
  const seed = test
    ? `wsrun:${workspaceId}:${runId}:test:${sha256Hex(
        Buffer.from(
          JSON.stringify([
            test.x.panelHash,
            test.x.column,
            test.y.panelHash,
            test.y.column,
            test.lagDays ?? 0,
            test.expectedSign ?? "either",
            test.statement ?? "",
            test.chosenBy ?? "user",
          ]),
          "utf8",
        ),
      )}`
    : `wsrun:${workspaceId}:${runId}`;
  return `cap-wsrun-${lettersOf(createHash("sha256").update(seed).digest("hex").slice(0, 16))}`;
};

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const get = (o: unknown, ...p: string[]): unknown =>
  p.reduce<unknown>(
    (a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined),
    o,
  );

// ---- snapshot --------------------------------------------------------------------------------------------------------
export interface WorkspaceRunBuild {
  snapshotDir: string;
  capsuleId: string;
  label: "LIVE" | "SYNTHETIC";
  title: string;
  metricVersions: Record<string, string>;
  extraResults: NonNullable<BuildOptions["extraResults"]>;
  extraThesisNotes: string[];
  plan: TestPlan | null;
  selection: {
    x: { name: string; unit: string; points: number; panelHash: string; column: string };
    y: { name: string; unit: string; points: number; panelHash: string; column: string };
    window: { from: string; to: string };
    metrics: string[];
    truncatedToLatest: boolean;
    overlapDays: number;
  };
}

/** Grounded findings -> note lines (each finding restated, citing the cells it cites) plus the results those cells become. */
function notesFrom(findings: RunFinding[], maxResults: number) {
  const results: NonNullable<BuildOptions["extraResults"]> = [];
  const notes: string[] = [];
  let omitted = 0;
  findings.forEach((f, k) => {
    const mine: NonNullable<BuildOptions["extraResults"]> = [];
    f.facts.forEach((fact, m) => {
      const rows = fact.resultRef.rowIds
        .map((r) => (/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(r) ? r : words(r)))
        .join(", ");
      mine.push({
        id: `f${k + 1}-v${m + 1}`,
        label: `Value cited by a finding: ${words(fact.resultRef.column)} at ${rows}`.slice(0, 200),
        value: fact.value.slice(0, 80),
        unit: fact.unit ? words(fact.unit).slice(0, 40) || null : null,
        computation:
          `Result cell of column ${words(fact.resultRef.column)} in panel ${fact.resultRef.queryHash}, exactly as the run's finding cites it`.slice(
            0,
            300,
          ),
      });
    });
    const text = f.statement.replace(/\s+/g, " ").trim();
    const line =
      `[${words(f.basis ?? "finding")}, ${words(f.status)}] ${text} ${mine.map((r) => `[R:${r.id}]`).join("")}`.trimEnd();
    const rowsText = mine
      .map((r) => `| ${r.label} | ${r.value} | ${r.unit ?? ""} | [R:${r.id}] |`)
      .join("\n");
    const ok =
      mine.every((r) => r.value.length > 0) &&
      results.length + mine.length <= maxResults &&
      checkPublication(line, mine).ok &&
      checkPublication(rowsText, mine).ok;
    if (ok) {
      results.push(...mine);
      notes.push(line);
    } else omitted += 1;
  });
  if (omitted > 0)
    notes.push(
      "Some findings of the run are not restated here because their numbers could not be tied to cited result cells under the publication check; they remain in the run record.",
    );
  return { results, notes };
}

/**
 * Writes the snapshot directory for a run and returns what `buildCapsule` needs besides it. Throws NotCapsulable when the
 * run has no two usable daily series. Pure apart from the files written under `dir`.
 */
export function buildWorkspaceRunSnapshot(input: WorkspaceRunInput, dir: string): WorkspaceRunBuild {
  const chosen = selectSeries(input);
  const sel = chosen.sel;
  const xs0 = sel.days.map((d) => sel.x.values.get(d)!);
  const ys0 = sel.days.map((d) => sel.y.values.get(d)!);
  const scX = scaleSeries(sel.x.column, xs0);
  const scY = scaleSeries(sel.y.column, ys0);
  const px = scX.places;
  const py = scY.places;
  const sx = scX.scaled;
  const sy = scY.scaled;
  const nameX = nameOf(sel.x, sel.y, "first");
  const nameY = nameOf(sel.y, sel.x, "second");
  const unitX = unitOf(sel.x.unit, px);
  const unitY = unitOf(sel.y.unit, py);
  const n = sel.days.length;
  const planLag = chosen.plan?.lagDays ?? 0;
  const metrics = [
    ...(n >= 9 ? ["lag_pearson:7"] : []),
    ...(planLag > 0 && planLag !== 7 && planLag <= n - 2 ? [`lag_pearson:${planLag}`] : []),
    "pearson",
    "summary",
  ].sort();
  const from = dayStr(sel.days[0]!);
  const to = dayStr(sel.days[n - 1]!);

  const capsuleId = workspaceRunCapsuleId(input.workspaceId, input.runId, input.test);
  const id = capsuleId.slice("cap-".length);
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const add = (path: string, data: string) => files.push({ path, bytes: Buffer.from(data, "utf8") });
  const csv = `date,x_value,y_value\n${sel.days.map((d, i) => `${dayStr(d)},${sx[i]},${sy[i]}`).join("\n")}\n`;
  add("raw/daily_series.csv", csv);

  const indexPanels = input.panels.map((p) => {
    const text = json(p.body);
    const file = `raw/panels/${p.hash}.json`;
    add(file, text);
    const t = tableOf(p.body);
    const dayCol = t ? dayColumn(t) : -1;
    const days =
      t && dayCol >= 0
        ? t.rows
            .flatMap((r) =>
              typeof r[dayCol] === "string" ? [DAYCELL.exec(r[dayCol] as string)?.[1] ?? ""] : [],
            )
            .filter(Boolean)
            .sort()
        : [];
    return {
      hash: p.hash,
      title: p.title,
      file,
      sha256: sha256Hex(Buffer.from(text, "utf8")),
      kind: get(p.body, "kind") ?? null,
      state: get(p.body, "state") ?? null,
      sources: get(p.body, "provenance", "sources") ?? null,
      sourceSnapshotId: get(p.body, "provenance", "sourceSnapshotId") ?? null,
      metricVersion: get(p.body, "provenance", "semanticVersion") ?? null,
      sourceLabel: get(p.body, "provenance", "sourceLabel") ?? null,
      window: days.length ? { from: days[0]!, to: days[days.length - 1]! } : null,
      coverage: get(p.body, "coverage") ?? null,
      caveats: get(p.body, "caveats") ?? [],
      // only when the run recorded it, so a capsule built without it keeps its bytes
      ...(p.primaryColumn ? { primaryColumn: p.primaryColumn } : {}),
    };
  });
  const { candidates, skipped } = candidatesOf(input.panels);
  add(
    "raw/run-panels.json",
    json({
      schema: "nearesis.workspace-run.v1",
      workspaceId: input.workspaceId,
      runId: input.runId,
      runSource: input.source,
      frozenAt: input.frozenAt,
      panels: indexPanels,
      selection: {
        ruleVersion: SERIES_RULE_VERSION,
        rule: SERIES_RULE,
        x: { panelHash: sel.x.panelHash, column: sel.x.column, unit: sel.x.unit, scalePlaces: px },
        y: { panelHash: sel.y.panelHash, column: sel.y.column, unit: sel.y.unit, scalePlaces: py },
        window: { from, to },
        points: n,
        overlapDays: sel.overlapDays,
        truncatedToLatest: sel.truncatedToLatest,
        candidates: candidates.map((c) => ({
          panelHash: c.panelHash,
          column: c.column,
          days: c.values.size,
        })),
        skippedPanels: skipped,
        // Written only by the explicit-pair and question-matching paths and by rounding, so a capsule chosen by the old rule
        // with exact scaling has exactly the bytes it always had.
        ...(chosen.chosenBy !== "legacy"
          ? { chosenBy: chosen.chosenBy, namedForQuestion: chosen.namedForQuestion, plan: chosen.plan }
          : {}),
        ...(scX.rounding || scY.rounding
          ? {
              rounding: {
                ...(scX.rounding ? { x: scX.rounding } : {}),
                ...(scY.rounding ? { y: scY.rounding } : {}),
                rule: "A series that needs more than six decimal places and does not fit exactly after scaling is rounded half-even to six decimals before scaling.",
              },
            }
          : {}),
      },
    }),
  );
  add("raw/run-findings.json", json(input.findings));

  const label: "LIVE" | "SYNTHETIC" = input.source === "fixture" ? "SYNTHETIC" : "LIVE";
  const descriptor = {
    schema: "nearesis.snapshot.v1" as const,
    snapshotId: id,
    label,
    frozenAt: input.frozenAt,
    dataset:
      label === "LIVE"
        ? "LIVE workspace run: result tables of an automated investigation"
        : "SYNTHETIC fixture workspace run - not NEAR production data",
    claimId: id.replace("wsrun-", "wsrun:"),
    analysisCodeCommit: createHash("sha256")
      .update(`nearesis.workspace-run-capsule.v${SERIES_RULE_VERSION}`)
      .digest("hex")
      .slice(0, 12),
    series: {
      file: "raw/daily_series.csv",
      x: { column: "x_value", name: nameX, unit: unitX },
      y: { column: "y_value", name: nameY, unit: unitY },
    },
    metrics,
    files: files.map((f): CapsuleFileEntry => ({
      path: f.path,
      sha256: sha256Hex(f.bytes),
      bytes: f.bytes.length,
    })),
    kind: "workspace_run" as const,
  };
  for (const f of files) {
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.bytes);
  }
  writeFileSync(join(dir, "snapshot.json"), json(descriptor));

  const metricVersions: Record<string, string> = {};
  for (const p of input.panels) {
    const ver = get(p.body, "provenance", "semanticVersion");
    const fields = get(p.body, "shape", "fields");
    if (get(p.body, "kind") === "semantic" && typeof ver === "string" && Array.isArray(fields))
      for (const f of fields as Array<{ metricId?: string }>)
        if (f.metricId) metricVersions[f.metricId] = ver;
  }
  const { results: extraResults, notes } = notesFrom(input.findings, 80);
  const q = (input.question ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\x20-\x7e]/g, "");
  return {
    snapshotDir: dir,
    capsuleId,
    label,
    title: `${label === "SYNTHETIC" ? "SYNTHETIC: " : ""}Workspace run${q ? `: ${q.slice(0, 200)}` : ""}`,
    metricVersions,
    extraResults,
    extraThesisNotes: notes,
    plan: chosen.plan,
    selection: {
      x: { name: nameX, unit: unitX, points: n, panelHash: sel.x.panelHash, column: sel.x.column },
      y: { name: nameY, unit: unitY, points: n, panelHash: sel.y.panelHash, column: sel.y.column },
      window: { from, to },
      metrics,
      truncatedToLatest: sel.truncatedToLatest,
      overlapDays: sel.overlapDays,
    },
  };
}

/** Snapshot + `buildCapsule` into `outDir` (replaced). The only place a workspace-run capsule is made. */
export function buildWorkspaceRunCapsule(
  input: WorkspaceRunInput,
  outDir: string,
  o: { wasmPath?: string } = {},
): { manifest: CapsuleManifest; build: WorkspaceRunBuild } {
  const tmp = mkdtempSync(join(tmpdir(), "wsrun-snap-"));
  try {
    const build = buildWorkspaceRunSnapshot(input, tmp);
    const manifest = buildCapsule({
      snapshotDir: tmp,
      outDir,
      capsuleId: build.capsuleId,
      title: build.title,
      extraResults: build.extraResults,
      extraThesisNotes: build.extraThesisNotes,
      ...(Object.keys(build.metricVersions).length ? { metricVersions: build.metricVersions } : {}),
      ...(o.wasmPath ? { wasmPath: o.wasmPath } : {}),
    });
    return { manifest, build };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
