import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../../packages/plugin-sdk/src/canonical.ts";
import type { Json } from "./ground.ts";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RESULT_ID = "live-20260505-20261111-live-organic-v3-3ac682146b75";
export const DEFAULT_THESIS_DIR = join(APP_ROOT, "thesis");
export const DEFAULT_RESULTS_DIR = join(APP_ROOT, "docs", "research", "live-results", RESULT_ID);

export const REQUIRED_DATASETS = [
  "intents_volume_daily",
  "intents_swaps_daily",
  "active_accounts_daily",
  "transactions_daily",
  "contract_usage_daily",
  "contract_usage_top",
  "near_price_daily",
] as const;

/** Result files read from the frozen v3 run (all of them feed a number or a sentence). */
export const RESULT_FILES = [
  "run_summary.json",
  "estimates.json",
  "counterevidence.json",
  "robustness_matrix.json",
  "falsification.json",
  "preregistration.json",
  "limitations.json",
  "hypothesis.json",
  "windows.json",
  "inputSnapshot.json",
  "reproduction.json",
  "models.json",
] as const;

export interface ManifestColumn {
  name: string;
  type: string;
}
export interface ManifestDataset {
  id: string;
  title: string;
  unit: string;
  file: string | null;
  sha256: string | null;
  rows: number;
  columns: ManifestColumn[];
  source: string;
  sqlExecuted: string | null;
  sqlBigQuery: string | null;
  bigQueryExecuted: boolean;
  bigQueryBytesBilled: string | null;
  definition: string;
  caveats: string[];
  coverage: { missingDays: string[]; note: string | null };
}
export interface Manifest {
  schema: string;
  frozenAt: string;
  window: { from: string; to: string };
  datasets: ManifestDataset[];
}
export interface RawFile {
  columns: ManifestColumn[];
  rows: (string | null)[][];
}
export interface InputFile {
  /** Path as cited: `raw/x.json`, `results/x.json`, `sql/...`, `TABLES.md`. */
  cite: string;
  /** Repo-relative location for the reader. */
  where: string;
  sha256: string;
}
export interface Inputs {
  manifest: Manifest;
  raw: Map<string, RawFile>;
  results: Map<string, Json>;
  /** Everything cited by pointer, keyed by cite path (raw/manifest.json, raw/<ds>.json, results/<file>). */
  docs: Map<string, Json>;
  sql: Map<string, string>;
  tablesMd: string | null;
  files: InputFile[];
}

const sha = (b: Buffer | string): string =>
  sha256Hex(typeof b === "string" ? Buffer.from(b) : new Uint8Array(b));

export class InputError extends Error {}

/** Reads thesis/raw (verifying each file against the manifest hash), the v3 result files and the SQL text. */
export function loadInputs(
  thesisDir: string,
  resultsDir: string,
  opts: { requireAll?: boolean } = {},
): Inputs {
  const requireAll = opts.requireAll ?? true;
  const files: InputFile[] = [];
  const manifestPath = join(thesisDir, "raw", "manifest.json");
  if (!existsSync(manifestPath)) throw new InputError(`manifest not found: ${manifestPath}`);
  const mBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(mBytes.toString("utf8")) as Manifest;
  if (manifest.schema !== "nearesis.thesis.raw.v1")
    throw new InputError(`unexpected manifest schema ${manifest.schema}`);
  files.push({ cite: "raw/manifest.json", where: "thesis/raw/manifest.json", sha256: sha(mBytes) });
  const docs = new Map<string, Json>([["raw/manifest.json", manifest]]);
  const raw = new Map<string, RawFile>();
  const sql = new Map<string, string>();
  for (const id of REQUIRED_DATASETS) {
    if (requireAll && !manifest.datasets.some((d) => d.id === id))
      throw new InputError(`required dataset missing from manifest: ${id}`);
  }
  for (const d of manifest.datasets) {
    if (d.file) {
      const p = join(thesisDir, d.file);
      if (!existsSync(p)) throw new InputError(`raw file missing: ${d.file}`);
      const b = readFileSync(p);
      const h = sha(b);
      if (d.sha256 && h !== d.sha256)
        throw new InputError(`raw file ${d.file} does not match its manifest sha256`);
      const parsed = JSON.parse(b.toString("utf8")) as RawFile;
      if (!Array.isArray(parsed.rows) || parsed.rows.length !== d.rows)
        throw new InputError(`raw file ${d.file} row count differs from the manifest`);
      raw.set(d.id, parsed);
      docs.set(`raw/${d.id}.json`, parsed);
      files.push({ cite: `raw/${d.id}.json`, where: `thesis/${d.file}`, sha256: h });
    }
    for (const rel of [d.sqlExecuted, d.sqlBigQuery]) {
      if (rel && !sql.has(rel)) {
        const p = join(thesisDir, rel);
        if (!existsSync(p)) throw new InputError(`sql file missing: ${rel}`);
        const b = readFileSync(p);
        sql.set(rel, b.toString("utf8"));
        files.push({ cite: rel, where: `thesis/${rel}`, sha256: sha(b) });
      }
    }
  }
  const results = new Map<string, Json>();
  for (const f of RESULT_FILES) {
    const p = join(resultsDir, f);
    if (!existsSync(p)) throw new InputError(`result file missing: ${f}`);
    const b = readFileSync(p);
    const parsed = JSON.parse(b.toString("utf8")) as Json;
    results.set(f, parsed);
    docs.set(`results/${f}`, parsed);
    files.push({
      cite: `results/${f}`,
      where: `docs/research/live-results/${RESULT_ID}/${f}`,
      sha256: sha(b),
    });
  }
  let tablesMd: string | null = null;
  const tp = join(thesisDir, "TABLES.md");
  if (existsSync(tp)) {
    const b = readFileSync(tp);
    tablesMd = b.toString("utf8");
    files.push({ cite: "TABLES.md", where: "thesis/TABLES.md", sha256: sha(b) });
  }
  files.sort((a, b) => (a.cite < b.cite ? -1 : a.cite > b.cite ? 1 : 0));
  return { manifest, raw, results, docs, sql, tablesMd, files };
}
