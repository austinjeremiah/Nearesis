import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CapsuleManifest } from "@nearesis/contracts";
import type { CapsuleFileEntry } from "@nearesis/contracts";
import { canonicalJson, canonicalSha256, sha256Hex } from "./canonical.ts";
import { checkPublication } from "./publication.ts";
import type { CitableResult } from "./publication.ts";
import { renderPdf } from "./pdf.ts";
import { renderSite } from "./site.ts";
import { deriveVerifierInput, loadSnapshot } from "./snapshot.ts";
import { computeResults, inputDigest, resultsDigest } from "./verifier-ref.ts";

export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEFAULT_WASM = join(APP_ROOT, "services", "outlayer-verifier", "out", "nearesis-verifier.wasm");
/** Mirrors services/research `recorded_method_revision`: a002 runs carry Amendment 002 inference records. */
export function recordedMethodRevision(run: Record<string, unknown>): string {
  const est = run.estimates as Record<string, unknown> | undefined;
  return est && "inferenceSummary" in est ? "a002" : "a001";
}

export const REBUILD_COMMAND_PREFIX = "pnpm --filter @nearesis/capsule research:rebuild --snapshot";

export class PublicationBlockedError extends Error {
  constructor(
    readonly file: string,
    readonly violations: ReturnType<typeof checkPublication>["violations"],
  ) {
    super(`publication check blocked ${file}: ${violations.length} unsupported number(s)`);
  }
}

export interface BuildOptions {
  snapshotDir: string;
  outDir: string;
  /** Directory holding `research_run.json` from services/research (fixture runs are re-executable offline). */
  researchBundleDir?: string;
  wasmPath?: string;
  /** Overrides the capsule id (default `cap-<snapshotId>`); used when a corrected rerun supersedes a capsule. */
  capsuleId?: string;
  /** Semantic metric versions recorded in the manifest. They are part of the capsule hash. */
  metricVersions?: Record<string, string>;
  /** Extra author prose appended to THESIS.md. It is subject to the same publication check as generated text. */
  extraThesisNotes?: string[];
  /** Label shown on the static dashboard when the preregistration order is not honest (`post-hoc registration`). */
  registrationLabel?: string;
}

export const fileEntry = (root: string, rel: string): CapsuleFileEntry => {
  const b = readFileSync(join(root, rel));
  return { path: rel, sha256: sha256Hex(b), bytes: b.length };
};

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p).split("\\").join("/")];
    });
}

function write(root: string, rel: string, data: string | Buffer): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

/** Signed scaled integer string -> decimal with `places` fraction digits (no floats). */
export function scaled(v: string | null, places: number): string | null {
  if (v === null) return null;
  const neg = v.startsWith("-");
  const digits = (neg ? v.slice(1) : v).padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places);
  return `${neg && /[1-9]/.test(digits) ? "-" : ""}${whole}.${frac}`;
}

interface ResultSpec extends CitableResult {
  label: string;
  unit: string | null;
  computation: string;
}

const get = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined),
    o,
  );

