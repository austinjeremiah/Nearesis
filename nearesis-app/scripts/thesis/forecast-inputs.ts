import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../../packages/plugin-sdk/src/canonical.ts";
import { eachDay } from "./data-lib.ts";
import { FEE_BINDINGS, TOP_PAYERS_ID } from "./fees-bindings.ts";
import type { SeriesInput, Transform } from "./forecast.ts";
import type { Json } from "./ground.ts";
import type { InputFile, Manifest, ManifestDataset, RawFile } from "./inputs.ts";

export interface ForecastManifest extends Manifest {
  kind: "forecast";
  methodFrozenAt: string;
  headThreshold: number;
  stablecoinSet: string[];
  nearTokenSymbols: string[];
  internalChecks: { organicEqualsHeadPlusTail: { days: number; daysEqual: number; daysDifferent: string[] } };
  crossChecks: Array<{
    id: string;
    local: string;
    bigquery: string;
    daysLocal: number;
    daysBigQuery: number;
    daysCompared: number;
    daysEqual: number;
    maxAbsDiff: number;
    maxAbsDiffDay: string | null;
  }>;
  bigQueryQueries: Array<{
    id: string;
    title: string;
    sqlBigQuery: string;
    executed: boolean;
    executedAt: string | null;
    jobId: string | null;
    dryRunBytes: number | null;
    bytesBilled: number | null;
    rows: number | null;
    resultFile: string | null;
    resultSha256: string | null;
  }>;
}
export interface SeriesMeta {
  id: string;
  label: string;
  unit: string;
  transform: Transform;
  /** dataset id and column the series is read from, for the query shown with its chart */
  from: string;
  /** "core" series come from the frozen local data; "fees" series from thesis/raw/fees */
  group: "core" | "fees" | "derived";
}
export interface FeesState {
  present: boolean;
  manifest: Manifest | null;
  datasets: Map<string, RawFile>;
  /** series id -> why it is missing */
  missing: { id: string; why: string }[];
  topPayers: {
    id: string;
    file: string;
    nameCol: number;
    valueCol: number;
    names: string[];
    values: string[];
  } | null;
}
export interface ForecastInputs {
  manifest: ForecastManifest;
  raw: Map<string, RawFile>;
  docs: Map<string, Json>;
  sql: Map<string, string>;
  tablesMd: string | null;
  interpretation: string | null;
  files: InputFile[];
  days: string[];
  series: SeriesInput[];
  meta: Map<string, SeriesMeta>;
  fees: FeesState;
  archive: { path: string; thesis: Json } | null;
}

const sha = (b: Buffer): string => sha256Hex(new Uint8Array(b));
export class ForecastInputError extends Error {}

export const colIndex = (r: RawFile, name: string): number => r.columns.findIndex((c) => c.name === name);
export function columnMap(r: RawFile, name: string): Map<string, number | null> {
  const i = colIndex(r, name);
  if (i < 0) throw new ForecastInputError(`column ${name} not found`);
  return new Map(
    r.rows.map((row) => {
      const v = row[i];
      return [String(row[0]), v === null || v === undefined || v === "" ? null : Number(v)] as const;
    }),
  );
}
const align = (days: string[], m: Map<string, number | null>): (number | null)[] =>
  days.map((d) => (m.has(d) ? (m.get(d) as number | null) : null));

function readRaw(thesisDir: string, rel: string, files: InputFile[], cite: string, expected?: string | null) {
  const p = join(thesisDir, rel);
  if (!existsSync(p)) throw new ForecastInputError(`raw file missing: ${rel}`);
  const b = readFileSync(p);
  const h = sha(b);
  if (expected && h !== expected)
    throw new ForecastInputError(`raw file ${rel} does not match its manifest sha256`);
  files.push({ cite, where: `thesis/${rel}`, sha256: h });
  return JSON.parse(b.toString("utf8")) as RawFile;
}

