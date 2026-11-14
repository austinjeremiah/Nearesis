import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MonitorPaths } from "../server/paths.ts";

export function tempPaths(): MonitorPaths {
  const root = mkdtempSync(join(tmpdir(), "monitor-"));
  const p: MonitorPaths = {
    bibleDir: root,
    coordDir: join(root, "coordination"),
    reportsDir: join(root, "reports"),
    testIndex: join(root, "TEST_INDEX.json"),
    repoRoot: root,
  };
  mkdirSync(join(p.coordDir, "agents"), { recursive: true });
  mkdirSync(join(p.reportsDir, "TESTS"), { recursive: true });
  return p;
}

export function agentRecord(over: Record<string, unknown> = {}, now = new Date()): Record<string, unknown> {
  return {
    agentId: "A9",
    parentEngine: "ENGINE_A",
    model: "sonnet",
    taskId: "T-TEST",
    task: "sample task",
    ownedPaths: ["x/**"],
    status: "RUNNING",
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    testsPassed: 0,
    testsFailed: 0,
    blockerIds: [],
    commitSha: null,
    ...over,
  };
}

export function writeJson(path: string, v: unknown): void {
  writeFileSync(path, JSON.stringify(v, null, 2));
}

export function testResult(
  testId: string,
  verdict: string,
  executedAt: string,
  runId = "r1",
): Record<string, unknown> {
  return {
    testId,
    phase: "P00",
    runId,
    executedAt,
    command: "pnpm accept",
    fixtureHash: null,
    commitSha: "abcdef1234",
    runtimeVersions: { node: "24" },
    environment: "local",
    expected: "e",
    observed: "o",
    verdict,
    evidenceRefs: [],
    failureReason: null,
  };
}

export function writeIndex(
  p: MonitorPaths,
  tests: { testId: string; gate: string; status?: string; required?: boolean }[],
): void {
  writeJson(p.testIndex, {
    version: 1,
    tests: tests.map((t) => ({ name: t.testId, status: "NOT_IMPLEMENTED", ...t })),
  });
}

export function writeEvidence(p: MonitorPaths, r: Record<string, unknown>): void {
  const dir = join(p.reportsDir, "TESTS", String(r.testId));
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, `${String(r.runId)}.json`), r);
}