export function buildResults(
  results: Record<string, unknown>,
  names: { x: string; y: string },
  research: Record<string, unknown> | null,
  live = false,
): ResultSpec[] {
  const out: ResultSpec[] = [];
  const n = results.n as string;
  out.push({
    id: "n",
    label: "Aligned daily points",
    value: n,
    unit: "days",
    computation: "count of consecutive UTC days present in both series",
  });
  const xg = scaled(get(results, "x", "growth_bps") as string | null, 2);
  const yg = scaled(get(results, "y", "growth_bps") as string | null, 2);
  if (xg !== null)
    out.push({
      id: "x-growth",
      label: `${names.x} change, first to last day`,
      value: xg,
      unit: "percent",
      computation: "round_half_away((last-first)*10000/first) basis points, shown as percent",
    });
  if (yg !== null)
    out.push({
      id: "y-growth",
      label: `${names.y} change, first to last day`,
      value: yg,
      unit: "percent",
      computation: "round_half_away((last-first)*10000/first) basis points, shown as percent",
    });
  if ("pearson_ppm" in results) {
    const p = scaled(results.pearson_ppm as string | null, 6);
    out.push({
      id: "pearson",
      label: "Same-day Pearson correlation",
      value: p ?? "undefined (constant series)",
      unit: "ratio",
      computation: "exact integer Pearson r in parts per million, shown as ratio",
    });
  }
  const lags = (results.lag_pearson_ppm ?? {}) as Record<string, string | null>;
  for (const k of Object.keys(lags).sort((a, b) => Number(a) - Number(b))) {
    out.push({
      id: `lag-${k}-days`,
      label: "Lag in days",
      value: k,
      unit: "days",
      computation: "metric parameter k",
    });
    const p = scaled(lags[k] ?? null, 6);
    out.push({
      id: `lag-${k}-pearson`,
      label: `Pearson correlation of ${names.x} at t with ${names.y} at t+k`,
      value: p ?? "undefined (constant series)",
      unit: "ratio",
      computation: "pearson_ppm(x[t], y[t+k]) in parts per million, shown as ratio",
    });
  }
  if (research) {
    out.push({
      id: "research-status",
      label: "Research run verdict",
      value: String(research.status),
      unit: null,
      computation: "verdict.status from research_run.json",
    });
    const prim = get(research, "estimates", "primary") as Record<string, unknown> | undefined;
    if (prim && typeof prim.delta_mae === "number")
      out.push({
        id: "research-delta-mae",
        label: "Out-of-sample MAE improvement over baseline (primary comparison)",
        value: String(prim.delta_mae),
        unit: "log1p units",
        computation: "estimates.primary.delta_mae from research_run.json",
      });
    if (prim && typeof prim.horizon === "number")
      out.push({
        id: "research-horizon",
        label: "Primary forecast horizon",
        value: String(prim.horizon),
        unit: "days",
        computation: "estimates.primary.horizon from research_run.json",
      });
  }
  const ci = research
    ? (get(research, "estimates", "primary", "delta_mae_ci") as Record<string, unknown> | undefined)
    : undefined;
  if (ci && typeof ci.lo === "number" && typeof ci.hi === "number") {
    out.push({
      id: "research-delta-mae-lo",
      label: "Lower bound of the bootstrap confidence interval for the primary MAE improvement",
      value: String(ci.lo),
      unit: "log1p units",
      computation: "estimates.primary.delta_mae_ci.lo from research_run.json",
    });
    out.push({
      id: "research-delta-mae-hi",
      label: "Upper bound of the bootstrap confidence interval for the primary MAE improvement",
      value: String(ci.hi),
      unit: "log1p units",
      computation: "estimates.primary.delta_mae_ci.hi from research_run.json",
    });
  }
  if (live && research) {
    // Live exploratory run: the numbers the prose needs to state why no claim is made are results too (cited, not typed).
    const prim = get(research, "estimates", "primary") as Record<string, unknown> | undefined;
    const minOrigins = get(research, "preregistration", "thresholds", "minDevOrigins");
    const add = (id: string, label: string, v: unknown, unit: string | null, computation: string) => {
      if (typeof v === "number") out.push({ id, label, value: String(v), unit, computation });
    };
    add(
      "research-n-origins",
      "Scored development origins in the primary comparison",
      prim?.n_origins,
      "origins",
      "estimates.primary.n_origins from research_run.json",
    );
    add(
      "research-min-origins",
      "Preregistered minimum of scored development origins",
      minOrigins,
      "origins",
      "preregistration.thresholds.minDevOrigins from research_run.json",
    );
    add(
      "research-mae-baseline",
      "Baseline out-of-sample MAE (primary comparison)",
      prim?.mae_baseline,
      "log1p units",
      "estimates.primary.mae_baseline from research_run.json",
    );
    add(
      "research-mae-candidate",
      "Candidate (with lagged Intents volume) out-of-sample MAE (primary comparison)",
      prim?.mae_candidate,
      "log1p units",
      "estimates.primary.mae_candidate from research_run.json",
    );
  }
  return out;
}

