/**
 * Builds tests/REQUIREMENTS_INVENTORY.json (committed) from the curated seed, tests/TEST_INDEX.json, tests/REQUIREMENTS_MAP.json
 * and, when the Build Bible is present locally, the recorded evidence. Run it after changing the seed, the index or the code
 * layout:
 *
 *   pnpm exec tsx scripts/certify/build-inventory.ts [--check]
 *
 * --check rebuilds in memory and fails if the committed static fields (everything except the evidence snapshot) differ.
 * Requirement text is a short paraphrase with a chapter/section reference; nothing is copied from the Bible.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { baselineIds, evaluate } from "../conformance.ts";
import { SEED } from "./inventory-seed.ts";
import { judge, type InventoryRequirement } from "./status.ts";

const APP_ROOT = resolve(import.meta.dirname, "..", "..");
const OUT = join(APP_ROOT, "tests", "REQUIREMENTS_INVENTORY.json");

interface IndexEntry {
  testId: string;
  gate: string;
  name: string;
  owner: string;
  definition?: string;
  testFiles: string[];
  live: boolean;
  required: boolean;
  dependsOn?: string[];
  supersededBy?: string;
  note?: string;
}

/** Code under test for tests that live outside a package (cross-cutting suites). */
const PREFIX_CODE: Record<string, string[]> = {
  BOOT: [
    "scripts/bootstrap-toolchain.sh",
    "scripts/security/secret-scan.ts",
    "scripts/security/url-audit.ts",
  ],
  B: ["plugins/near-thesis/src", "packages/workflow/src", "packages/capsule/src"],
  PERF: ["tests/perf", "packages/agent-runtime/src/slo", "apps/api/src/overload"],
  SEC: ["packages/kernel/src", "apps/api/src", "scripts/security"],
  N: ["scripts/release", "plugins/chain-commit/src"],
};

function codeFor(t: IndexEntry): string[] {
  const dirs = new Set<string>();
  for (const f of t.testFiles) {
    const m = /^((?:packages|services|apps|plugins)\/[^/]+)\//.exec(f);
    if (m) dirs.add(m[1] === "services/research" ? "services/research/nearesis_research" : `${m[1]}/src`);
  }
  const prefix = /^[A-Z]+/.exec(t.testId)?.[0] ?? "";
  for (const c of PREFIX_CODE[prefix] ?? []) dirs.add(c);
  return [...dirs];
}

const ownerOf = (o: string) => (o === "ENGINE_B" ? "ENGINE_B" : "ENGINE_A");

export function buildStatic(): { requirements: InventoryRequirement[]; registry: Record<string, unknown> } {
  const index = JSON.parse(readFileSync(join(APP_ROOT, "tests", "TEST_INDEX.json"), "utf8")) as {
    tests: IndexEntry[];
  };
  const map = JSON.parse(readFileSync(join(APP_ROOT, "tests", "REQUIREMENTS_MAP.json"), "utf8")) as {
    requirements: { id: string; text: string; code: string[]; tests: string[] }[];
  };
  const byId = new Map(index.tests.map((t) => [t.testId, t]));
  const filesOf = (ids: string[]) => [...new Set(ids.flatMap((i) => byId.get(i)?.testFiles ?? []))].sort();
  const chain = (ids: string[]): string[] => {
    const seen = new Set<string>();
    const walk = (id: string) => {
      for (const d of byId.get(id)?.dependsOn ?? []) {
        if (seen.has(d)) continue;
        seen.add(d);
        walk(d);
      }
    };
    ids.forEach(walk);
    return [...seen].sort();
  };
  const reqs: InventoryRequirement[] = [];
  const mk = (
    id: string,
    chapterSection: string,
    engine: string,
    summary: string,
    code: string[],
    tests: string[],
    declared: Partial<InventoryRequirement["declared"]> & { files?: string[]; deps?: string[] } = {},
  ) => {
    for (const t of tests) if (!byId.has(t)) throw new Error(`${id}: unknown test id ${t}`);
    reqs.push({
      id,
      chapterSection,
      engine,
      summary,
      code,
      tests: [...new Set(tests)],
      testFiles: [...new Set([...filesOf(tests), ...(declared.files ?? [])])].sort(),
      declared: {
        partial: declared.partial ?? false,
        external: declared.external ?? false,
        missingIntegration: declared.missingIntegration ?? null,
        blocker: declared.blocker ?? null,
      },
      dependsOnRequirements: declared.deps ?? [],
      dependencyChain: chain(tests),
    });
  };

  // 1. Curated requirements (chapters, final directive, ADRs). Phase requirements take the tests of their gate.
  for (const s of SEED) {
    let tests = s.tests;
    let code = s.code;
    if (s.id.startsWith("REQ-CH15-P")) {
      const gate = `G${s.id.slice(-2)}`;
      const gateTests = index.tests.filter((t) => t.gate === gate && t.required);
      tests = gateTests.map((t) => t.testId);
      code = [...new Set(gateTests.flatMap(codeFor))].sort();
    }
    mk(s.id, s.ref, s.engine, s.summary, code, tests, {
      partial: s.opts.partial,
      external: s.opts.external,
      missingIntegration: s.opts.missing ?? null,
      blocker: s.opts.blocker ?? null,
      files: s.opts.files,
      deps: s.opts.deps,
    });
  }

  // 2. Chapter 24 (F01-F23, L01-L14) exactly as in REQUIREMENTS_MAP.json.
  for (const m of map.requirements)
    mk(
      `REQ-CH24-${m.id}`,
      `ch24 ${m.id.startsWith("F") ? "feature traceability" : "launch checklist"} ${m.id}`,
      "ENGINE_A",
      m.text,
      m.code,
      m.tests,
    );

  // 3. Chapter 16 / 16a / 16b: one requirement per indexed test definition.
  for (const t of index.tests) {
    const ref = `${t.definition ?? "ch16"} ${t.gate} test ${t.testId}`;
    const hist = t.supersededBy
      ? {
          blocker: `Historical: superseded by ${t.supersededBy} (ADR-20261110-004); never certified from another provider's output.`,
        }
      : {};
    mk(`REQ-T-${t.testId}`, ref, ownerOf(t.owner), t.name, codeFor(t), [t.testId], hist);
  }

  const baseline = baselineIds();
  // Same rule as conformance: a baseline test cannot opt out without a named successor (N05 and PERF06 carry required:false
  // in the index but are canonical, so they are required).
  const required = index.tests.filter((t) =>
    t.supersededBy && !t.required ? false : t.required || baseline.has(t.testId),
  ).length;
  return {
    requirements: reqs,
    registry: {
      canonicalBaseline: baseline.size,
      indexed: index.tests.length,
      required,
      exemptHistorical: index.tests.filter((t) => !t.required && t.supersededBy).map((t) => t.testId),
      substitutes: Object.fromEntries(
        index.tests.filter((t) => t.supersededBy).map((t) => [t.testId, t.supersededBy]),
      ),
      additionsBeyondBaseline: index.tests.filter((t) => !baseline.has(t.testId)).map((t) => t.testId),
      authority: "ADR-20261110-004",
      explanation:
        "222 = canonical acceptance IDs defined by ch16, 16a and 16b, including the historical A16. 223 = tests indexed: those 222 plus A21 (provider-neutral live structured inference), which substitutes A16 after NEAR AI was replaced by OpenRouter BYOK. 222 = tests required for certification: A16 stays defined but is non-required and exempt; A21 is required. The G04 total stays 20 and the milestone total 87.",
    },
  };
}

