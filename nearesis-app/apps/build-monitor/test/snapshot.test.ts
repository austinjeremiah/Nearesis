import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEARTBEAT_TIMEOUT_MS } from "@nearesis/contracts";
import { guardPath } from "../server/guard.ts";
import { buildGraph, buildSnapshot, parseEvents } from "../server/snapshot.ts";
import { agentRecord, tempPaths, testResult, writeEvidence, writeIndex, writeJson } from "./fixtures.ts";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

describe("agent liveness", () => {
  it("RUNNING with fresh heartbeat stays RUNNING", () => {
    const p = tempPaths();
    writeJson(join(p.coordDir, "agents/A9.json"), agentRecord({ heartbeatAt: ago(60_000) }));
    const s = buildSnapshot(p, NOW);
    expect(s.agents[0]?.effectiveStatus).toBe("RUNNING");
    expect(s.agents[0]?.heartbeatAgeMs).toBe(60_000);
  });
  it("heartbeat exactly at the timeout is still RUNNING; 1 ms over is STALE", () => {
    const p = tempPaths();
    writeJson(join(p.coordDir, "agents/A9.json"), agentRecord({ heartbeatAt: ago(HEARTBEAT_TIMEOUT_MS) }));
    expect(buildSnapshot(p, NOW).agents[0]?.effectiveStatus).toBe("RUNNING");
    writeJson(
      join(p.coordDir, "agents/A9.json"),
      agentRecord({ heartbeatAt: ago(HEARTBEAT_TIMEOUT_MS + 1) }),
    );
    expect(buildSnapshot(p, NOW).agents[0]?.effectiveStatus).toBe("STALE");
  });
  it("old BLOCKED/DONE records are not turned into STALE", () => {
    const p = tempPaths();
    writeJson(
      join(p.coordDir, "agents/A8.json"),
      agentRecord({ agentId: "A8", status: "DONE", heartbeatAt: ago(3_600_000) }),
    );
    writeJson(
      join(p.coordDir, "agents/A9.json"),
      agentRecord({ status: "BLOCKED", blockerIds: ["BLK-1"], heartbeatAt: ago(3_600_000) }),
    );
    const s = buildSnapshot(p, NOW);
    expect(s.agents.map((a) => a.effectiveStatus)).toEqual(["DONE", "BLOCKED"]);
  });
  it("invalid agent record is shown INVALID with the error, not dropped", () => {
    const p = tempPaths();
    writeJson(join(p.coordDir, "agents/A9.json"), { agentId: "A9", status: "RUNNING" });
    writeFileSync(join(p.coordDir, "agents/A7.json"), "{not json");
    const s = buildSnapshot(p, NOW);
    expect(s.agents).toHaveLength(2);
    expect(s.agents.every((a) => a.effectiveStatus === "INVALID" && !a.valid && a.error)).toBe(true);
    expect(s.invalid).toHaveLength(2);
  });
  it("limit breach flagged when active agents exceed registry limit", () => {
    const p = tempPaths();
    writeJson(join(p.coordDir, "AGENT_REGISTRY.json"), { limits: { ENGINE_A: 1, ENGINE_B: 2 } });
    for (const id of ["A1", "A2"])
      writeJson(
        join(p.coordDir, `agents/${id}.json`),
        agentRecord({ agentId: id, heartbeatAt: ago(1000) }, NOW),
      );
    const s = buildSnapshot(p, NOW);
    expect(s.limits.ENGINE_A).toEqual({ active: 2, max: 1, breach: true });
    expect(s.limits.ENGINE_B.breach).toBe(false);
  });
});

describe("engines", () => {
  const eng = (over: Record<string, unknown>) => ({
    engine: "ENGINE_B",
    name: "B",
    sessionId: null,
    initialized: false,
    model: null,
    currentTask: null,
    currentPhase: null,
    ownedModules: [],
    activeSubagents: [],
    completedTasks: [],
    blockers: [],
    heartbeatAt: null,
    lastCommit: null,
    latestTestResults: null,
    ...over,
  });
  it("uninitialized engine is NOT_STARTED with no invented telemetry", () => {
    const p = tempPaths();
    writeJson(join(p.coordDir, "ENGINE_B_STATUS.json"), eng({}));
    const s = buildSnapshot(p, NOW);
    expect(s.engines.B.state).toBe("NOT_STARTED");
    expect(s.engines.B.heartbeatAgeMs).toBeNull();
    expect(s.engines.B.lastCommit).toBeNull();
  });
  it("initialized engine: ACTIVE vs STALE by heartbeat age; missing file is MISSING", () => {
    const p = tempPaths();
    writeJson(
      join(p.coordDir, "ENGINE_A_STATUS.json"),
      eng({ engine: "ENGINE_A", initialized: true, heartbeatAt: ago(1000) }),
    );
    expect(buildSnapshot(p, NOW).engines.A.state).toBe("ACTIVE");
    writeJson(
      join(p.coordDir, "ENGINE_A_STATUS.json"),
      eng({ engine: "ENGINE_A", initialized: true, heartbeatAt: ago(HEARTBEAT_TIMEOUT_MS + 5) }),
    );
    const s = buildSnapshot(p, NOW);
    expect(s.engines.A.state).toBe("STALE");
    expect(s.engines.B.state).toBe("MISSING");
  });
  it("engine most recent commit comes from agent records when set", () => {
    const p = tempPaths();
    writeJson(join(p.coordDir, "agents/A9.json"), agentRecord({ commitSha: "deadbeef1234" }));
    expect(buildSnapshot(p, NOW).engines.A.lastCommit).toEqual({ sha: "deadbeef1234", source: "agent A9" });
  });
});