interface ClaimSpec {
  id: string;
  text: string;
  claimClass: "observed_fact" | "derived_statistic" | "agent_interpretation" | "hypothesis" | "unsupported";
  resultIds: string[];
}

export function buildClaims(
  results: ResultSpec[],
  first: string,
  last: string,
  names: { x: string; y: string },
  research: Record<string, unknown> | null,
  live = false,
): ClaimSpec[] {
  const v = (id: string): string | undefined => results.find((r) => r.id === id)?.value;
  const claims: ClaimSpec[] = [
    {
      id: "c-coverage",
      claimClass: "observed_fact",
      resultIds: ["n"],
      text: `Both series cover ${v("n")} consecutive days from ${first} to ${last}.`,
    },
  ];
  if (v("x-growth") !== undefined && v("y-growth") !== undefined)
    claims.push({
      id: "c-growth",
      claimClass: "derived_statistic",
      resultIds: ["x-growth", "y-growth"],
      text: `${names.x} changed by ${v("x-growth")}% and ${names.y} by ${v("y-growth")}% from the first to the last day.`,
    });
  if (v("pearson") !== undefined)
    claims.push({
      id: "c-corr",
      claimClass: "derived_statistic",
      resultIds: ["pearson"],
      text: `The same-day Pearson correlation between the two series is ${v("pearson")}.`,
    });
  for (const r of results.filter((x) => /^lag-\d+-days$/.test(x.id))) {
    const k = r.id.split("-")[1]!;
    claims.push({
      id: `c-lag-${k}`,
      claimClass: "derived_statistic",
      resultIds: [r.id, `lag-${k}-pearson`],
      text: `With a lag of ${r.value} days, the correlation of ${names.x} with ${names.y} is ${v(`lag-${k}-pearson`)}.`,
    });
  }
  if (research) {
    // Amendment 002: an observed lower forecast error is not a statistical-significance claim. When the research run
    // carries an inference summary that does not support the primary claim, the thesis says so explicitly.
    const inferenceSummary = get(research, "estimates", "inferenceSummary") as
      Record<string, unknown> | undefined;
    const significanceNote =
      inferenceSummary && inferenceSummary.primaryStatisticalClaim !== "supported"
        ? " Statistical significance is not claimed: the forecast-comparison inference is not validated for this comparison, so lower observed error is not evidence of a meaningful difference."
        : "";
    claims.push({
      id: "c-hypothesis",
      claimClass: "hypothesis",
      resultIds: ["research-status"],
      text: live
        ? `Hypothesis that ${names.x} improves forecasts of the target beyond a baseline: the research run verdict is ${v("research-status")}, exploratory. Only ${v("research-n-origins")} scored development origins are available against a preregistered minimum of ${v("research-min-origins")}, so no conclusion is drawn; the registration is post-hoc and the forecast comparison is METHOD_NOT_VALIDATED.${significanceNote}`
        : `Pre-registered hypothesis that ${names.x} improves forecasts of the target beyond a baseline: the research run verdict is ${v("research-status")}. This is a fixture run and makes no live claim.${significanceNote}`,
      ...(live ? { resultIds: ["research-status", "research-n-origins", "research-min-origins"] } : {}),
    });
  }
  claims.push({
    id: "c-no-causal",
    claimClass: "agent_interpretation",
    resultIds: [],
    text: "A correlation in these series does not establish that one series causes the other.",
  });
  return claims;
}

