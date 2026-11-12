/**
 * Requirement-level status: shared by scripts/certify/build-inventory.ts (which writes the committed snapshot) and
 * scripts/conformance.ts (which recomputes it live from code on disk and recorded evidence). Status is derived from what
 * is on disk, never from what a report claims.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ReqStatus =
  | "CERTIFIED"
  | "IMPLEMENTED_UNCERTIFIED"
  | "IMPLEMENTED_UNTESTED"
  | "PARTIAL"
  | "NOT_IMPLEMENTED"
  | "BLOCKED_EXTERNAL";

export type BlockerKind =
  | "NONE"
  | "NOT_BUILT"
  | "PARTIAL_BUILD"
  | "NO_TEST_MAPPING"
  | "STALE_EVIDENCE"
  | "NO_EVIDENCE"
  | "TEST_FAILING"
  | "BLOCKED_DEPENDENCY"
  | "LIVE_EVIDENCE_MISSING"
  | "TEST_NOT_IMPLEMENTED"
  | "PREREQUISITE_NOT_CERTIFIED"
  | "EXTERNAL_APPROVAL_OR_DATA";

export interface InventoryRequirement {
  id: string;
  chapterSection: string;
  engine: string;
  summary: string;
  code: string[];
  tests: string[];
  testFiles: string[];
  declared: {
    partial: boolean;
    external: boolean;
    missingIntegration: string | null;
    blocker: string | null;
  };
  dependsOnRequirements: string[];
  dependencyChain: string[];
}

export interface TestLike {
  testId: string;
  state: string;
  detail: string;
}

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".git", "__pycache__", ".venv", ".toolchain"]);

function walk(p: string, visit: (file: string) => boolean): boolean {
  let st;
  try {
    st = statSync(p);
  } catch {
    return false;
  }
  if (st.isFile()) return visit(p);
  for (const e of readdirSync(p)) {
    if (SKIP_DIRS.has(e)) continue;
    if (walk(join(p, e), visit)) return true;
  }
  return false;
}

/** `path` must exist; `path#symbol` additionally needs the symbol text somewhere inside that file or directory. */
export function codePathOk(appRoot: string, spec: string): { ok: boolean; why?: string } {
  const [path, symbol] = spec.split("#");
  const abs = join(appRoot, path ?? "");
  if (!existsSync(abs)) return { ok: false, why: `missing ${path}` };
  if (!symbol) return { ok: true };
  const found = walk(abs, (f) => {
    if (!/\.(ts|tsx|py|rs|mjs|js|sh|json|ya?ml|md|sql)$/.test(f)) return false;
    try {
      return readFileSync(f, "utf8").includes(symbol);
    } catch {
      return false;
    }
  });
  return found ? { ok: true } : { ok: false, why: `${path} does not contain "${symbol}"` };
}

const GOOD = new Set(["CERTIFIED", "EXEMPT"]);

const KIND_OF_STATE: Record<string, BlockerKind> = {
  STALE: "STALE_EVIDENCE",
  NO_EVIDENCE: "NO_EVIDENCE",
  NOT_PASS: "TEST_FAILING",
  LIVE_MISSING: "LIVE_EVIDENCE_MISSING",
  NOT_IMPLEMENTED: "TEST_NOT_IMPLEMENTED",
  TEST_FILE_MISSING: "TEST_NOT_IMPLEMENTED",
  NOT_IN_INDEX: "TEST_NOT_IMPLEMENTED",
  DEPENDENCY_NOT_CERTIFIED: "PREREQUISITE_NOT_CERTIFIED",
};

export interface LiveRequirement {
  id: string;
  status: ReqStatus;
  blockerKind: BlockerKind;
  blocker: string | null;
  missingCode: string[];
  missingTestFiles: string[];
  unknownTests: string[];
  testStates: Record<string, string[]>;
  mapped: boolean;
}

export function judge(
  appRoot: string,
  q: InventoryRequirement,
  tests: Map<string, TestLike>,
  testsWithBlockedVerdict: (id: string) => boolean = () => false,
): LiveRequirement {
  const codeResults = q.code.map((c) => ({ c, ...codePathOk(appRoot, c) }));
  const missingCode = codeResults.filter((x) => !x.ok).map((x) => x.why ?? x.c);
  const missingTestFiles = q.testFiles.filter((f) => !existsSync(join(appRoot, f)));
  const unknownTests = q.tests.filter((t) => !tests.has(t));
  const testStates: Record<string, string[]> = {};
  for (const id of q.tests) {
    const s = tests.get(id)?.state;
    if (s) (testStates[s] ??= []).push(id);
  }
  const bad = q.tests.filter((id) => {
    const s = tests.get(id)?.state;
    return s !== undefined && !GOOD.has(s);
  });
  const allCertified = q.tests.length > 0 && bad.length === 0 && unknownTests.length === 0;
  const mapped = q.code.length > 0 && (q.tests.length > 0 || q.testFiles.length > 0);

  const out = (status: ReqStatus, blockerKind: BlockerKind, blocker: string | null): LiveRequirement => ({
    id: q.id,
    status,
    blockerKind,
    blocker,
    missingCode,
    missingTestFiles,
    unknownTests,
    testStates,
    mapped,
  });

  const testSummary = () => {
    const parts = Object.entries(testStates)
      .filter(([s]) => !GOOD.has(s))
      .map(([s, ids]) => `${s} ${ids.slice(0, 6).join(",")}${ids.length > 6 ? ` (+${ids.length - 6})` : ""}`);
    return parts.length ? `tests not certified: ${parts.join("; ")}` : null;
  };
  const declared = q.declared.blocker;

  if (q.code.length > 0 && missingCode.length === q.code.length)
    return out(
      "NOT_IMPLEMENTED",
      "NOT_BUILT",
      declared ?? `no implementation on disk: ${missingCode.slice(0, 3).join("; ")}`,
    );
  if (missingCode.length)
    return out(
      "PARTIAL",
      "PARTIAL_BUILD",
      [declared, `missing code: ${missingCode.slice(0, 3).join("; ")}`].filter(Boolean).join(" | "),
    );
  if (q.tests.length === 0 && (q.testFiles.length === 0 || missingTestFiles.length))
    return out(
      "IMPLEMENTED_UNTESTED",
      "NO_TEST_MAPPING",
      declared ?? "no existing test is bound to this requirement",
    );
  if (unknownTests.length)
    return out("IMPLEMENTED_UNTESTED", "NO_TEST_MAPPING", `unknown test ids: ${unknownTests.join(", ")}`);
  if (q.declared.partial)
    return out(
      "PARTIAL",
      "PARTIAL_BUILD",
      [declared, q.declared.missingIntegration].filter(Boolean).join(" | "),
    );
  if (allCertified && !missingTestFiles.length) return out("CERTIFIED", "NONE", null);
  const worst = bad.find((id) => testsWithBlockedVerdict(id));
  let kind: BlockerKind = "STALE_EVIDENCE";
  for (const id of bad) {
    const k = KIND_OF_STATE[tests.get(id)?.state ?? ""];
    if (k && (kind === "STALE_EVIDENCE" || k === "TEST_FAILING")) kind = k;
  }
  if (worst) kind = "BLOCKED_DEPENDENCY";
  if (q.declared.external)
    return out(
      "BLOCKED_EXTERNAL",
      "EXTERNAL_APPROVAL_OR_DATA",
      [declared, testSummary()].filter(Boolean).join(" | "),
    );
  return out("IMPLEMENTED_UNCERTIFIED", kind, testSummary() ?? declared);
}