export function build() {
  const { requirements, registry } = buildStatic();
  const report = evaluate();
  const tests = new Map(report.tests.map((t) => [t.testId, t]));
  const testRows = new Map(
    report.tests.map((t) => [t.testId, { testId: t.testId, state: t.state, detail: t.detail }]),
  );
  const out = requirements.map((q) => {
    const live = judge(APP_ROOT, q, testRows, (id) => tests.get(id)?.lastVerdict === "BLOCKED_DEPENDENCY");
    return {
      ...q,
      snapshot: {
        status: live.status,
        blockerKind: live.blockerKind,
        blocker: live.blocker,
        missingCode: live.missingCode,
        missingTestFiles: live.missingTestFiles,
        evidence: q.tests.map((id) => {
          const t = tests.get(id);
          return {
            testId: id,
            state: t?.state ?? "NOT_IN_INDEX",
            verdict: t?.lastVerdict ?? null,
            executedAt: t?.lastRun ?? null,
            evidencePath: t?.evidencePath ?? null,
            commit: t?.evidenceCommit ?? null,
          };
        }),
      },
    };
  });
  const count = (f: (q: (typeof out)[number]) => string) =>
    out.reduce<Record<string, number>>((m, q) => ((m[f(q)] = (m[f(q)] ?? 0) + 1), m), {});
  return {
    version: 1,
    purpose:
      "Machine-readable inventory of every Build Bible requirement (chapters 00-28, 16a/16b test definitions, accepted ADRs, final directive s4-21 and s22-27). Static fields are curated; `snapshot` is the status when this file was generated and is recomputed live by `pnpm conformance`.",
    generatedFromHead: report.summary.head,
    snapshotTreeClean: report.summary.treeClean,
    evidenceRoot: "NEARESIS_Build_Bible/ (local only, never committed); evidencePath is relative to it",
    registry,
    counts: {
      requirements: out.length,
      byStatus: count((q) => q.snapshot.status),
      byBlocker: count((q) => q.snapshot.blockerKind),
      byEngine: count((q) => q.engine),
    },
    requirements: out,
  };
}

const staticOnly = (inv: { requirements: Record<string, unknown>[]; registry: unknown }) =>
  JSON.stringify({
    registry: inv.registry,
    requirements: inv.requirements.map(({ snapshot: _s, ...rest }) => rest),
  });

if (import.meta.main ?? process.argv[1]?.endsWith("build-inventory.ts")) {
  const { values: a } = parseArgs({ options: { check: { type: "boolean", default: false } } });
  const inv = build();
  if (a.check) {
    const cur = JSON.parse(readFileSync(OUT, "utf8"));
    if (staticOnly(cur) !== staticOnly(inv)) {
      process.stderr.write("tests/REQUIREMENTS_INVENTORY.json static fields are out of date; rebuild it\n");
      process.exit(1);
    }
    process.stdout.write("inventory static fields are current\n");
  } else {
    writeFileSync(OUT, JSON.stringify(inv, null, 2) + "\n");
    process.stdout.write(`${JSON.stringify(inv.counts, null, 2)}\n`);
  }
}