function limitationsFor(label: string, hasResearch: boolean): string[] {
  const l = [
    "Local verification recomputes the metrics with this repository's code from the frozen raw bytes. It is not an OutLayer attestation.",
    "No OutLayer job has been executed for this capsule, so its OutLayer status is not submitted. A capsule is shown as OutLayer verified only when attestation evidence passes the proof policy with a quote verifier.",
    "Pearson correlation measures linear association between two daily series. It says nothing about causation, and a single window can mislead.",
    "All metrics are exact scaled integers rounded half away from zero. Values shown as decimals are a rendering of those integers.",
    "Missing days are not zero and are never filled: the computation rejects a series with a date gap.",
  ];
  if (label === "SYNTHETIC")
    l.unshift(
      "This capsule is built on SYNTHETIC data. No statement in it describes NEAR production activity.",
    );
  if (hasResearch && label === "LIVE")
    l.push(
      "LIVE exploratory capsule: the research verdict is INSUFFICIENT_DATA, so it supports no conclusion about Intents and organic NEAR activity. The registration is post-hoc (frozen fixture-evaluation parameters applied unchanged to a live window) and the forecast comparisons are METHOD_NOT_VALIDATED because every candidate model nests the baseline. No statistical significance is claimed anywhere in this capsule.",
      "Pearson correlations here are descriptive statistics of two daily level series; they are not forecasting evidence and not causal. Private Intents settlement after the regime change is unobserved, not zero. The research run is a recorded run (checked by file hash), re-run from the pinned snapshot by the research engine.",
    );
  else if (hasResearch)
    l.push(
      "The research run is re-executed offline from its seed when it is a fixture run; its own limitations are listed in research_run.json.",
    );
  return l;
}

const cite = (ids: string[]): string => ids.map((i) => `[R:${i}]`).join("");
const classTag = (c: string): string => `[${c.replace(/_/g, " ")}]`;

