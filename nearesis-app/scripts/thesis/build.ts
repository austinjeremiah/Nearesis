/**
 * `pnpm thesis:build`: offline, deterministic generator of the thesis bundle (THESIS.md, static dashboard, thesis.json,
 * HASHES.json) from thesis/raw and the frozen v3 research results. No network, no clock, no model: generatedAt is the manifest's
 * frozenAt, every number passes through the grounding Ledger and is re-checked by the scanner before anything is written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson, sha256Hex } from "../../packages/plugin-sdk/src/canonical.ts";
import { buildCharts } from "./charts.ts";
import { buildForecastBundle, ForecastBuildError } from "./build-forecast.ts";
import { Ledger, scanGrounding, scanSentence } from "./ground.ts";
import type { GroundViolation } from "./ground.ts";
import { APP_ROOT, DEFAULT_RESULTS_DIR, DEFAULT_THESIS_DIR, loadInputs } from "./inputs.ts";
import type { Inputs } from "./inputs.ts";
import { buildThesisText, HYPOTHESIS } from "./markdown.ts";
import { renderSite } from "./render-site.ts";
import type { ThesisJson } from "./render-site.ts";
import { validateThesisMarkdown } from "./validate.ts";

export interface BuildOptions {
  thesisDir?: string;
  resultsDir?: string;
}
export interface BuildOutput {
  /** Relative to the build directory. */
  files: Map<string, string>;
  /** Files written relative to the thesis directory (the forecast bundle's raw/forecast.json). */
  extra?: Map<string, string>;
  version: string;
  thesis: ThesisJson;
  numbersChecked: number;
}

export class BuildError extends Error {
  constructor(
    message: string,
    readonly detail: unknown = null,
  ) {
    super(message);
  }
}

const sha = (s: string): string => sha256Hex(s);

function tablesOf(inp: Inputs): ThesisJson["tables"] {
  return inp.manifest.datasets.map((d) => ({
    name: d.id,
    system: /bigquery/i.test(d.source) ? "BigQuery" : /explorer/i.test(d.source) ? "Explorer API" : "local",
    purpose: d.definition,
    columns: d.columns.map((c) => c.name),
  }));
}