describe("gate derivation from evidence", () => {
  const idx = [
    { testId: "BOOT01", gate: "G00" },
    { testId: "BOOT02", gate: "G00" },
    { testId: "K01", gate: "G01" },
    { testId: "D01", gate: "G02" },
    { testId: "S01", gate: "G03" },
  ];
  it("no evidence: everything NOT_RUN, 0%", () => {
    const p = tempPaths();
    writeIndex(p, idx);
    const s = buildSnapshot(p, NOW);
    expect(s.tests.every((t) => t.latestVerdict === "NOT_RUN" && !t.implemented)).toBe(true);
    expect(s.milestone).toMatchObject({ passed: 0, total: 5, percent: 0, basis: "evidence-based" });
    expect(s.phases).toMatchObject({ total: 13, completed: 0, current: "G00" });
  });
  it("latest run by executedAt wins (later FAIL overrides earlier PASS)", () => {
    const p = tempPaths();
    writeIndex(p, idx);
    writeEvidence(p, testResult("BOOT01", "PASS", ago(5000), "old"));
    writeEvidence(p, testResult("BOOT01", "FAIL", ago(1000), "new"));
    const t = buildSnapshot(p, NOW).tests.find((x) => x.testId === "BOOT01");
    expect(t).toMatchObject({ latestVerdict: "FAIL", latestRunId: "new" });
  });
  it("gate passes only when all its tests pass; G01 needs G00", () => {
    const p = tempPaths();
    writeIndex(p, idx);
    writeEvidence(p, testResult("K01", "PASS", ago(1000)));
    let s = buildSnapshot(p, NOW);
    expect(s.gates.find((g) => g.gate === "G01")?.verdict).toBe("WAITING_UPSTREAM");
    writeEvidence(p, testResult("BOOT01", "PASS", ago(1000)));
    s = buildSnapshot(p, NOW);
    expect(s.gates.find((g) => g.gate === "G00")?.verdict).toBe("PENDING");
    writeEvidence(p, testResult("BOOT02", "PASS", ago(1000)));
    s = buildSnapshot(p, NOW);
    expect(s.gates.find((g) => g.gate === "G00")?.verdict).toBe("PASS");
    expect(s.gates.find((g) => g.gate === "G01")?.verdict).toBe("PASS");
    expect(s.phases.completed).toBe(2);
    expect(s.phases.current).toBe("G02");
    expect(s.milestone.percent).toBe(60);
  });
  it("G03 needs G02; G04/G05 need G03 chain", () => {
    const p = tempPaths();
    writeIndex(p, [...idx, { testId: "A01", gate: "G04" }]);
    for (const t of ["BOOT01", "BOOT02", "K01", "S01", "A01"])
      writeEvidence(p, testResult(t, "PASS", ago(1000)));
    let s = buildSnapshot(p, NOW);
    expect(s.gates.find((g) => g.gate === "G03")?.verdict).toBe("WAITING_UPSTREAM");
    expect(s.gates.find((g) => g.gate === "G04")?.verdict).toBe("WAITING_UPSTREAM");
    writeEvidence(p, testResult("D01", "PASS", ago(1000)));
    s = buildSnapshot(p, NOW);
    expect(s.gates.filter((g) => g.verdict === "PASS").map((g) => g.gate)).toEqual([
      "G00",
      "G01",
      "G02",
      "G03",
      "G04",
    ]);
  });
  it("BLOCKED_DEPENDENCY and FAIL surface as blocked phases and counts", () => {
    const p = tempPaths();
    writeIndex(p, idx);
    writeEvidence(p, testResult("BOOT01", "BLOCKED_DEPENDENCY", ago(1000)));
    writeEvidence(p, testResult("K01", "FAIL", ago(1000)));
    const s = buildSnapshot(p, NOW);
    expect(s.counts).toMatchObject({ blocked: 1, failed: 1, passed: 0 });
    expect(s.phases.blocked).toEqual(["G00", "G01"]);
  });
  it("invalid evidence file is reported and ignored for progress; implemented flag comes from index", () => {
    const p = tempPaths();
    writeIndex(p, [{ testId: "BOOT01", gate: "G00", status: "IMPLEMENTED" }]);
    mkdirSync(join(p.reportsDir, "TESTS/BOOT01"), { recursive: true });
    writeJson(join(p.reportsDir, "TESTS/BOOT01/bad.json"), { testId: "BOOT01", verdict: "PASS" });
    const s = buildSnapshot(p, NOW);
    expect(s.tests[0]).toMatchObject({ latestVerdict: "NOT_RUN", implemented: true });
    expect(s.invalid).toHaveLength(1);
  });
  it("latest integration results are the 10 newest", () => {
    const p = tempPaths();
    const ids = Array.from({ length: 12 }, (_, i) => `K${String(i + 1).padStart(2, "0")}`);
    writeIndex(
      p,
      ids.map((testId) => ({ testId, gate: "G01" })),
    );
    ids.forEach((id, i) => writeEvidence(p, testResult(id, "PASS", ago((12 - i) * 1000))));
    const s = buildSnapshot(p, NOW);
    expect(s.latestResults).toHaveLength(10);
    expect(s.latestResults[0]?.testId).toBe("K12");
  });
});

