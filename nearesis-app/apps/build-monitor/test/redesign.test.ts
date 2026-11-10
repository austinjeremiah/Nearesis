import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSnapshot, isTestResultFile, parseBlocker, parseQueue } from "../server/snapshot.ts";
import { tempPaths, testResult, writeEvidence, writeIndex, writeJson } from "./fixtures.ts";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const BLK1 = `# BLK-20261110-001 — Trial credit balance not verifiable

- **Severity:** can_progress_elsewhere
- **Owner:** Human (billing account owner)
- **Status:** OPEN

## Recheck
Still not possible. **Status: OPEN.**

## Resolution 2026-11-10T11:30Z
Owner confirmed. **Status: RESOLVED (owner attestation).**
`;
const BLK3 = `# BLK-20261110-003 — FastFS upload needs a NEAR key

- **Severity:** phase_stop for the OutLayer step; can_progress_elsewhere for the verifier
- **Owner:** Human (account holder)
- **Recheck condition:** done
`;
const BLK4 = `# BLK-20261110-004 — No git remote

- Phase and affected gate: P00 / G00
- Severity: can_progress_elsewhere
- Owner: A1 (workflow file); human (remote creation)
`;

describe("sidecar exclusion", () => {
  it("only <runId>.json names are TestResults", () => {
    expect(isTestResultFile("run1.json")).toBe(true);
    expect(isTestResultFile("run1.evidence.json")).toBe(false);
    expect(isTestResultFile("run1.log.json")).toBe(false);
  });
  it("sidecars next to a TestResult produce no invalid records", () => {
    const p = tempPaths();
    writeIndex(p, [{ testId: "BOOT01", gate: "G00" }]);
    writeEvidence(p, testResult("BOOT01", "PASS", ago(1000), "run1"));
    const dir = join(p.reportsDir, "TESTS/BOOT01");
    writeJson(join(dir, "run1.evidence.json"), { anything: 1 });
    writeJson(join(dir, "run1.log.json"), ["x"]);
    const s = buildSnapshot(p, NOW);
    expect(s.invalid).toEqual([]);
    expect(s.tests[0]?.history).toHaveLength(1);
    expect(s.tests[0]?.latestVerdict).toBe("PASS");
  });
});

describe("blocker markdown parsing", () => {
  it("RESOLVED in a later Resolution section wins over earlier OPEN", () => {
    const b = parseBlocker(BLK1);
    expect(b).toMatchObject({
      id: "BLK-20261110-001",
      status: "RESOLVED",
      severity: "can_progress_elsewhere",
    });
    expect(b.title).toBe("Trial credit balance not verifiable");
  });
  it("handles plain (non-bold) fields and no Status line (defaults OPEN)", () => {
    expect(parseBlocker(BLK4)).toMatchObject({
      id: "BLK-20261110-004",
      status: "OPEN",
      severity: "can_progress_elsewhere",
    });
    expect(parseBlocker(BLK4).owner).toContain("human");
  });
  it("waiting[] lists OPEN human/phase_stop blockers and [OPEN] queue lines only", () => {
    const p = tempPaths();
    const bd = join(p.reportsDir, "BLOCKERS");
    mkdirSync(bd, { recursive: true });
    writeFileSync(join(bd, "BLK-1.md"), BLK1);
    writeFileSync(join(bd, "BLK-3.md"), BLK3);
    writeFileSync(join(bd, "BLK-4.md"), BLK4);
    writeFileSync(
      join(bd, "BLK-9.md"),
      "# BLK-9 — agent only\n\n- Severity: can_progress_elsewhere\n- Owner: A2\n",
    );
    writeFileSync(
      join(p.coordDir, "INTEGRATION_QUEUE.md"),
      "format: `- [OPEN|ACCEPTED] ts`\n- [OPEN] 2026-11-10T12:00Z ENGINE_B contract-change — need field X — packages/x\n- [ACCEPTED] 2026-11-10T11:00Z ENGINE_A integration-ready — done\n",
    );
    const w = buildSnapshot(p, NOW).waiting;
    expect(w.map((x) => `${x.kind}:${x.id}`).sort()).toEqual(
      ["BLOCKER:BLK-20261110-003", "BLOCKER:BLK-20261110-004", expect.stringMatching(/^QUEUE:/)].sort(),
    );
  });
});

describe("queue parsing", () => {
  it("extracts only [OPEN] entries", () => {
    const q = parseQueue(
      "- [OPEN] a b c — summary one — path\n- [REJECTED] x — y\n  - [OPEN] later — second\n",
    );
    expect(q).toHaveLength(2);
    expect(q[0]?.title).toContain("summary one");
  });
});

describe("gate bar shares and upstream lock", () => {
  it("implemented / executed / passed / failed / blocked counts per gate", () => {
    const p = tempPaths();
    writeIndex(p, [
      { testId: "BOOT01", gate: "G00", status: "IMPLEMENTED" },
      { testId: "BOOT02", gate: "G00", status: "IMPLEMENTED" },
      { testId: "BOOT03", gate: "G00" },
      { testId: "K01", gate: "G01" },
    ]);
    writeEvidence(p, testResult("BOOT01", "PASS", ago(1000)));
    writeEvidence(p, testResult("BOOT02", "FAIL", ago(1000)));
    const g0 = buildSnapshot(p, NOW).gates.find((g) => g.gate === "G00");
    expect(g0).toMatchObject({ total: 3, implemented: 2, executed: 2, passed: 1, failed: 1, blocked: 0 });
  });
  it("downstream gate is locked by non-PASS upstream gates", () => {
    const p = tempPaths();
    writeIndex(p, [
      { testId: "BOOT01", gate: "G00" },
      { testId: "K01", gate: "G01" },
      { testId: "D01", gate: "G02" },
      { testId: "S01", gate: "G03" },
      { testId: "A01", gate: "G04" },
    ]);
    let s = buildSnapshot(p, NOW);
    expect(s.gates.find((g) => g.gate === "G04")?.lockedBy).toEqual(["G01", "G03"]);
    expect(s.gates.find((g) => g.gate === "G00")?.lockedBy).toEqual([]);
    for (const t of ["BOOT01", "K01", "D01", "S01"]) writeEvidence(p, testResult(t, "PASS", ago(1000)));
    s = buildSnapshot(p, NOW);
    expect(s.gates.find((g) => g.gate === "G04")?.lockedBy).toEqual([]);
  });
});