export function buildCapsule(opts: BuildOptions): CapsuleManifest {
  const { descriptor, raw } = loadSnapshot(opts.snapshotDir);
  const out = opts.outDir;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // 1. frozen snapshot, byte for byte
  write(out, "snapshot/snapshot.json", readFileSync(join(opts.snapshotDir, "snapshot.json")));
  for (const f of descriptor.files) write(out, `snapshot/${f.path}`, raw.get(f.path)!);

  // 2. deterministic computation
  const input = deriveVerifierInput(descriptor, raw.get(descriptor.series.file)!);
  const results = computeResults(input);
  write(out, "computation/verifier-input.json", `${canonicalJson(input)}\n`);
  write(out, "computation/results.json", `${canonicalJson(results)}\n`);

  // 3. optional research run (copied, hashed; fixture runs re-executable offline)
  let research: Record<string, unknown> | null = null;
  let researchMeta: CapsuleManifest["research"] = null;
  if (opts.researchBundleDir) {
    const src = join(opts.researchBundleDir, "research_run.json");
    research = JSON.parse(readFileSync(src, "utf8")) as Record<string, unknown>;
    write(out, "research/research_run.json", readFileSync(src));
    const source = get(research, "inputSnapshot", "source") as Record<string, unknown> | undefined;
    const fixture = typeof source?.fixture === "string" ? source.fixture : null;
    researchMeta = {
      runFile: fileEntry(out, "research/research_run.json"),
      reproduce: fixture ? "fixture" : "recorded",
      fixture,
      seed: Number.isInteger(get(research, "reproduction", "seed"))
        ? (get(research, "reproduction", "seed") as number)
        : null,
      preregistrationHash:
        (get(research, "preregistration", "hash") as `sha256:${string}` | undefined) ?? null,
      ...(typeof research.methodVersion === "string" ? { methodVersion: research.methodVersion } : {}),
      methodRevision: recordedMethodRevision(research),
    };
  }

  // 4. claims, results, publication
  const names = { x: descriptor.series.x.name, y: descriptor.series.y.name };
  const isLive = descriptor.label === "LIVE";
  const rs = buildResults(results, names, research, isLive);
  const first = input.series.x.points[0]![0];
  const last = input.series.x.points[input.series.x.points.length - 1]![0];
  const claims = buildClaims(rs, first, last, names, research, isLive);
  const limitations = limitationsFor(descriptor.label, research !== null);
  const wasmPath = opts.wasmPath ?? DEFAULT_WASM;
  const wasmSha = existsSync(wasmPath) ? sha256Hex(readFileSync(wasmPath)) : null;
  const dataHash = sha256Hex(
    descriptor.files
      .map((f) => `${f.path}:${f.sha256}`)
      .sort()
      .join("\n"),
  );
  const rebuildCommand = `${REBUILD_COMMAND_PREFIX} <path-to-frozen-snapshot> --out <dir>`;
  const metricLines = [
    `verifier: nearesis-verifier (exact integer arithmetic, canonical JSON digests)`,
    ...descriptor.metrics.map((m) => `metric: ${m}`),
    `series x: ${descriptor.series.x.name} (${descriptor.series.x.unit}), column ${descriptor.series.x.column}`,
    `series y: ${descriptor.series.y.name} (${descriptor.series.y.unit}), column ${descriptor.series.y.column}`,
  ];

  const thesis = [
    `# ${descriptor.label === "SYNTHETIC" ? "SYNTHETIC: " : ""}Thesis: ${descriptor.claimId}`,
    "",
    ...(descriptor.label === "SYNTHETIC"
      ? ["> SYNTHETIC DATA. This is a test fixture, not NEAR production activity.", ""]
      : []),
    ...(isLive
      ? [
          "> LIVE DATA, EXPLORATORY. The research verdict is INSUFFICIENT_DATA and the forecast comparisons are METHOD_NOT_VALIDATED. Nothing here is a finding of significance.",
          "",
        ]
      : []),
    "## Claims",
    "",
    ...claims.map((c) => `- ${classTag(c.claimClass)} ${c.text} ${cite(c.resultIds)}`.trimEnd()),
    "",
    "## Computed results",
    "",
    "| Result | Value | Unit | Citation |",
    "| --- | --- | --- | --- |",
    ...rs.map((r) => `| ${r.label} | ${r.value} | ${r.unit ?? ""} | ${cite([r.id])} |`),
  ];
  const notes = opts.extraThesisNotes ?? [];
  const thesisMd = `${[...thesis, ...(notes.length ? ["", "## Notes", "", ...notes.map((n) => `- ${n}`)] : [])].join("\n")}\n`;
  const dataMd = `${[
    "# Data",
    "",
    `Snapshot: ${descriptor.snapshotId} (${descriptor.label}). Dataset: ${descriptor.dataset}.`,
    `Frozen at ${descriptor.frozenAt}. The series has ${rs[0]!.value} daily points ${cite(["n"])}.`,
    "",
    "## Raw files",
    "",
    ...descriptor.files.map((f) => `- \`${f.path}\` sha256 ${f.sha256}`),
    "",
    `Raw data hash: ${dataHash}`,
    "",
    "## Queries and computation",
    "",
    "```",
    ...metricLines,
    "```",
    "",
    "## Rebuild",
    "",
    "```",
    rebuildCommand,
    "```",
  ].join("\n")}\n`;
  const limitMd = `${["# Limitations", "", ...limitations.map((l) => `- ${l}`)].join("\n")}\n`;

  const memoText = [thesisMd, limitMd]
    .join("\n")
    .split("\n")
    .map((l) =>
      l
        .replace(/^#+\s*/, "")
        .replace(/[*`>]/g, "")
        .replace(/\s*\|\s*/g, "  ")
        .trim(),
    );
  const checks: Array<[string, string]> = [
    ["THESIS.md", thesisMd],
    ["DATA.md", dataMd],
    ["LIMITATIONS.md", limitMd],
    ["memo.pdf", memoText.join("\n")],
  ];
  for (const [file, text] of checks) {
    const c = checkPublication(text, rs);
    if (!c.ok) throw new PublicationBlockedError(file, c.violations);
  }

  write(out, "exports/THESIS.md", thesisMd);
  write(out, "exports/DATA.md", dataMd);
  write(out, "exports/LIMITATIONS.md", limitMd);
  write(out, "exports/memo.pdf", renderPdf(`Research memo: ${descriptor.claimId}`, memoText));

  const partial = {
    title: `${descriptor.label === "SYNTHETIC" ? "SYNTHETIC: " : ""}${descriptor.claimId}`,
    label: descriptor.label,
    claims,
    results: rs.map(({ id, label, value, unit, computation }) => ({ id, label, value, unit, computation })),
    limitations,
    snapshot: { snapshotId: descriptor.snapshotId, files: [] as CapsuleFileEntry[], dataHash },
    computation: { inputSha256: inputDigest(input), resultsSha256: resultsDigest(results) },
  };
  write(
    out,
    "exports/site/index.html",
    renderSite({
      manifestLike: partial as never,
      series: { x: input.series.x, y: input.series.y },
      thesisLines: claims.map((c) => ({
        claimId: c.id,
        claimClass: c.claimClass,
        text: c.text,
        cites: c.resultIds,
      })),
      rebuildCommand,
      dataLines: metricLines,
      ...(opts.registrationLabel ? { registrationLabel: opts.registrationLabel } : {}),
    }),
  );

  // 5. manifest (capsuleHash last)
  const snapshotFiles = ["snapshot/snapshot.json", ...descriptor.files.map((f) => `snapshot/${f.path}`)].map(
    (p) => fileEntry(out, p),
  );
  const pubFiles = [
    "exports/THESIS.md",
    "exports/DATA.md",
    "exports/LIMITATIONS.md",
    "exports/memo.pdf",
    "exports/site/index.html",
  ].map((p) => fileEntry(out, p));
  const resultManifestHash = canonicalSha256(partial.results);
  const body = {
    schemaVersion: "nearesis.capsule.v1" as const,
    capsuleId: opts.capsuleId ?? `cap-${descriptor.snapshotId}`,
    title: partial.title,
    label: descriptor.label,
    createdAt: descriptor.frozenAt,
    snapshot: { snapshotId: descriptor.snapshotId, files: snapshotFiles, dataHash },
    computation: {
      verifier: { name: "nearesis-verifier@0.1.0", wasmSha256: wasmSha },
      metrics: descriptor.metrics,
      inputFile: fileEntry(out, "computation/verifier-input.json"),
      resultsFile: fileEntry(out, "computation/results.json"),
      inputSha256: partial.computation.inputSha256,
      resultsSha256: partial.computation.resultsSha256,
    },
    research: researchMeta,
    claims,
    results: partial.results,
    publication: { files: pubFiles },
    hashes: {
      preregistrationHash: researchMeta?.preregistrationHash
        ? researchMeta.preregistrationHash.slice("sha256:".length)
        : null,
      sourceSnapshotHash: dataHash,
      semanticModelHash: canonicalSha256({
        verifier: "nearesis-verifier@0.1.0",
        metrics: descriptor.metrics,
        series: descriptor.series,
      }),
      analysisCodeCommit: descriptor.analysisCodeCommit,
      containerDigest: null,
      resultManifestHash,
    },
    limitations,
    ...(opts.metricVersions ? { metricVersions: opts.metricVersions } : {}),
    attestation: {
      status: "unverified" as const,
      evidenceSource: null,
      jobId: null,
      reason: "No OutLayer job has been submitted for this capsule.",
    },
    chainCommitment: isLive
      ? {
          status: "unverified" as const,
          network: null,
          txHash: null,
          reason:
            "The capsule hash cannot contain its own commitment: a testnet hash commitment, when made, is recorded beside the publish manifest.",
        }
      : {
          status: "blocked" as const,
          network: null,
          txHash: null,
          reason:
            "No chain commitment was made: signing and chain writes are not permitted in this build (BLK-20261110-003).",
        },
  };
  const manifest = CapsuleManifest.parse({ ...body, capsuleHash: canonicalSha256(body) });
  write(out, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export { listFiles, copyFileSync };