/** First fenced sql block of TABLES.md (with the nearest heading as its title); else the first BigQuery SQL file. */
function sampleQueryOf(inp: Inputs): ThesisJson["sampleQuery"] {
  if (inp.tablesMd) {
    const lines = inp.tablesMd.split("\n");
    let title = "Sample query";
    for (let i = 0; i < lines.length; i++) {
      const h = /^#{1,6}\s+(.+)$/.exec(lines[i]!);
      if (h) title = h[1]!.trim();
      if (/^```sql\s*$/i.test(lines[i]!)) {
        const body: string[] = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) body.push(lines[i]!);
        return { title, sql: body.join("\n").trim() };
      }
    }
  }
  const d = inp.manifest.datasets.find((x) => x.sqlBigQuery && inp.sql.has(x.sqlBigQuery));
  if (d) return { title: `${d.title} (BigQuery source)`, sql: inp.sql.get(d.sqlBigQuery!)!.trim() };
  return { title: "No sample query available", sql: "-- none" };
}

/** A thesis directory whose manifest says kind "forecast" is built by build-forecast.ts. */
function isForecastDir(dir: string): boolean {
  const p = join(dir, "raw", "manifest.json");
  return existsSync(p) && (JSON.parse(readFileSync(p, "utf8")) as { kind?: string }).kind === "forecast";
}

export function buildBundle(o: BuildOptions = {}): BuildOutput {
  if (isForecastDir(o.thesisDir ?? DEFAULT_THESIS_DIR)) {
    const r = buildForecastBundle(o.thesisDir ?? DEFAULT_THESIS_DIR);
    return {
      files: r.files,
      extra: r.extra,
      version: r.version,
      thesis: r.thesis as unknown as ThesisJson,
      numbersChecked: r.numbersChecked,
    };
  }
  const inp = loadInputs(o.thesisDir ?? DEFAULT_THESIS_DIR, o.resultsDir ?? DEFAULT_RESULTS_DIR);
  const version = `v-${sha(canonicalJson(inp.files.map((f) => [f.cite, f.sha256]))).slice(0, 12)}`;
  const L = new Ledger(inp.docs);
  const charts = buildCharts(inp, L);
  if (charts.length < 7) throw new BuildError(`expected at least 7 charts, built ${charts.length}`);
  const text = buildThesisText(inp, L, charts, version);

  const violations: GroundViolation[] = [];
  let checked = 0;
  const take = (r: { violations: GroundViolation[]; numbersChecked: number }, where: string): void => {
    checked += r.numbersChecked;
    for (const v of r.violations) violations.push({ ...v, text: `${where}: ${v.text}` });
  };
  take(scanGrounding(text.markdown, L), "THESIS.md");
  for (const c of charts) {
    take(scanSentence(c.sentence, c.sentenceRefs, L), `chart ${c.id} sentence`);
    if (c.evidenceAgainst)
      take(scanSentence(c.evidenceAgainst, c.evidenceAgainstRefs, L), `chart ${c.id} evidenceAgainst`);
  }
  take(scanSentence(text.headline, text.headlineRefs, L), "headline");
  take(scanSentence(text.summary, text.summaryRefs, L), "summary");
  text.whatWouldChangeOurMind.forEach((w, i) => take(scanGrounding(w, L), `whatWouldChangeOurMind ${i}`));
  if (violations.length)
    throw new BuildError(`ungrounded numbers: ${violations.length}`, violations.slice(0, 20));
  const valid = validateThesisMarkdown(text.markdown, text.status);
  if (!valid.ok) throw new BuildError("THESIS.md failed structural validation", valid.failures);

  const mdHash = sha(text.markdown);
  const thesis: ThesisJson = {
    schema: "nearesis.thesis.v1",
    version,
    generatedAt: inp.manifest.frozenAt,
    hypothesis: HYPOTHESIS,
    verdict: {
      status: text.verdictStatus,
      headline: text.headline,
      intentsVsPrice: { summary: text.summary, rows: text.rows },
      whatWouldChangeOurMind: text.whatWouldChangeOurMind,
    },
    sections: text.sections,
    claims: text.claims,
    charts,
    tables: tablesOf(inp),
    sampleQuery: sampleQueryOf(inp),
    unableToCompute: text.unableToCompute,
    reproduce: {
      command: "pnpm thesis:build",
      check: "pnpm thesis:verify",
      hashes: [
        ...inp.files.map((f) => ({ path: f.where, sha256: f.sha256 })),
        { path: "thesis/build/THESIS.md", sha256: mdHash },
      ],
    },
    files: [],
  };
  const site = renderSite(thesis);
  thesis.files = [
    { path: "build/THESIS.md", sha256: mdHash, bytes: Buffer.byteLength(text.markdown) },
    { path: "build/site/index.html", sha256: sha(site), bytes: Buffer.byteLength(site) },
  ];
  const json = `${JSON.stringify({ ...thesis, grounding: { numbersChecked: checked, references: L.entries.size } }, null, 2)}\n`;
  const hashes = `${JSON.stringify(
    {
      schema: "nearesis.thesis.hashes.v1",
      version,
      generatedAt: inp.manifest.frozenAt,
      files: [
        ...thesis.files,
        { path: "build/thesis.json", sha256: sha(json), bytes: Buffer.byteLength(json) },
      ],
      inputs: inp.files.map((f) => ({ path: f.where, sha256: f.sha256 })),
    },
    null,
    2,
  )}\n`;
  const files = new Map<string, string>([
    ["THESIS.md", text.markdown],
    ["site/index.html", site],
    ["thesis.json", json],
    ["HASHES.json", hashes],
  ]);
  return { files, version, thesis, numbersChecked: checked };
}

export function writeBundle(out: BuildOutput, buildDir: string, thesisDir?: string): void {
  for (const [rel, body] of out.files) {
    const p = join(buildDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  if (thesisDir)
    for (const [rel, body] of out.extra ?? []) {
      const p = join(thesisDir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
}

export function summaryLine(out: BuildOutput, buildDir: string): string {
  return JSON.stringify({
    ok: true,
    version: out.version,
    outDir: relative(APP_ROOT, buildDir) || ".",
    numbersChecked: out.numbersChecked,
    hashes: Object.fromEntries([...out.files].map(([rel, body]) => [rel, sha(body)])),
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const dir = arg("dir") ?? arg("thesis");
    const thesisDir = dir ? resolve(dir) : DEFAULT_THESIS_DIR;
    const buildDir = arg("out") ?? join(thesisDir, "build");
    const out = buildBundle({ thesisDir, ...(arg("results") ? { resultsDir: arg("results")! } : {}) });
    writeBundle(out, buildDir, thesisDir);
    console.log(summaryLine(out, buildDir));
  } catch (e) {
    console.error(
      JSON.stringify({
        ok: false,
        error: (e as Error).message,
        detail: e instanceof BuildError || e instanceof ForecastBuildError ? e.detail : null,
      }),
    );
    process.exit(1);
  }
}
