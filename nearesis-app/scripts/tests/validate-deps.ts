/**
 * Test-dependency graph validator (`pnpm test:deps`).
 *
 * Reads ONLY tests/TEST_INDEX.json (never the Bible) and fails on:
 *   - a dependency cycle,
 *   - a dependency on an unknown test ID,
 *   - a dependency on a LATER gate (gate order G00..G12; same or earlier gate is allowed),
 *   - a self dependency, a duplicate test ID, a malformed gate or a malformed / missing `dependsOn`
 *     (`dependsOn` is required, as an array of IDs, for every test in G06..G12).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface IndexEntry {
  testId: string;
  gate: string;
  dependsOn?: unknown;
}

export type ProblemKind =
  | "duplicate_id"
  | "bad_gate"
  | "bad_depends_on"
  | "missing_depends_on"
  | "self_dependency"
  | "unknown_id"
  | "gate_order"
  | "cycle";

export interface Problem {
  kind: ProblemKind;
  test?: string;
  detail: string;
}

const GATE_RE = /^G(\d{2})$/;
const gateNo = (g: string): number | null => {
  const m = GATE_RE.exec(g);
  return m ? Number(m[1]) : null;
};

export function validateDeps(tests: IndexEntry[]): Problem[] {
  const problems: Problem[] = [];
  const byId = new Map<string, IndexEntry>();
  for (const t of tests) {
    if (byId.has(t.testId))
      problems.push({ kind: "duplicate_id", test: t.testId, detail: `duplicate test ID ${t.testId}` });
    else byId.set(t.testId, t);
    if (gateNo(t.gate) === null)
      problems.push({ kind: "bad_gate", test: t.testId, detail: `gate "${t.gate}" is not of the form Gnn` });
  }

  const edges = new Map<string, string[]>();
  for (const t of byId.values()) {
    const g = gateNo(t.gate);
    const raw = t.dependsOn;
    if (raw === undefined) {
      if (g !== null && g >= 6)
        problems.push({
          kind: "missing_depends_on",
          test: t.testId,
          detail: `${t.testId} (${t.gate}) has no dependsOn array`,
        });
      edges.set(t.testId, []);
      continue;
    }
    if (!Array.isArray(raw) || raw.some((d) => typeof d !== "string")) {
      problems.push({
        kind: "bad_depends_on",
        test: t.testId,
        detail: `${t.testId}.dependsOn must be an array of test IDs`,
      });
      edges.set(t.testId, []);
      continue;
    }
    const out: string[] = [];
    for (const d of raw as string[]) {
      if (d === t.testId) {
        problems.push({ kind: "self_dependency", test: t.testId, detail: `${t.testId} depends on itself` });
        continue;
      }
      const dep = byId.get(d);
      if (!dep) {
        problems.push({
          kind: "unknown_id",
          test: t.testId,
          detail: `${t.testId} depends on unknown test ${d}`,
        });
        continue;
      }
      const dg = gateNo(dep.gate);
      if (g !== null && dg !== null && dg > g)
        problems.push({
          kind: "gate_order",
          test: t.testId,
          detail: `${t.testId} (${t.gate}) depends on ${d} (${dep.gate}), a later gate`,
        });
      out.push(d);
    }
    edges.set(t.testId, out);
  }

  // cycle detection (iterative DFS, one report per distinct cycle node set)
  const state = new Map<string, 1 | 2>();
  const seen = new Set<string>();
  for (const root of edges.keys()) {
    if (state.has(root)) continue;
    const stack: { id: string; i: number }[] = [{ id: root, i: 0 }];
    const path: string[] = [root];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const next = (edges.get(top.id) ?? [])[top.i++];
      if (next === undefined) {
        state.set(top.id, 2);
        stack.pop();
        path.pop();
        continue;
      }
      const st = state.get(next);
      if (st === 1) {
        const cyc = path.slice(path.indexOf(next));
        const key = [...cyc].sort().join(",");
        if (!seen.has(key)) {
          seen.add(key);
          problems.push({
            kind: "cycle",
            test: next,
            detail: `dependency cycle: ${[...cyc, next].join(" -> ")}`,
          });
        }
      } else if (st === undefined) {
        state.set(next, 1);
        stack.push({ id: next, i: 0 });
        path.push(next);
      }
    }
  }
  return problems;
}

export function readIndex(path: string): IndexEntry[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { tests?: IndexEntry[] };
  if (!Array.isArray(raw.tests)) throw new Error(`${path}: no "tests" array`);
  return raw.tests;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const path = process.argv[2] ?? join(here, "..", "..", "tests", "TEST_INDEX.json");
  const tests = readIndex(path);
  const problems = validateDeps(tests);
  if (problems.length) {
    for (const p of problems) console.error(`${p.kind}\t${p.detail}`);
    console.error(`test:deps FAILED: ${problems.length} problem(s) in ${tests.length} tests`);
    process.exit(1);
  }
  const edgeCount = tests.reduce((n, t) => n + (Array.isArray(t.dependsOn) ? t.dependsOn.length : 0), 0);
  console.log(
    `test:deps OK: ${tests.length} tests, ${edgeCount} dependency edges, acyclic, gate order respected`,
  );
}
