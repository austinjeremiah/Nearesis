/** Release gate evaluator (N07): every required gate G00-G11 PASS from recorded evidence; nothing blocked or fixture-only where live is mandatory. */
export type Verdict = "PASS" | "FAIL" | "BLOCKED_DEPENDENCY" | "NOT_RUN" | "SKIP";
export interface IndexEntry {
  testId: string;
  gate: string;
  definition: string;
  status: string;
  required?: boolean;
  live?: boolean;
}
export interface EvidenceRecord {
  testId: string;
  verdict: Verdict;
  observed?: string | null;
  commitSha: string;
  /** Provenance of the result for mandatory-live items. */
  mode?: "LIVE" | "HUMAN" | "FIXTURE" | "SANDBOX" | "SIMULATED";
}
export interface MandatoryLive {
  gate: string;
  /** Test IDs whose live or human half must be real evidence. */
  testIds: string[];
}
export interface GateDecision {
  accepted: boolean;
  reasons: Array<{ code: string; testId?: string; gate?: string; detail: string }>;
  blocking: string[];
}
export const APPROVED_DEFINITIONS = new Set(["ch16", "16a", "ch16a", "16b", "ch16b"]);
export const RELEASE_GATES = [
  "G00",
  "G01",
  "G02",
  "G03",
  "G04",
  "G05",
  "G06",
  "G07",
  "G08",
  "G09",
  "G10",
  "G11",
];

/** Required IDs are read from the approved definitions in the index; any other entry for a release gate blocks. */
export function evaluateRelease(
  index: IndexEntry[],
  evidence: EvidenceRecord[],
  ctx: { gitSha: string; mandatoryLive: MandatoryLive[]; gates?: string[] },
): GateDecision {
  const reasons: GateDecision["reasons"] = [];
  const gates = ctx.gates ?? RELEASE_GATES;
  const byId = new Map<string, EvidenceRecord>();
  for (const e of evidence) byId.set(e.testId, e); // later records override earlier
  for (const t of index.filter((x) => gates.includes(x.gate))) {
    const e = byId.get(t.testId);
    if (!APPROVED_DEFINITIONS.has(t.definition) || t.status === "UNDEFINED" || t.status === "DEFINED") {
      if (!e || e.verdict !== "PASS") {
        reasons.push({
          code: "NOT_IMPLEMENTED",
          testId: t.testId,
          gate: t.gate,
          detail: `${t.status}/${t.definition}`,
        });
        continue;
      }
    }
    if (!e) reasons.push({ code: "NOT_RUN", testId: t.testId, gate: t.gate, detail: "no recorded evidence" });
    else if (e.verdict === "FAIL")
      reasons.push({ code: "FAIL", testId: t.testId, gate: t.gate, detail: "recorded FAIL" });
    else if (e.verdict === "BLOCKED_DEPENDENCY")
      reasons.push({
        code: "BLOCKED",
        testId: t.testId,
        gate: t.gate,
        detail: "recorded BLOCKED_DEPENDENCY",
      });
    else if (e.verdict === "SKIP")
      reasons.push({ code: "SKIP", testId: t.testId, gate: t.gate, detail: "SKIP never counts" });
    else if (e.verdict === "NOT_RUN")
      reasons.push({ code: "NOT_RUN", testId: t.testId, gate: t.gate, detail: "recorded NOT_RUN" });
    else if (e.verdict === "PASS") {
      if (!e.observed)
        reasons.push({
          code: "NO_OBSERVATION",
          testId: t.testId,
          gate: t.gate,
          detail: "PASS without an observed value",
        });
      if (e.commitSha !== ctx.gitSha)
        reasons.push({
          code: "COMMIT_MISMATCH",
          testId: t.testId,
          gate: t.gate,
          detail: `${e.commitSha.slice(0, 8)} != ${ctx.gitSha.slice(0, 8)}`,
        });
      const ml = ctx.mandatoryLive.find((m) => m.gate === t.gate && m.testIds.includes(t.testId));
      if (ml && e.mode !== "LIVE" && e.mode !== "HUMAN")
        reasons.push({
          code: "LIVE_EVIDENCE_REQUIRED",
          testId: t.testId,
          gate: t.gate,
          detail: `mandatory live or human evidence, got ${e.mode ?? "unlabelled"}`,
        });
    }
  }
  const g12 = gates.includes("G12") ? ctx.mandatoryLive.find((m) => m.gate === "G12") : undefined;
  if (
    g12 &&
    !g12.testIds.every(
      (id) => byId.get(id)?.verdict === "PASS" && ["LIVE", "HUMAN"].includes(byId.get(id)?.mode ?? ""),
    )
  )
    reasons.push({
      code: "G12_HUMAN_EVIDENCE_REQUIRED",
      gate: "G12",
      detail: "G12 is never accepted without human-approved mainnet evidence",
    });
  const blocking = [...new Set(reasons.map((r) => r.testId).filter((x): x is string => !!x))];
  return { accepted: reasons.length === 0, reasons, blocking };
}

/** The rehearsal must use the manifest's image digests. */
export function checkRehearsalDigests(
  manifestImages: Record<string, string | null>,
  deployed: Record<string, string>,
): string[] {
  return Object.entries(manifestImages)
    .filter(([k, v]) => !v || deployed[k] !== v)
    .map(([k]) => k);
}

/** The refusal report names the blocking tests (N07(d)). */
export function refusalReport(d: GateDecision, gitSha: string): string {
  return JSON.stringify(
    { gitSha, accepted: d.accepted, blockingTests: d.blocking, reasons: d.reasons },
    null,
    2,
  );
}