export function loadForecastInputs(thesisDir: string): ForecastInputs {
  const files: InputFile[] = [];
  const manifestPath = join(thesisDir, "raw", "manifest.json");
  if (!existsSync(manifestPath)) throw new ForecastInputError(`manifest not found: ${manifestPath}`);
  const mBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(mBytes.toString("utf8")) as ForecastManifest;
  if (manifest.schema !== "nearesis.thesis.raw.v1" || manifest.kind !== "forecast")
    throw new ForecastInputError("not a forecast thesis manifest");
  files.push({ cite: "raw/manifest.json", where: "thesis/raw/manifest.json", sha256: sha(mBytes) });
  const docs = new Map<string, Json>([["raw/manifest.json", manifest]]);
  const raw = new Map<string, RawFile>();
  const sql = new Map<string, string>();
  for (const d of manifest.datasets) {
    const parsed = readRaw(thesisDir, d.file!, files, `raw/${d.id}.json`, d.sha256);
    if (parsed.rows.length !== d.rows)
      throw new ForecastInputError(`raw file ${d.file} row count differs from the manifest`);
    raw.set(d.id, parsed);
    docs.set(`raw/${d.id}.json`, parsed);
    for (const rel of [d.sqlExecuted, d.sqlBigQuery]) {
      if (rel && !sql.has(rel)) {
        const p = join(thesisDir, rel);
        if (!existsSync(p)) throw new ForecastInputError(`sql file missing: ${rel}`);
        const b = readFileSync(p);
        sql.set(rel, b.toString("utf8"));
        files.push({ cite: rel, where: `thesis/${rel}`, sha256: sha(b) });
      }
    }
  }
  for (const q of manifest.bigQueryQueries) {
    if (q.resultFile) {
      const p = join(thesisDir, q.resultFile);
      if (existsSync(p)) {
        const b = readFileSync(p);
        if (q.resultSha256 && sha(b) !== q.resultSha256)
          throw new ForecastInputError(`BigQuery result ${q.resultFile} does not match its recorded sha256`);
        files.push({ cite: q.resultFile, where: `thesis/${q.resultFile}`, sha256: sha(b) });
      }
    }
    if (!sql.has(q.sqlBigQuery) && existsSync(join(thesisDir, q.sqlBigQuery))) {
      const b = readFileSync(join(thesisDir, q.sqlBigQuery));
      sql.set(q.sqlBigQuery, b.toString("utf8"));
      files.push({ cite: q.sqlBigQuery, where: `thesis/${q.sqlBigQuery}`, sha256: sha(b) });
    }
  }
  const text = (rel: string, cite: string): string | null => {
    const p = join(thesisDir, rel);
    if (!existsSync(p)) return null;
    const b = readFileSync(p);
    files.push({ cite, where: `thesis/${rel}`, sha256: sha(b) });
    return b.toString("utf8");
  };
  const tablesMd = text("TABLES.md", "TABLES.md");
  const interpretation = text("interpretation.md", "interpretation.md");

  // ---- the archived previous version (its verdict is cited under "Changes since previous version") --------------------
  let archive: ForecastInputs["archive"] = null;
  const ap = "archive/intents-vs-price-v1/build/thesis.json";
  if (existsSync(join(thesisDir, ap))) {
    const b = readFileSync(join(thesisDir, ap));
    const parsed = JSON.parse(b.toString("utf8")) as Json;
    files.push({ cite: "archive/thesis.json", where: `thesis/${ap}`, sha256: sha(b) });
    docs.set("archive/thesis.json", parsed);
    archive = { path: "thesis/archive/intents-vs-price-v1", thesis: parsed };
  }

  // ---- the fee inputs, when they exist ------------------------------------------------------------------------------------
  const fees: FeesState = {
    present: false,
    manifest: null,
    datasets: new Map(),
    missing: [],
    topPayers: null,
  };
  const fm = join(thesisDir, "raw", "fees", "manifest.json");
  if (existsSync(fm)) {
    const b = readFileSync(fm);
    const feesManifest = JSON.parse(b.toString("utf8")) as Manifest;
    files.push({ cite: "raw/fees/manifest.json", where: "thesis/raw/fees/manifest.json", sha256: sha(b) });
    docs.set("raw/fees/manifest.json", feesManifest);
    fees.present = true;
    fees.manifest = feesManifest;
    for (const d of feesManifest.datasets as ManifestDataset[]) {
      if (!d.file) continue;
      const cands = [d.file, join("raw", "fees", d.file), join("raw", "fees", d.file.split("/").pop()!)];
      const rel = cands.find((c) => existsSync(join(thesisDir, c)));
      if (!rel) throw new ForecastInputError(`fee raw file missing: ${d.file}`);
      const parsed = readRaw(thesisDir, rel, files, `raw/fees/${d.id}.json`, d.sha256);
      fees.datasets.set(d.id, parsed);
      docs.set(`raw/fees/${d.id}.json`, parsed);
    }
    for (const n of ["FEE_MODEL.md", "NOTES.md"]) {
      const p = join(thesisDir, "raw", "fees", n);
      if (existsSync(p))
        files.push({ cite: `raw/fees/${n}`, where: `thesis/raw/fees/${n}`, sha256: sha(readFileSync(p)) });
    }
  }
  files.sort((a, b) => (a.cite < b.cite ? -1 : a.cite > b.cite ? 1 : 0));

  // ---- series --------------------------------------------------------------------------------------------------------------
  const days = eachDay(manifest.window.from, manifest.window.to);
  const series: SeriesInput[] = [];
  const meta = new Map<string, SeriesMeta>();
  const add = (m: SeriesMeta, values: (number | null)[]): void => {
    series.push({ id: m.id, label: m.label, unit: m.unit, transform: m.transform, days, values });
    meta.set(m.id, m);
  };
  const get = (id: string): RawFile => {
    const r = raw.get(id);
    if (!r) throw new ForecastInputError(`dataset missing: ${id}`);
    return r;
  };
  const col = (id: string, name: string): (number | null)[] => align(days, columnMap(get(id), name));
  const core = (
    id: string,
    label: string,
    unit: string,
    transform: Transform,
    from: string,
    c: string,
  ): (number | null)[] => {
    const v = col(from, c);
    add({ id, label, unit, transform, from, group: "core" }, v);
    return v;
  };
  const f1 = core(
    "intents_tx",
    "F1 Intents transactions per day",
    "transactions",
    "log1p",
    "intents_tx_daily",
    "value",
  );
  core(
    "tail_tx",
    "F2 long-tail organic transactions per day",
    "transactions",
    "log1p",
    "tail_daily",
    "tail_tx",
  );
  const f3 = core(
    "tail_signers",
    "F3 long-tail signers per day",
    "accounts",
    "log1p",
    "tail_daily",
    "tail_signers",
  );
  void f1;
  const f4 = core(
    "intents_usd",
    "F4 Intents settled volume per day",
    "USD",
    "log1p",
    "intents_volume_daily",
    "value",
  );
  core(
    "stable_share",
    "F5 stable-to-stable share of settled volume",
    "share of USD volume",
    "logit",
    "intents_mix_daily",
    "stable_share",
  );
  core(
    "no_near_share",
    "F6 share of settled volume touching no NEAR-chain asset",
    "share of USD volume",
    "logit",
    "intents_mix_daily",
    "no_near_share",
  );
  core(
    "near_token_share",
    "F7 share of settled volume with a NEAR-token leg",
    "share of USD volume",
    "logit",
    "intents_mix_daily",
    "near_token_share",
  );
  add(
    {
      id: "usd_per_tail_signer",
      label: "F8 settled volume per long-tail signer per day",
      unit: "USD per signer",
      transform: "log1p",
      from: "intents_volume_daily",
      group: "derived",
    },
    days.map((_, i) => (f4[i] !== null && f3[i] !== null && f3[i]! > 0 ? f4[i]! / f3[i]! : null)),
  );

  // ---- fee series ------------------------------------------------------------------------------------------------------------
  if (fees.present) {
    for (const b of FEE_BINDINGS) {
      let found: { ds: string; r: RawFile; name: string } | null = null;
      for (const [ds, r] of fees.datasets)
        for (const want of b.columns) {
          const name = r.columns.find((c) => c.name.toLowerCase() === want)?.name;
          if (name && !found) found = { ds, r, name };
        }
      if (!found) {
        fees.missing.push({ id: b.id, why: `no column named ${b.columns.join(", ")} in the fee datasets` });
        continue;
      }
      add(
        {
          id: b.id,
          label: b.label,
          unit: b.unit,
          transform: b.transform,
          from: `fees/${found.ds}`,
          group: "fees",
        },
        align(days, columnMap(found.r, found.name)),
      );
    }
    // share of burn: derived from the two burn series when no direct column exists
    if (!meta.has("intents_burn_share") && meta.has("intents_burn_near") && meta.has("total_burn_near")) {
      const a = series.find((s) => s.id === "intents_burn_near")!.values;
      const t = series.find((s) => s.id === "total_burn_near")!.values;
      const i = fees.missing.findIndex((m) => m.id === "intents_burn_share");
      if (i >= 0) fees.missing.splice(i, 1);
      add(
        {
          id: "intents_burn_share",
          label: "Intents' share of all NEAR burnt",
          unit: "share of NEAR burnt",
          transform: "logit",
          from: "fees/derived",
          group: "derived",
        },
        days.map((_, k) => (a[k] !== null && t[k] !== null && t[k]! > 0 ? a[k]! / t[k]! : null)),
      );
    }
    for (const [ds, r] of fees.datasets) {
      if (!TOP_PAYERS_ID.test(ds) || fees.topPayers) continue;
      const strCol = r.columns.findIndex((c) => c.type === "string");
      const numCol = r.columns.findIndex((c, i) => i !== strCol && c.type !== "date" && c.type !== "string");
      if (strCol >= 0 && numCol >= 0)
        fees.topPayers = {
          id: ds,
          file: `raw/fees/${ds}.json`,
          nameCol: strCol,
          valueCol: numCol,
          names: r.rows.map((x) => String(x[strCol])),
          values: r.rows.map((x) => String(x[numCol])),
        };
    }
  } else {
    for (const b of FEE_BINDINGS)
      fees.missing.push({ id: b.id, why: "thesis/raw/fees/manifest.json does not exist yet" });
  }
  void docs;
  return { manifest, raw, docs, sql, tablesMd, interpretation, files, days, series, meta, fees, archive };
}