describe("missing files", () => {
  it("empty dirs produce an empty but valid snapshot with notes", () => {
    const p = tempPaths();
    const s = buildSnapshot(
      {
        ...p,
        coordDir: join(p.bibleDir, "nope"),
        reportsDir: join(p.bibleDir, "nope2"),
        testIndex: join(p.bibleDir, "nope.json"),
      },
      NOW,
    );
    expect(s.agents).toEqual([]);
    expect(s.tests).toEqual([]);
    expect(s.tasks).toEqual([]);
    expect(s.milestone.percent).toBe(0);
    expect(s.notes.length).toBeGreaterThan(0);
  });
});

describe("task graph", () => {
  const t = (id: string, dependsOn: string[] = []) => ({
    id,
    title: id,
    phase: "P00" as const,
    owner: "x",
    status: "READY" as const,
    dependsOn,
    tests: [],
  });
  it("layers by longest path, reports unknown deps and survives cycles", () => {
    const g = buildGraph([t("T-A"), t("T-B", ["T-A"]), t("T-C", ["T-A", "T-B"]), t("T-D", ["T-GHOST"])]);
    expect(g.nodes.find((n) => n.id === "T-C")?.layer).toBe(2);
    expect(g.missingDeps).toEqual([{ task: "T-D", dep: "T-GHOST" }]);
    expect(g.edges).toHaveLength(3);
    expect(() => buildGraph([t("T-X", ["T-Y"]), t("T-Y", ["T-X"])])).not.toThrow();
  });
});

describe("event tail parsing", () => {
  it("reports a malformed line and a schema-invalid line, keeps good ones", () => {
    const good = JSON.stringify({
      ts: "2026-11-10T12:00:00Z",
      session: "s",
      engine: "ENGINE_A",
      kind: "heartbeat",
      subject: "x",
    });
    const r = parseEvents(`${good}\n{broken\n${JSON.stringify({ ts: "x" })}\n\n${good}\n`, "E");
    expect(r.events).toHaveLength(2);
    expect(r.invalid.map((i) => i.path)).toEqual(["E:2", "E:3"]);
  });
});

describe("path guard", () => {
  const setup = () => {
    const p = tempPaths();
    writeFileSync(join(p.bibleDir, "ok.md"), "hi");
    mkdirSync(join(p.bibleDir, "sub"));
    writeFileSync(join(p.bibleDir, "sub/a.json"), "{}");
    return p;
  };
  it("serves text files inside the folder", () => {
    const p = setup();
    expect(guardPath(p.bibleDir, "ok.md").ok).toBe(true);
    expect(guardPath(p.bibleDir, "sub/a.json").ok).toBe(true);
  });
  it("rejects traversal, absolute, NUL, missing and non-text", () => {
    const p = setup();
    expect(guardPath(p.bibleDir, "../etc/passwd.md")).toMatchObject({ ok: false, status: 400 });
    expect(guardPath(p.bibleDir, "sub/../../x.md")).toMatchObject({ ok: false, status: 400 });
    expect(guardPath(p.bibleDir, "/etc/hosts.txt")).toMatchObject({ ok: false, status: 400 });
    expect(guardPath(p.bibleDir, "ok.md\0.png")).toMatchObject({ ok: false });
    expect(guardPath(p.bibleDir, "nothere.md")).toMatchObject({ ok: false, status: 404 });
    expect(guardPath(p.bibleDir, "image.png")).toMatchObject({ ok: false, status: 415 });
    expect(guardPath(p.bibleDir, ".env")).toMatchObject({ ok: false, status: 415 });
  });
  it("rejects symlinks that escape the folder", () => {
    const p = setup();
    const outside = tempPaths();
    writeFileSync(join(outside.bibleDir, "secret.md"), "s");
    symlinkSync(join(outside.bibleDir, "secret.md"), join(p.bibleDir, "link.md"));
    symlinkSync(outside.bibleDir, join(p.bibleDir, "linkdir"));
    expect(guardPath(p.bibleDir, "link.md")).toMatchObject({ ok: false, status: 403 });
    expect(guardPath(p.bibleDir, "linkdir/secret.md")).toMatchObject({ ok: false, status: 403 });
  });
});
