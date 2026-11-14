/**
 * Build Bible conformance checker. Read-only: it never runs tests or writes evidence, it judges what exists.
 *
 *   pnpm conformance [--json] [--out <dir>] [--evidence <dir>]
 *
 * Checks, each reported per test and rolled up per gate:
 *  1. Baseline: all 222 canonical acceptance IDs (G00-G12) are in tests/TEST_INDEX.json under the right gate;
 *     additions are listed separately and must carry a definition reference.
 *  2. Defined and implemented: every required test is IMPLEMENTED and its bound test files exist and name the ID.
 *  3. Evidence: the latest recorded result per test is PASS, its commit exists, and nothing under the test's own
 *     package(s) or packages/contracts changed between that commit and HEAD (otherwise STALE).
 *  4. Live: a test marked live needs a PASS whose environment is live; fixture-only evidence never satisfies it.
 *  5. Dependencies: every dependsOn test is certified.
 *  6. Requirements: every chapter-24 requirement in tests/REQUIREMENTS_MAP.json maps to existing code paths and to
 *     indexed tests, and is certified only when all its tests are.
 *  7. Clean checkout: the working tree is clean, so the verdicts bind to HEAD.
 *  8. Inventory: every requirement in tests/REQUIREMENTS_INVENTORY.json (all chapters, 16a/16b tests, ADRs, the final
 *     directive) maps to existing code and to tests; its status is recomputed here from code on disk and recorded
 *     evidence, and the inventory must contain every indexed test and every chapter-24 requirement.
 *  9. Registry numbers: 222 canonical baseline tests (including the historical A16), 223 indexed (A21 added as the
 *     provider-neutral substitute for A16, ADR-20261110-004), 222 required. All three are reported.
 * Exit code 0 only when everything is certified. BLOCKED, NOT_RUN, missing and stale are never PASS.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { judge, type InventoryRequirement, type LiveRequirement } from "./certify/status.ts";

const APP_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(APP_ROOT, "..");

export const BASELINE: Record<string, Array<[string, number]>> = {
  G00: [["BOOT", 3]],
  G01: [["K", 12]],
  G02: [["D", 18]],
  G03: [["S", 16]],
  G04: [["A", 20]],
  G05: [["C", 18]],
  G06: [["M", 16]],
  G07: [["Q", 22]],
  G08: [["W", 18]],
  G09: [["V", 18]],
  G10: [["B", 15]],
  G11: [
    ["SEC", 22],
    ["PERF", 12],
  ],
  G12: [["N", 12]],
};

export function baselineIds(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [gate, ranges] of Object.entries(BASELINE))
    for (const [prefix, n] of ranges)
      for (let i = 1; i <= n; i++) out.set(`${prefix}${String(i).padStart(2, "0")}`, gate);
  return out;
}

interface IndexEntry {
  testId: string;
  gate: string;
  phase: string;
  name: string;
  definition?: string;
  testFiles: string[];
  live: boolean;
  status: string;
  required: boolean;
  dependsOn?: string[];
  supersededBy?: string;
  note?: string;
}
interface Evidence {
  testId: string;
  executedAt: string;
  commitSha: string;
  environment: string;
  verdict: string;
  failureReason?: string | null;
}
interface Requirement {
  id: string;
  text: string;
  code: string[];
  tests: string[];
}

export type TestState =
  | "CERTIFIED"
  | "EXEMPT"
  | "NOT_IN_INDEX"
  | "NOT_IMPLEMENTED"
  | "TEST_FILE_MISSING"
  | "NO_EVIDENCE"
  | "NOT_PASS"
  | "STALE"
  | "LIVE_MISSING"
  | "DEPENDENCY_NOT_CERTIFIED";

export interface TestReport {
  testId: string;
  gate: string;
  baseline: boolean;
  required: boolean;
  state: TestState;
  detail: string;
  lastVerdict: string | null;
  lastRun: string | null;
  evidencePath: string | null;
  evidenceCommit: string | null;
}

const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

function latestEvidence(
  dir: string,
  testId: string,
): { any: Evidence | null; live: Evidence | null; anyFile: string | null } {
  const d = join(dir, testId);
  let any: Evidence | null = null;
  let live: Evidence | null = null;
  let anyFile: string | null = null;
  if (!existsSync(d)) return { any, live, anyFile };
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json") || f.endsWith(".log.json") || f.endsWith(".evidence.json")) continue;
    let e: Evidence;
    try {
      e = JSON.parse(readFileSync(join(d, f), "utf8")) as Evidence;
    } catch {
      continue;
    }
    if (e.testId !== testId || typeof e.verdict !== "string" || typeof e.executedAt !== "string") continue;
    if (!any || e.executedAt > any.executedAt) {
      any = e;
      anyFile = f;
    }
    if (e.environment?.startsWith("live") && (!live || e.executedAt > live.executedAt)) live = e;
  }
  return { any, live, anyFile };
}

const staleCache = new Map<string, string[]>();
function changedSince(sha: string, dirs: string[]): string[] | null {
  const key = `${sha}|${dirs.join(",")}`;
  if (staleCache.has(key)) return staleCache.get(key) ?? [];
  if (!git("cat-file", "-e", `${sha}^{commit}`).ok) return null;
  const r = git("diff", "--name-only", sha, "HEAD", "--", ...dirs.map((x) => `nearesis-app/${x}`));
  const files = r.out ? r.out.split("\n") : [];
  staleCache.set(key, files);
  return files;
}

const pkgDirs = (t: IndexEntry) => [
  ...new Set([...t.testFiles.map((f) => f.split("/").slice(0, 2).join("/")), "packages/contracts"]),
];

interface InventoryFile {
  version: number;
  registry: { canonicalBaseline: number; indexed: number; required: number };
  requirements: InventoryRequirement[];
}
interface InventorySummary {
  requirements: number;
  byStatus: Record<string, number>;
  byBlocker: Record<string, number>;
  unmapped: number;
}

/** Judge every inventory requirement against code on disk and recorded evidence, and check the inventory is complete. */
function checkInventory(reports: Map<string, TestReport>, indexTests: IndexEntry[], mapReqs: Requirement[]) {
  const path = join(APP_ROOT, "tests", "REQUIREMENTS_INVENTORY.json");
  const problems: string[] = [];
  if (!existsSync(path)) {
    return {
      problems: ["tests/REQUIREMENTS_INVENTORY.json is missing (run scripts/certify/build-inventory.ts)"],
      live: [] as LiveRequirement[],
      summary: { requirements: 0, byStatus: {}, byBlocker: {}, unmapped: 0 } as InventorySummary,
    };
  }
  const inv = JSON.parse(readFileSync(path, "utf8")) as InventoryFile;
  const tests = new Map(
    [...reports].map(([id, r]) => [id, { testId: id, state: r.state, detail: r.detail }]),
  );
  const live = inv.requirements.map((q) =>
    judge(APP_ROOT, q, tests, (id) => reports.get(id)?.lastVerdict === "BLOCKED_DEPENDENCY"),
  );

  const covered = new Set(inv.requirements.flatMap((q) => q.tests));
  const uncovered = indexTests.filter((t) => !covered.has(t.testId)).map((t) => t.testId);
  if (uncovered.length) problems.push(`indexed tests not in any requirement: ${uncovered.join(", ")}`);
  const byId = new Map(inv.requirements.map((q) => [q.id, q]));
  const norm = (a: string[]) => JSON.stringify([...a].sort());
  for (const m of mapReqs) {
    const q = byId.get(`REQ-CH24-${m.id}`);
    if (!q) problems.push(`chapter-24 requirement ${m.id} is missing from the inventory`);
    else if (norm(q.code) !== norm(m.code) || norm(q.tests) !== norm(m.tests))
      problems.push(
        `chapter-24 requirement ${m.id} differs between REQUIREMENTS_MAP.json and the inventory (rebuild it)`,
      );
  }
  const ids = inv.requirements.map((q) => q.id);
  if (new Set(ids).size !== ids.length) problems.push("duplicate requirement ids in the inventory");
  for (const q of live) {
    if (!q.mapped) problems.push(`${q.id} does not map to both code and tests`);
    if (q.unknownTests.length) problems.push(`${q.id} names unknown tests ${q.unknownTests.join(", ")}`);
  }
  const wantRequired = [...reports.values()].filter((r) => r.required && r.state !== "EXEMPT").length;
  if (
    inv.registry.canonicalBaseline !== baselineIds().size ||
    inv.registry.indexed !== indexTests.length ||
    inv.registry.required !== wantRequired
  )
    problems.push(
      `inventory registry numbers (${inv.registry.canonicalBaseline}/${inv.registry.indexed}/${inv.registry.required}) differ from the live registry (${baselineIds().size}/${indexTests.length}/${wantRequired}); rebuild it`,
    );

  const count = (f: (q: LiveRequirement) => string) =>
    live.reduce<Record<string, number>>((m, q) => ((m[f(q)] = (m[f(q)] ?? 0) + 1), m), {});
  return {
    problems,
    live,
    summary: {
      requirements: live.length,
      byStatus: count((q) => q.status),
      byBlocker: count((q) => q.blockerKind),
      unmapped: live.filter((q) => !q.mapped).length,
    } as InventorySummary,
  };
}

