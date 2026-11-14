import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { APP_ROOT } from "@nearesis/capsule";

/**
 * Read-only access to the research engine's REAL run artifacts (services/research writes them under
 * docs/research/live-results/<runId>/). Nothing here computes or invents a statistic: every number returned is a number
 * the Python engine wrote, and each hashed artifact file is re-hashed against `research_run.json.artifactHashes`
 * (sha256 of the file bytes without the trailing newline) before it is served. A run whose artifacts fail the check is
 * reported as `integrity: "failed"` with no figures.
 */
export const researchResultsDir = (): string =>
  process.env.NEARESIS_RESEARCH_RESULTS_DIR ?? join(APP_ROOT, "docs", "research", "live-results");

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export interface ResearchRun {
  runId: string;
  integrity: "verified" | "failed";
  integrityIssues: string[];
  /** Artifacts present on disk that research_run.json does not hash (served, labelled unhashed). */
  unhashed: string[];
  run: Json;
  artifacts: Record<string, unknown>;
  robustness: Json | null;
  summary: Json | null;
}

const CACHE = new Map<string, { sig: string; run: ResearchRun }>();

function readJson(p: string): unknown {
  return JSON.parse(readFileSync(p, "utf8"));
}

function load(dir: string, runId: string): ResearchRun | null {
  const runPath = join(dir, "research_run.json");
  if (!existsSync(runPath)) return null;
  const sig = readdirSync(dir)
    .sort()
    .map((n) => `${n}:${statSync(join(dir, n)).mtimeMs}:${statSync(join(dir, n)).size}`)
    .join("|");
  const hit = CACHE.get(dir);
  if (hit && hit.sig === sig) return hit.run;
  let run: Json;
  try {
    run = obj(readJson(runPath));
  } catch {
    return null;
  }
  const hashes = obj(run.artifactHashes);
  const issues: string[] = [];
  const artifacts: Record<string, unknown> = {};
  for (const [name, expected] of Object.entries(hashes)) {
    const f = join(dir, `${name}.json`);
    if (!existsSync(f)) {
      issues.push(`${name}: file missing`);
      continue;
    }
    const raw = readFileSync(f);
    const trimmed = raw.at(-1) === 0x0a ? raw.subarray(0, raw.length - 1) : raw;
    const got = `sha256:${createHash("sha256").update(trimmed).digest("hex")}`;
    if (got !== expected) {
      issues.push(`${name}: sha256 mismatch`);
      continue;
    }
    try {
      const parsed = JSON.parse(raw.toString("utf8"));
      artifacts[name] = parsed;
      if (name in run && !isDeepStrictEqual(parsed, run[name]))
        issues.push(`${name}: differs from research_run.json`);
    } catch {
      issues.push(`${name}: not valid JSON`);
    }
  }
  const unhashed: string[] = [];
  const side = (n: string): Json | null => {
    const f = join(dir, `${n}.json`);
    if (!existsSync(f)) return null;
    unhashed.push(n);
    try {
      return obj(readJson(f));
    } catch {
      return null;
    }
  };
  const out: ResearchRun = {
    runId,
    integrity: issues.length ? "failed" : "verified",
    integrityIssues: issues,
    unhashed,
    run,
    artifacts,
    robustness: side("robustness_matrix"),
    summary: side("run_summary"),
  };
  CACHE.set(dir, { sig, run: out });
  return out;
}

export function listResearchRuns(root: string = researchResultsDir()): ResearchRun[] {
  if (!existsSync(root)) return [];
  const out: ResearchRun[] = [];
  for (const id of readdirSync(root).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(id)) continue;
    const r = load(join(root, id), id);
    if (r) out.push(r);
  }
  return out;
}

export function getResearchRun(id: string, root: string = researchResultsDir()): ResearchRun | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(id)) return null;
  return load(join(root, id), id);
}

const LABELS: Record<string, string> = {
  baseline: "Baseline (usage and calendar history)",
  intents: "Baseline + lagged Intents volume",
  price: "Baseline + lagged price returns",
  combined: "Baseline + Intents + price",
  naive_last: "Naive (last value)",
  seasonal_naive: "Seasonal naive",
  moving_avg_7: "7-day moving average",
};

