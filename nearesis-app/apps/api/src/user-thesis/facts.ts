import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest } from "@nearesis/capsule";
import type { TestPlan } from "@nearesis/capsule";

/** Everything a thesis reads from a stored capsule: its own files only (the frozen panel results, findings, verifier input and results). */
export interface PanelIndexEntry {
  hash: string;
  title: string;
  file: string;
  sha256: string;
  kind: string | null;
  state: string | null;
  sources: string[] | null;
  metricVersion: string | null;
  sourceLabel: string | null;
  window: { from: string; to: string } | null;
  coverage: Record<string, unknown> | null;
  caveats: string[];
  /** The column the canvas panel encodes as its first y, when the run recorded it. */
  primaryColumn?: string;
}
export interface RunPanelsIndex {
  schema: string;
  runSource: string;
  frozenAt: string;
  panels: PanelIndexEntry[];
  selection: {
    ruleVersion: number;
    rule: string;
    x: { panelHash: string; column: string; unit: string | null; scalePlaces: number };
    y: { panelHash: string; column: string; unit: string | null; scalePlaces: number };
    window: { from: string; to: string };
    points: number;
    overlapDays: number;
    truncatedToLatest: boolean;
    candidates: { panelHash: string; column: string; days: number }[];
    skippedPanels: string[];
    /** Absent in capsules chosen by the original longest-overlap rule. */
    chosenBy?: "planner" | "user" | "rule";
    namedForQuestion?: boolean;
    plan?: TestPlan | null;
    rounding?: {
      x?: { decimalsKept: number; maxAbsRoundingDifference: string };
      y?: { decimalsKept: number; maxAbsRoundingDifference: string };
      rule: string;
    };
  };
}
export interface FindingFact {
  status: string;
  kind?: string;
  basis?: string;
  statement: string;
  facts: Array<{
    value: string;
    unit: string;
    resultRef: { column: string; rowIds: string[]; queryHash: string };
  }>;
  limitations: string[];
  skepticNotes: string[];
}
export interface PanelFile {
  state?: string;
  kind?: string;
  chart?: { columns: Array<{ name: string; unit: string | null }>; rows: unknown[][] } | null;
  provenance?: Record<string, unknown> & {
    resultHash?: string;
    ast?: unknown;
    sources?: string[];
    certification?: string;
  };
  coverage?: {
    rowCoverage?: string[];
    state?: string;
    missingDays?: string[];
    incompleteDays?: string[];
  } | null;
  gaps?: unknown[];
  nullCount?: number;
  partialCount?: number;
  caveats?: string[];
  cannotCompute?: unknown;
}
export interface VerifierInputFile {
  series: Record<"x" | "y", { name: string; unit: string; points: Array<[string, string]> }>;
  metrics: string[];
}
export interface CapsuleFacts {
  capsuleId: string;
  capsuleHash: string;
  createdAt: string;
  label: string;
  results: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  input: VerifierInputFile;
  index: RunPanelsIndex;
  findings: FindingFact[];
  panels: Map<string, PanelFile>;
  /** sha256 of each file listed in the capsule manifest, by capsule-relative path. */
  fileHashes: Map<string, string>;
  inputSha256: string;
  /** sha256 of computation/verifier-input.json (what an OutLayer proof records as its input hash). */
  inputFileSha256: string;
  resultsSha256: string;
}

const readJson = <T>(dir: string, rel: string): T => JSON.parse(readFileSync(join(dir, rel), "utf8")) as T;

/** Reads the facts of a workspace-run capsule; null when the directory is not one (no manifest, or not a run capsule). */
export function readCapsuleFacts(dir: string): CapsuleFacts | null {
  const m = readManifest(dir);
  if (!m) return null;
  if (!existsSync(join(dir, "snapshot", "raw", "run-panels.json"))) return null;
  const index = readJson<RunPanelsIndex>(dir, "snapshot/raw/run-panels.json");
  const panels = new Map<string, PanelFile>();
  for (const p of index.panels) panels.set(p.hash, readJson<PanelFile>(dir, `snapshot/${p.file}`));
  return {
    capsuleId: m.capsuleId,
    capsuleHash: m.capsuleHash,
    createdAt: m.createdAt,
    label: m.label,
    results: readJson(dir, m.computation.resultsFile.path),
    input: readJson(dir, m.computation.inputFile.path),
    index,
    findings: readJson<FindingFact[]>(dir, "snapshot/raw/run-findings.json"),
    panels,
    fileHashes: new Map([
      ...m.snapshot.files.map((f) => [f.path, f.sha256] as const),
      [m.computation.inputFile.path, m.computation.inputFile.sha256],
      [m.computation.resultsFile.path, m.computation.resultsFile.sha256],
    ]),
    inputSha256: m.computation.inputSha256,
    inputFileSha256: m.computation.inputFile.sha256,
    resultsSha256: m.computation.resultsSha256,
  };
}