export function evaluate(evidenceDirOverride?: string) {
  const index = JSON.parse(readFileSync(join(APP_ROOT, "tests", "TEST_INDEX.json"), "utf8")) as {
    evidenceDir: string;
    tests: IndexEntry[];
  };
  const evidenceDir = evidenceDirOverride ?? resolve(APP_ROOT, index.evidenceDir);
  const byId = new Map(index.tests.map((t) => [t.testId, t]));
  const base = baselineIds();
  const reports = new Map<string, TestReport>();

  const first = (t: IndexEntry): TestReport => {
    const baseline = base.has(t.testId);
    const r: TestReport = {
      testId: t.testId,
      gate: t.gate,
      baseline,
      required: t.required,
      state: "CERTIFIED",
      detail: "",
      lastVerdict: null,
      lastRun: null,
      evidencePath: null,
      evidenceCommit: null,
    };
    if (baseline && base.get(t.testId) !== t.gate) {
      r.state = "NOT_IN_INDEX";
      r.detail = `indexed under ${t.gate}, canonical gate is ${base.get(t.testId)}`;
      return r;
    }
    // An exemption must be explicit: not required AND superseded by a named, indexed test.
    if (!t.required) {
      if (t.supersededBy && byId.has(t.supersededBy)) {
        r.state = "EXEMPT";
        r.detail = `superseded by ${t.supersededBy}${t.note ? `: ${t.note}` : ""}`;
        return r;
      }
      r.required = baseline; // a baseline test cannot opt out without a named successor
      if (!baseline) {
        r.state = "EXEMPT";
        r.detail = "optional addition";
        return r;
      }
    }
    if (t.status !== "IMPLEMENTED") {
      r.state = "NOT_IMPLEMENTED";
      r.detail = `index status ${t.status}`;
      return r;
    }
    const missing = t.testFiles.filter((f) => !existsSync(join(APP_ROOT, f)));
    const unnamed = t.testFiles.filter(
      (f) => existsSync(join(APP_ROOT, f)) && !readFileSync(join(APP_ROOT, f), "utf8").includes(t.testId),
    );
    if (t.testFiles.length === 0 || missing.length || unnamed.length) {
      r.state = "TEST_FILE_MISSING";
      r.detail =
        t.testFiles.length === 0
          ? "no test files bound"
          : `missing ${missing.join(", ")} ${unnamed.length ? `; does not name ${t.testId}: ${unnamed.join(", ")}` : ""}`.trim();
      return r;
    }
    const ev = latestEvidence(evidenceDir, t.testId);
    r.lastVerdict = ev.any?.verdict ?? null;
    r.lastRun = ev.any?.executedAt ?? null;
    r.evidencePath = ev.anyFile ? `reports/TESTS/${t.testId}/${ev.anyFile}` : null;
    r.evidenceCommit = ev.any?.commitSha ?? null;
    if (!ev.any) {
      r.state = "NO_EVIDENCE";
      r.detail = "no recorded result";
      return r;
    }
    if (ev.any.verdict !== "PASS") {
      r.state = "NOT_PASS";
      r.detail = `${ev.any.verdict}${ev.any.failureReason ? `: ${String(ev.any.failureReason).slice(0, 160)}` : ""}`;
      return r;
    }
    const judged = t.live ? ev.live : ev.any;
    if (t.live && (!ev.live || ev.live.verdict !== "PASS")) {
      r.state = "LIVE_MISSING";
      r.detail = ev.live
        ? `latest live run ${ev.live.verdict}`
        : "only fixture evidence; the live operation was never performed";
      return r;
    }
    const changed = changedSince((judged as Evidence).commitSha, pkgDirs(t));
    if (changed === null) {
      r.state = "STALE";
      r.detail = `evidence commit ${(judged as Evidence).commitSha.slice(0, 8)} is not in this repository`;
      return r;
    }
    if (changed.length) {
      r.state = "STALE";
      r.detail = `${changed.length} file(s) changed since ${(judged as Evidence).commitSha.slice(0, 8)}, e.g. ${changed[0]}`;
      return r;
    }
    return r;
  };

  for (const t of index.tests) reports.set(t.testId, first(t));
  for (const [id, gate] of base)
    if (!byId.has(id))
      reports.set(id, {
        testId: id,
        gate,
        baseline: true,
        required: true,
        state: "NOT_IN_INDEX",
        detail: "canonical test missing from TEST_INDEX.json",
        lastVerdict: null,
        lastRun: null,
        evidencePath: null,
        evidenceCommit: null,
      });

  // Dependencies, to a fixed point: a certified test whose prerequisite is not certified is downgraded.
  let changedAny = true;
  while (changedAny) {
    changedAny = false;
    for (const t of index.tests) {
      const r = reports.get(t.testId)!;
      if (r.state !== "CERTIFIED") continue;
      const bad = (t.dependsOn ?? []).filter((d) => {
        const s = reports.get(d)?.state;
        return s !== "CERTIFIED" && s !== "EXEMPT";
      });
      if (bad.length) {
        r.state = "DEPENDENCY_NOT_CERTIFIED";
        r.detail = `prerequisites not certified: ${bad.join(", ")}`;
        changedAny = true;
      }
    }
  }

  const map = JSON.parse(readFileSync(join(APP_ROOT, "tests", "REQUIREMENTS_MAP.json"), "utf8")) as {
    requirements: Requirement[];
  };
  const requirements = map.requirements.map((q) => {
    const missingCode = q.code.filter((p) => !existsSync(join(APP_ROOT, p)));
    const unknownTests = q.tests.filter((x) => !reports.has(x));
    const notCertified = q.tests.filter((x) => {
      const s = reports.get(x)?.state;
      return s !== "CERTIFIED" && s !== "EXEMPT";
    });
    const ok =
      q.code.length > 0 &&
      q.tests.length > 0 &&
      !missingCode.length &&
      !unknownTests.length &&
      !notCertified.length;
    return { id: q.id, text: q.text, certified: ok, missingCode, unknownTests, notCertified };
  });

  const inventory = checkInventory(reports, index.tests, map.requirements);

  const gates = [...Object.keys(BASELINE)].map((gate) => {
    const rs = [...reports.values()].filter((r) => r.gate === gate && r.required && r.state !== "EXEMPT");
    const certified = rs.filter((r) => r.state === "CERTIFIED").length;
    return { gate, required: rs.length, certified, pass: rs.length > 0 && certified === rs.length };
  });

  const status = git("status", "--porcelain", "--", "nearesis-app");
  const all = [...reports.values()];
  const baselineCount = all.filter((r) => r.baseline).length;
  const head = git("rev-parse", "HEAD").out;
  const summary = {
    head,
    treeClean: status.out === "",
    baselineAccounted: baselineCount,
    baselineExpected: base.size,
    additions: all.filter((r) => !r.baseline).map((r) => r.testId),
    states: all.reduce<Record<string, number>>((m, r) => ((m[r.state] = (m[r.state] ?? 0) + 1), m), {}),
    gatesPassed: gates.filter((g) => g.pass).length,
    gatesTotal: gates.length,
    requirementsCertified: requirements.filter((q) => q.certified).length,
    requirementsTotal: requirements.length,
    registry: {
      canonicalBaseline: base.size,
      indexed: index.tests.length,
      required: all.filter((r) => r.required && r.state !== "EXEMPT").length,
      exemptHistorical: all.filter((r) => r.state === "EXEMPT").map((r) => r.testId),
      additionsBeyondBaseline: all.filter((r) => !r.baseline).map((r) => r.testId),
      explanation:
        "222 = canonical acceptance IDs in ch16/16a/16b, including the historical A16. 223 = tests indexed: those 222 plus A21, the provider-neutral live-inference test that substitutes A16 (ADR-20261110-004). 222 = tests required for certification: A16 is exempt and superseded by A21.",
    },
    inventory: inventory.summary,
  };
  const certified =
    summary.treeClean &&
    summary.baselineAccounted === summary.baselineExpected &&
    gates.every((g) => g.pass) &&
    requirements.every((q) => q.certified) &&
    inventory.problems.length === 0 &&
    inventory.live.every((q) => q.status === "CERTIFIED");
  return {
    certified,
    summary,
    gates,
    requirements,
    inventoryProblems: inventory.problems,
    inventoryRequirements: inventory.live,
    tests: all.sort((a, b) => a.testId.localeCompare(b.testId)),
  };
}