/** The experiment card the UI lists. All figures come from the artifacts; absent ones are null, never zero. */
export function experimentSummary(r: ResearchRun) {
  const run = r.run;
  const failed = r.integrity === "failed";
  const est = obj(r.artifacts.estimates);
  const primary = obj(est.primary);
  const windows = obj(r.artifacts.windows);
  const verdict = obj(run.verdict);
  const prim = obj(r.summary?.primary);
  const byKey = obj(est.byHorizonCandidate);
  const inf = obj(
    obj(byKey[`${num(obj(r.artifacts.hypothesis).primaryHorizon)}:${str(primary.candidate)}`]).inference,
  );
  const concl = obj(inf.conclusion);
  const horizons = [
    ...new Set(
      Object.values(obj(est.byHorizonCandidate))
        .map((x) => num(obj(x).horizon))
        .filter((h): h is number => h !== null),
    ),
  ].sort((a, b) => a - b);
  return {
    experimentId: r.runId,
    studyId: str(run.experimentId),
    name: str(obj(r.artifacts.hypothesis).primaryComparison)
      ? `${str(obj(r.artifacts.hypothesis).primaryComparison)} (${str(run.methodVersion) ?? "method unknown"})`
      : (str(run.experimentId) ?? r.runId),
    state: failed ? ("integrity_failed" as const) : ("succeeded" as const),
    integrity: r.integrity,
    integrityIssues: r.integrityIssues,
    status: failed ? null : str(run.status),
    evidenceStrength: failed ? null : str(run.evidenceStrength),
    claimScope: str(run.claimScope),
    methodVersion: str(run.methodVersion),
    origins: failed ? null : (num(primary.n_origins) ?? num(prim.n_origins)),
    horizons: failed ? [] : horizons,
    loss: failed ? null : (str(inf.loss) ?? null),
    methodValidated: failed || !concl.state ? null : concl.state !== "comparison_method_not_validated",
    reasonCodes: failed
      ? ["INTEGRITY_FAILED"]
      : [
          ...(str(inf.status) && inf.status !== "VALID" ? [String(inf.status)] : []),
          ...arr(verdict.reasons)
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.slice(0, 300)),
        ],
    window: failed ? null : (windows.development ?? null),
    preregistrationHash: failed ? null : str(obj(r.artifacts.preregistration).hash),
    preregistrationVerified: run.preregistrationVerified === true,
    models: failed ? [] : experimentModels(r),
  };
}

function experimentModels(r: ResearchRun) {
  const dev = obj(obj(obj(r.artifacts.estimates).losses).development);
  return Object.entries(dev).map(([id, v]) => {
    const m = obj(v);
    return {
      id,
      label: LABELS[id] ?? id,
      mae: num(m.mae_log),
      smape: num(m.smape_raw),
      bias: num(m.bias_log),
      n: num(m.n),
    };
  });
}

/** The full read-only experiment: comparisons, inference records, robustness matrix, falsification, limitations, provenance. */
export function experimentDetail(r: ResearchRun) {
  const head = experimentSummary(r);
  if (r.integrity === "failed")
    return {
      ...head,
      comparisons: [],
      robustness: null,
      limitations: [],
      falsification: null,
      counterevidence: [],
      provenance: null,
    };
  const est = obj(r.artifacts.estimates);
  const comparisons = Object.entries(obj(est.byHorizonCandidate))
    .map(([key, v]) => {
      const c = obj(v);
      const inf = obj(c.inference);
      return {
        key,
        candidate: str(c.candidate),
        horizon: num(c.horizon),
        nOrigins: num(c.n_origins),
        maeBaseline: num(c.mae_baseline),
        maeCandidate: num(c.mae_candidate),
        deltaMae: num(c.delta_mae),
        relativeImprovement: num(c.relative_improvement),
        deltaMaeCi: c.delta_mae_ci ?? null,
        pRaw: num(c.p_raw),
        pAdjusted: num(c.p_adjusted),
        fdrReject: typeof c.fdr_reject === "boolean" ? c.fdr_reject : null,
        inference: {
          status: str(inf.status),
          method: inf.method ?? null,
          significanceClaimAllowed:
            typeof inf.significance_claim_allowed === "boolean" ? inf.significance_claim_allowed : null,
          conclusion: inf.conclusion ?? null,
          limitations: arr(inf.limitations),
        },
      };
    })
    .sort(
      (a, b) => (a.horizon ?? 0) - (b.horizon ?? 0) || String(a.candidate).localeCompare(String(b.candidate)),
    );
  const rm = r.robustness;
  return {
    ...head,
    comparisons,
    models: head.models,
    robustness: rm
      ? {
          hashed: false,
          note: str(rm.note),
          primary: rm.primary ?? null,
          signFlipRule: str(rm.signFlipRule),
          snapshotId: str(rm.snapshotId),
          rows: Object.entries(obj(rm.rows)).map(([name, v]) => {
            const row = obj(v);
            return {
              name,
              status: str(row.status),
              reason: str(row.reason),
              nOrigins: num(row.n_origins),
              rule: str(row.rule),
              note: str(row.note),
              estimates: arr(row.estimates),
            };
          }),
        }
      : null,
    limitations: arr(r.artifacts.limitations),
    falsification: r.artifacts.falsification ?? null,
    counterevidence: arr(r.artifacts.counterevidence),
    provenance: {
      reproduction: r.artifacts.reproduction ?? null,
      inputSnapshot: obj(r.artifacts.inputSnapshot).datasetHash ?? null,
      artifactHashes: r.run.artifactHashes ?? null,
      lockbox: obj(r.artifacts.windows).lockbox ?? null,
      unhashedArtifacts: r.unhashed,
    },
  };
}