function markdown(r: ReturnType<typeof evaluate>): string {
  const lines = [
    `# Build Bible conformance`,
    ``,
    `HEAD ${r.summary.head.slice(0, 12)} · tree ${r.summary.treeClean ? "clean" : "DIRTY"} · verdict **${r.certified ? "CERTIFIED" : "NOT CERTIFIED"}**`,
    ``,
    `Baseline tests accounted: ${r.summary.baselineAccounted}/${r.summary.baselineExpected}. Gates passed: ${r.summary.gatesPassed}/${r.summary.gatesTotal}. Requirements certified: ${r.summary.requirementsCertified}/${r.summary.requirementsTotal}.`,
    ``,
    `Registry: ${r.summary.registry.canonicalBaseline} canonical baseline IDs (including historical ${r.summary.registry.exemptHistorical.join(", ")}) · ${r.summary.registry.indexed} indexed (adds ${r.summary.registry.additionsBeyondBaseline.join(", ")}, the substitute for ${r.summary.registry.exemptHistorical.join(", ")}) · ${r.summary.registry.required} required for certification.`,
    ``,
    `Inventory: ${r.summary.inventory.requirements} requirements (${Object.entries(
      r.summary.inventory.byStatus,
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}); problems: ${r.inventoryProblems.length}.`,
    ``,
    `| Gate | Required | Certified | Pass |`,
    `| --- | --- | --- | --- |`,
    ...r.gates.map((g) => `| ${g.gate} | ${g.required} | ${g.certified} | ${g.pass ? "yes" : "no"} |`),
    ``,
    `## Tests not certified`,
    ``,
    `| Test | Gate | State | Detail |`,
    `| --- | --- | --- | --- |`,
    ...r.tests
      .filter((t) => t.state !== "CERTIFIED")
      .map((t) => `| ${t.testId} | ${t.gate} | ${t.state} | ${t.detail.replace(/\|/g, "/")} |`),
    ``,
    `## Requirements not certified`,
    ``,
    ...r.requirements
      .filter((q) => !q.certified)
      .map(
        (q) =>
          `- ${q.id} ${q.text}${q.missingCode.length ? ` · missing code: ${q.missingCode.join(", ")}` : ""}${q.unknownTests.length ? ` · unknown tests: ${q.unknownTests.join(", ")}` : ""}${q.notCertified.length ? ` · tests not certified: ${q.notCertified.join(", ")}` : ""}`,
      ),
    ``,
    `## Inventory problems`,
    ``,
    ...(r.inventoryProblems.length ? r.inventoryProblems.map((p) => `- ${p}`) : ["none"]),
    ``,
    `## Inventory requirements by blocker`,
    ``,
    ...Object.entries(r.summary.inventory.byBlocker).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Inventory requirements not certified (non-test requirements)`,
    ``,
    ...r.inventoryRequirements
      .filter((q) => q.status !== "CERTIFIED" && !q.id.startsWith("REQ-T-"))
      .map(
        (q) => `- ${q.id} ${q.status} (${q.blockerKind})${q.blocker ? `: ${q.blocker.slice(0, 200)}` : ""}`,
      ),
    ``,
  ];
  return lines.join("\n");
}

if (import.meta.main ?? process.argv[1]?.endsWith("conformance.ts")) {
  const { values: a } = parseArgs({
    options: {
      json: { type: "boolean", default: false },
      out: { type: "string" },
      evidence: { type: "string" },
    },
  });
  const r = evaluate(a.evidence ? resolve(a.evidence) : undefined);
  if (a.out) {
    mkdirSync(a.out, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(a.out, `CONFORMANCE-${stamp}.json`), JSON.stringify(r, null, 2));
    writeFileSync(join(a.out, `CONFORMANCE-${stamp}.md`), markdown(r));
  }
  process.stdout.write(a.json ? JSON.stringify(r, null, 2) + "\n" : markdown(r) + "\n");
  process.exit(r.certified ? 0 : 1);
}
