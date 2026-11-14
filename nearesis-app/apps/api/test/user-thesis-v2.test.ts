import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AnalyticsPanelData } from "@nearesis/contracts";
import {
  buildWorkspaceRunCapsule,
  canonicalJson,
  computeResults,
} from "../../../packages/capsule/src/index.ts";
import type { RunFinding, RunPanel, TestRequest } from "../../../packages/capsule/src/index.ts";
import { analyticsPanel } from "../src/panel-data.ts";
import type { PanelDataPort } from "../src/panel-data.ts";
import { readCapsuleFacts } from "../src/user-thesis/facts.ts";
import { buildThesis } from "../src/user-thesis/generate.ts";
import type { ThesisInputs } from "../src/user-thesis/generate.ts";
import { RULE_V2, evaluateRuleV2, ppmText } from "../src/user-thesis/rule.ts";
import { BOOTSTRAP, blockBootstrap, rank2, relationshipStats } from "../src/user-thesis/stats.ts";
import { classifyNote, groupNotes, relationOfFinding } from "../src/user-thesis/evidence.ts";
import { numberReferences } from "../src/user-thesis/references.ts";
import { renderThesisMarkdown } from "../src/user-thesis/render.ts";
import { rerunThesis } from "../src/user-thesis/rerun.ts";
import { docHash, verifyWorkspaceThesis } from "../src/user-thesis/verify.ts";

const tmp = mkdtempSync(join(tmpdir(), "thesis-v2-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const day = (i: number): string =>
  new Date(Date.parse("2026-08-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
const HA = "a".repeat(64);
const HB = "b".repeat(64);
const N = 70;
const idx = Array.from({ length: N }, (_, i) => i);

/** An analytics panel body as the panel-data route returns it. */
function analyticsBody(
  hash: string,
  columns: Array<[string, string | null]>,
  rows: unknown[][],
): AnalyticsPanelData {
  return {
    chart: {
      queryHash: hash,
      dataRevision: 1,
      columns: columns.map(([name, unit]) => ({ name, unit })),
      rows,
      downsampling: { method: "none", originalPoints: rows.length },
      freshness: "fresh",
      sourceWatermark: "2026-11-12",
    },
    shape: {
      queryHash: hash,
      fields: columns.map(([name, unit], i) => ({ name, unit, role: i === 0 ? "time" : "measure" })),
    },
    provenance: {
      queryHash: hash,
      sourceLabel: "ANALYTICS",
      certification: "certified",
      capability: "intents.analyze@1",
      analysis: "trend",
      call: { capability: "intents.analyze@1", input: { analysis: "trend" } },
      resultHash: "c".repeat(64),
      sources: ["nearesis_live.intents_swaps"],
      metricVersion: "intents-1.0.0",
      definition: "d",
      method: "m",
      asOf: "2026-11-12",
      computedAt: "2026-11-13T00:00:00.000Z",
      coverage: { state: "complete", daysRequested: N, daysWithData: N, missingDays: [], incompleteDays: [] },
      caveats: [],
    },
    cannotCompute: null,
    truncated: false,
  } as unknown as AnalyticsPanelData;
}
const toRunPanel = (hash: string, title: string, a: AnalyticsPanelData): RunPanel => ({
  hash,
  title,
  body: JSON.parse(JSON.stringify({ workspaceId: "w", ...analyticsPanel(hash, a) })) as Record<
    string,
    unknown
  >,
});

const wave = (i: number): number => 20000 + i * 150 + Math.round(900 * Math.sin(i / 3));
const swaps = idx.map(wave);
const refunded = idx.map((i) => 150 + ((i * 37) % 23) * 9);
const success = idx.map((i) => swaps[i]! - refunded[i]!);
const refundRate = idx.map((i) => (refunded[i]! / swaps[i]!).toFixed(6));
const volume = idx.map((i) => 5_000_000 + 40 * swaps[i]! + ((i * 13) % 11) * 500);

const COLS: Array<[string, string | null]> = [
  ["period", null],
  ["swaps", "swaps"],
  ["success", "swaps"],
  ["refunded", "swaps"],
  ["refundRate", "ratio"],
];
const refundRows = idx.map((i) => [day(i), swaps[i], success[i], refunded[i], refundRate[i]]);
const PA = analyticsBody(HA, COLS, refundRows);
const PB = analyticsBody(
  HB,
  [
    ["period", null],
    ["volumeUsd", "USD"],
  ],
  idx.map((i) => [day(i), volume[i]]),
);

const finding = (statement: string, notes: string[] = [], limits: string[] = []): RunFinding =>
  ({
    id: "f",
    status: "mixed",
    basis: "observation",
    kind: "change",
    statement,
    facts: [{ value: "100", unit: "swaps", resultRef: { column: "swaps", rowIds: [day(0)], queryHash: HA } }],
    limitations: limits,
    skepticNotes: notes,
  }) as unknown as RunFinding;

let seq = 0;
function inputsFor(o: {
  panels: RunPanel[];
  test?: TestRequest;
  findings?: RunFinding[];
  chooserText?: string;
}): ThesisInputs {
  const name = `c${seq++}`;
  const dir = join(tmp, name);
  buildWorkspaceRunCapsule(
    {
      workspaceId: "ws-1",
      runId: `run-${name}`,
      source: "live",
      frozenAt: "2026-11-14T00:00:00.000Z",
      question: "q",
      panels: o.panels,
      findings: o.findings ?? [],
      ...(o.test ? { test: o.test } : {}),
      ...(o.chooserText ? { chooserText: o.chooserText } : {}),
    },
    dir,
  );
  const facts = readCapsuleFacts(dir)!;
  (facts as unknown as { dir: string }).dir = dir;
  return {
    facts,
    workspaceId: "ws-1",
    runId: `run-${name}`,
    question: "q",
    frozenAt: "2026-11-14T00:00:00.000Z",
    verifiedAt: "2026-11-14T01:00:00.000Z",
    capsuleStatus: "reproduced",
    hypothesis: null,
    monitors: [],
    markers: [],
    outlayer: null,
    previous: null,
  };
}
const dirOf = (i: ThesisInputs): string => (i.facts as unknown as { dir: string }).dir;
const P_A = toRunPanel(HA, "Daily refund rate trend", PA);
const P_B = toRunPanel(HB, "Daily volume", PB);
const pair = (
  xh: string,
  xc: string,
  yh: string,
  yc: string,
  extra: Partial<TestRequest> = {},
): TestRequest => ({
  x: { panelHash: xh, column: xc },
  y: { panelHash: yh, column: yc },
  chosenBy: "user",
  ...extra,
});

describe("relationship-v2 verdicts", () => {
  const base = {
    n: 90,
    levelPpm: 700_000n,
    changePpm: 400_000n,
    interval: { loPpm: 500_000n, hiPpm: 850_000n },
    expectedSign: "positive" as const,
    coverageComplete: true as boolean | null,
    mechanical: false,
  };
  it("covers every branch, including a negative relationship the plan expected and 'points the other way'", () => {
    expect(evaluateRuleV2(base).status).toBe("SUPPORTED");
    expect(evaluateRuleV2({ ...base, mechanical: true })).toEqual({
      status: "INVALID_TEST",
      codes: ["INVALID_TEST_MECHANICAL"],
    });
    expect(evaluateRuleV2({ ...base, n: 29 }).status).toBe("INSUFFICIENT_DATA");
    expect(evaluateRuleV2({ ...base, coverageComplete: null }).codes).toContain("COVERAGE_NOT_COMPLETE");
    expect(evaluateRuleV2({ ...base, levelPpm: null }).codes).toContain("CORRELATION_UNDEFINED");
    expect(evaluateRuleV2({ ...base, n: 59 }).codes).toContain("N_BELOW_SUPPORT");
    expect(evaluateRuleV2({ ...base, n: 59 }).status).toBe("MIXED");
    expect(evaluateRuleV2({ ...base, changePpm: 199_999n }).codes).toContain("CHANGE_BELOW_SUPPORT");
    expect(evaluateRuleV2({ ...base, changePpm: -400_000n }).codes).toContain("CHANGE_SIGN_DIFFERS");
    expect(evaluateRuleV2({ ...base, levelPpm: 499_999n }).status).toBe("MIXED");
    expect(evaluateRuleV2({ ...base, interval: { loPpm: -10_000n, hiPpm: 850_000n } }).codes).toContain(
      "INTERVAL_INCLUDES_ZERO",
    );
    // interval includes zero and the level is small
    expect(
      evaluateRuleV2({ ...base, levelPpm: 150_000n, interval: { loPpm: -200_000n, hiPpm: 400_000n } }),
    ).toEqual({ status: "NOT_SUPPORTED", codes: ["INTERVAL_INCLUDES_ZERO_LEVEL_BELOW_FLOOR"] });
    // negative expected: a negative relationship is SUPPORTED
    const neg = {
      ...base,
      expectedSign: "negative" as const,
      levelPpm: -650_000n,
      changePpm: -300_000n,
      interval: { loPpm: -820_000n, hiPpm: -400_000n },
    };
    expect(evaluateRuleV2(neg).status).toBe("SUPPORTED");
    // either: a negative relationship supports too
    expect(evaluateRuleV2({ ...neg, expectedSign: "either" }).status).toBe("SUPPORTED");
    // positive expected but the data point the other way
    expect(evaluateRuleV2({ ...neg, expectedSign: "positive" })).toEqual({
      status: "NOT_SUPPORTED",
      codes: ["POINTS_OTHER_WAY"],
    });
    // wrong sign with an interval that includes zero is not "other way"
    expect(
      evaluateRuleV2({ ...base, levelPpm: -300_000n, interval: { loPpm: -600_000n, hiPpm: 100_000n } })
        .status,
    ).toBe("MIXED");
    expect(ppmText(RULE_V2.supportedLevelPpm)).toBe("0.5");
  });
});

describe("relationship-v2 numbers", () => {
  const input = {
    series: {
      x: { name: "x", unit: "u", points: idx.map((i): [string, string] => [day(i), String(swaps[i])]) },
      y: { name: "y", unit: "u", points: idx.map((i): [string, string] => [day(i), String(volume[i])]) },
    },
  };
  it("is deterministic: the same capsule hash gives the same interval, another hash another one", () => {
    const h = "3f9a1c02".padEnd(64, "0");
    const a = relationshipStats(input, 0, h);
    const b = relationshipStats(input, 0, h);
    expect(a).toEqual(b);
    expect(a.interval!.resamples).toBe(BOOTSTRAP.resamples);
    expect(a.interval!.blockLength).toBe(7);
    expect(a.interval!.seed).toBe("3f9a1c02");
    const c = relationshipStats(input, 0, "11111111".padEnd(64, "0"));
    expect(c.interval).not.toEqual(a.interval);
    expect(a.interval!.loPpm).toBeLessThan(a.levelPpm!);
    expect(a.interval!.hiPpm).toBeGreaterThanOrEqual(a.levelPpm!);
  });
  it("computes change and rank correlations exactly (perfect, inverse and tied cases)", () => {
    const lin = relationshipStats(
      {
        series: {
          x: { name: "x", unit: "u", points: idx.map((i): [string, string] => [day(i), String(i * i)]) },
          y: { name: "y", unit: "u", points: idx.map((i): [string, string] => [day(i), String(-3 * i * i)]) },
        },
      },
      0,
      "00".repeat(32),
    );
    expect(lin.levelPpm).toBe(-1_000_000n);
    expect(lin.changePpm).toBe(-1_000_000n);
    expect(lin.spearmanPpm).toBe(-1_000_000n);
    expect(rank2([5n, 5n, 1n, 9n])).toEqual([5n, 5n, 2n, 8n].map((v) => v)); // 2*average rank: ties share 2+3
    expect(blockBootstrap([1n, 2n], [1n, 2n], "00".repeat(32))).toBeNull();
  });
  it("uses the plan's lag for the primary pairing", () => {
    const s = relationshipStats(input, 7, "00".repeat(32));
    expect(s.pairs).toBe(N - 7);
    expect(s.lagDays).toBe(7);
  });
});

describe("mechanically related series never give a verdict", () => {
  it("success against total swaps (a part of the whole) is INVALID_TEST with the reason, never SUPPORTED", () => {
    const out = buildThesis(inputsFor({ panels: [P_A], test: pair(HA, "swaps", HA, "success") }));
    expect(out.doc.verdict.status).toBe("INVALID_TEST");
    expect(out.doc.verdict.headline).toMatch(/^INVALID_TEST: swaps and success are mechanically related/);
    expect(out.doc.test).toMatchObject({
      partOfWhole: true,
      relatedness: { status: "mechanical", code: "PART_OF_WHOLE", heuristic: true },
      reasons: ["INVALID_TEST_MECHANICAL"],
    });
    expect(out.doc.sections[0]!.markdown).toMatch(/No verdict on the claim is given/);
    expect(out.doc.sections.find((s) => s.id === "evidence-against")!.markdown).toMatch(
      /mechanically related/,
    );
  });
  it("identical series, and a ratio against its own numerator, are INVALID_TEST; its denominator only adds a note", () => {
    const same = analyticsBody(
      HB,
      [
        ["period", null],
        ["swapsCopy", "swaps"],
      ],
      idx.map((i) => [day(i), swaps[i]]),
    );
    const dup = buildThesis(
      inputsFor({
        panels: [P_A, toRunPanel(HB, "Copy", same)],
        test: pair(HA, "swaps", HB, "swapsCopy"),
      }),
    );
    expect(dup.doc.test.relatedness).toMatchObject({ code: "IDENTICAL_SERIES" });
    expect(dup.doc.verdict.status).toBe("INVALID_TEST");
    const num = buildThesis(inputsFor({ panels: [P_A], test: pair(HA, "refunded", HA, "refundRate") }));
    expect(num.doc.test.relatedness).toMatchObject({ code: "RATIO_OF_PREDICTOR" });
    expect(num.doc.verdict.status).toBe("INVALID_TEST");
    const den = buildThesis(inputsFor({ panels: [P_A], test: pair(HA, "swaps", HA, "refundRate") }));
    expect(den.doc.test.relatedness).toMatchObject({ status: "independent", code: "INDEPENDENT" });
    expect((den.doc.test.relatedness as { notes: string[] }).notes[0]).toMatch(/denominator/);
    expect(den.doc.verdict.status).not.toBe("INVALID_TEST");
    expect(den.doc.sections.find((s) => s.id === "evidence-against")!.markdown).toMatch(
      /Note \(heuristic check\): .*denominator/,
    );
  });
});

describe("the test is chosen for the question", () => {
  it("an explicit pair is used and recorded as chosen by the user, with the plan's own sentence", () => {
    const out = buildThesis(
      inputsFor({
        panels: [P_A, P_B],
        test: pair(HA, "swaps", HB, "volumeUsd", { expectedSign: "positive" }),
      }),
    );
    expect(out.doc.test).toMatchObject({
      rule: "relationship-v2",
      x: { name: "swaps" },
      y: { name: "volumeUsd" },
      pairSelection: { chosenBy: "user", namedForQuestion: true, label: null },
      plan: { chosenBy: "user", expectedSign: "positive", relation: "moves_with", lagDays: 0 },
    });
    expect(out.doc.hypothesis).toBe("Days with higher swaps have higher volume usd.");
    expect(out.doc.sections[0]!.markdown).toContain(
      "> Claim under test: Days with higher swaps have higher volume usd.",
    );
    expect(out.doc.sections[0]!.markdown).toContain("Test pair named for the question by user");
    expect(out.doc.test.plan).toMatchObject({ lockedAt: null, resolved: { x: { column: "swaps" } } });
  });
  it("the question-matching chooser tests swap count against the refund RATE (not a part of the swaps), chosen by rule and named", () => {
    const out = buildThesis(
      inputsFor({
        panels: [P_A, P_B],
        chooserText: "Do busy NEAR Intents days have more refunds?",
      }),
    );
    expect(out.doc.test).toMatchObject({
      x: { name: "swaps" },
      y: { name: "refundRate" },
      pairSelection: { chosenBy: "rule", namedForQuestion: true },
      plan: { expectedSign: "positive", chosenBy: "rule" },
    });
    expect(out.doc.hypothesis).toBe("Days with higher swaps have higher refund rate.");
    expect(out.doc.verdict.status).not.toBe("INVALID_TEST");
  });
  it("without a matching pair the old rule is the last fallback and the thesis says so", () => {
    const out = buildThesis(inputsFor({ panels: [P_A, P_B], chooserText: "Zebra migration patterns" }));
    expect(out.doc.test).toMatchObject({
      pairSelection: {
        chosenBy: "rule",
        namedForQuestion: false,
        label: "pair chosen by rule, not named for the question",
      },
    });
    expect(out.doc.sections[0]!.markdown).toMatch(/Pair chosen by rule, not named for the question/);
    expect(out.doc.sections.find((s) => s.id === "methods")!.markdown).toMatch(
      /Pair chosen by rule, not named for the question/,
    );
  });
});

describe("each panel's sentence describes its own primary column (regression: wrong-column sentences)", () => {
  it("two panels over the same table shape give different, correct sentences, and a ratio reads as a percent", () => {
    const swapsPanel = toRunPanel(HB, "Daily swap count trend", {
      ...PA,
      chart: { ...PA.chart, queryHash: HB },
    } as AnalyticsPanelData);
    const out = buildThesis(
      inputsFor({ panels: [P_A, swapsPanel], test: pair(HA, "swaps", HA, "refundRate") }),
    );
    const [refund, count] = out.doc.charts as Array<{ sentence: string; primary: string; title: string }>;
    expect(refund!.primary).toBe("refundRate");
    expect(count!.primary).toBe("swaps");
    expect(refund!.sentence).toMatch(
      /^Daily refund rate trend \(refundRate\) went from [\d.]+% on 2026-08-01 to [\d.]+% on 2026-10-09/,
    );
    expect(refund!.sentence).not.toMatch(/swaps/);
    expect(count!.sentence).toMatch(/^Daily swap count trend \(swaps\) went from [\d,]+ swaps on 2026-08-01/);
    expect(refund!.sentence).not.toBe(count!.sentence);
    const claim = (out.doc.claims as Array<{ id: string; estimate: string }>).find(
      (c) => c.id === `claim-observed-${(out.doc.charts[0] as { id: string }).id}`,
    )!;
    expect(claim.estimate).toMatch(/refundRate/);
    expect(claim.estimate).toMatch(/%/);
    expect(claim.estimate).not.toMatch(/\d swaps/);
  });
  it("uses the column the canvas encodes as y when the run recorded it", () => {
    const rec = { ...P_A, primaryColumn: "refunded" };
    const out = buildThesis(inputsFor({ panels: [rec], test: pair(HA, "swaps", HA, "refundRate") }));
    expect((out.doc.charts[0] as { primary: string }).primary).toBe("refunded");
    expect((out.doc.charts[0] as { sentence: string }).sentence).toMatch(
      /\(refunded\) went from [\d,]+ swaps/,
    );
  });
});

describe("evidence sections that say something", () => {
  const notes = [
    "The swap panel has a coverage gap on one day.",
    "Partial days make the daily totals lower bounds for some dates.",
    "Unknown values inside the gap should not be treated as zero.",
    "Coverage of the latest day is incomplete in the source.",
    "Missing rows in the refund table are not counted as zero.",
    "The swap panel has a coverage gap on one day.",
    "The window was chosen by the planner and a different start could change the result.",
    "Refund classification is experimental and may be revised.",
    "Correlation is not causation: shared external conditions could move both series.",
  ];
  it("deduplicates and groups notes, shows at most three per group and counts the rest", () => {
    const g = groupNotes(
      notes.map((t, i) => ({ text: t, pointer: `/0/skepticNotes/${i}`, kind: "skeptic" as const })),
    );
    expect(g.coverage.length).toBe(5);
    expect(g.window.length).toBe(1);
    expect(g.measurement.length).toBe(1);
    expect(g.causation.length).toBe(1);
    expect(classifyNote("Correlation is not causation")).toBe("causation");
    const out = buildThesis(
      inputsFor({
        panels: [P_A],
        test: pair(HA, "swaps", HA, "refundRate"),
        findings: [finding("Swaps were high on one day.", notes)],
      }),
    );
    const md = out.doc.sections.find((s) => s.id === "evidence-against")!.markdown;
    expect(md).toContain("**Coverage**");
    expect(md).toContain("**Window choice**");
    expect(md).toContain("**Measurement**");
    expect(md).toContain("**Causation**");
    expect(
      (
        md.match(
          /> Skeptic note: (The swap panel has a coverage gap|Partial days|Unknown values|Coverage of the latest|Missing rows)/g,
        ) ?? []
      ).length,
    ).toBe(3);
    expect(md).toMatch(/- 2 more coverage notes in the capsule/);
    expect(md.match(/The swap panel has a coverage gap on one day/g)!.length).toBe(1);
  });
  it("surfaces a finding that contradicts a SUPPORTED verdict at the top of Evidence against, labelled a heuristic", () => {
    const contra = finding(
      "Swaps and the refund rate spiked on the same day, a coincident spike that is not a general association between swaps and refunds.",
      ["Correlation is not causation."],
    );
    const tight = analyticsBody(
      HA,
      [
        ["period", null],
        ["swaps", "swaps"],
        ["refundRate", "ratio"],
      ],
      idx.map((i) => [day(i), swaps[i], (0.01 + 0.000002 * (swaps[i]! - 20000)).toFixed(6)]),
    );
    const out = buildThesis(
      inputsFor({
        panels: [toRunPanel(HA, "Daily refund rate trend", tight)],
        test: pair(HA, "swaps", HA, "refundRate", { expectedSign: "positive" }),
        findings: [contra],
      }),
    );
    expect(out.doc.verdict.status).toBe("SUPPORTED");
    const against = out.doc.sections.find((s) => s.id === "evidence-against")!.markdown;
    const lines = against.split("\n");
    expect(lines[0]).toMatch(
      /^- Heuristic phrase match: 1 finding\(s\) of this run say there is no general association .* cuts against the SUPPORTED verdict/,
    );
    expect(lines[1]).toMatch(/^> Finding \(mixed, observation\): Swaps and the refund rate spiked/);
    const forMd = out.doc.sections.find((s) => s.id === "evidence-for")!.markdown;
    expect(forMd).not.toContain("Swaps and the refund rate spiked");
    expect(forMd).toMatch(/heuristic/);
    expect(relationOfFinding(contra.statement, "swaps", "refundRate", "positive")).toBe("contradicts");
    expect(
      relationOfFinding("Swaps and the refund rate moved together.", "swaps", "refundRate", "positive"),
    ).toBe("supports");
    expect(relationOfFinding("Swaps rose.", "swaps", "refundRate", "positive")).toBe("none");
  });
});

describe("references are numbered, pointers stay exact in the JSON", () => {
  it("moves pointers out of the prose into a numbered list per section and keeps the exact pointers in the document", () => {
    const out = buildThesis(inputsFor({ panels: [P_A, P_B], test: pair(HA, "swaps", HB, "volumeUsd") }));
    expect(out.markdown).not.toMatch(/\[[a-z-]+\.json#/);
    expect(out.markdown).toMatch(/\n\nReferences\n\n1\. /);
    expect(out.markdown).toMatch(/ \[1\]/);
    for (const s of out.doc.sections) {
      expect(s.markdown).not.toMatch(/\[[a-z0-9-]+\.json#/);
      const used = [...s.markdown.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
      for (const u of used) expect(u).toBeLessThanOrEqual(s.references.length);
    }
    const exec = out.doc.sections[0]!;
    expect(exec.references).toContain("plan.json#/statement");
    expect(exec.references.some((r) => r.startsWith("results.json#/"))).toBe(true);
    expect(out.doc.verdict.whatWouldChangeOurMindRefs.flat().some((r) => r.startsWith("rule.json#/"))).toBe(
      true,
    );
    expect(out.doc.grounding.numbersChecked).toBeGreaterThan(30);
    expect(numberReferences("A 5 [f.json#/a][f.json#/a][g.json#/b]\n| x | [f.json#/a] |")).toEqual({
      markdown: "A 5 [1][2]\n| x | [1] |",
      references: ["f.json#/a", "g.json#/b"],
    });
  });
  it("an older document without references still renders", () => {
    const md = renderThesisMarkdown({
      title: "t",
      doc: {
        version: "v-1",
        generatedAt: "g",
        origin: { capsuleId: "c" },
        sections: [{ id: "s", title: "S", markdown: "A 5 [results.json#/n]" }],
      },
    });
    expect(md).toContain("A 5 [results.json#/n]");
    expect(md).not.toContain("References");
  });
});

describe("verify and rerun on a v2 thesis; an old v1 document still verifies", () => {
  const verifyDeps = (dir: string) => ({ capsuleDir: () => dir, proofBinding: async () => null });
  const byName = (cs: Array<{ name: string; ok: boolean; detail: string }>, n: string) =>
    cs.find((c) => c.name === n)!;

  it("verify recomputes the verifier's numbers and the API's own numbers, and catches a tampered interval", async () => {
    const inp = inputsFor({
      panels: [P_A, P_B],
      test: pair(HA, "swaps", HB, "volumeUsd", { expectedSign: "positive" }),
    });
    const { doc } = buildThesis(inp);
    const checks = await verifyWorkspaceThesis(
      doc,
      docHash(doc),
      inp.facts.capsuleId,
      verifyDeps(dirOf(inp)),
    );
    expect(byName(checks, "testNumbers").ok).toBe(true);
    expect(byName(checks, "relationshipV2")).toMatchObject({ ok: true });
    expect(checks.filter((c) => c.name.startsWith("chart:")).every((c) => c.ok)).toBe(true);
    const bad = JSON.parse(JSON.stringify(doc));
    bad.test.interval.lo = "-0.5";
    const c2 = await verifyWorkspaceThesis(bad, docHash(bad), inp.facts.capsuleId, verifyDeps(dirOf(inp)));
    expect(byName(c2, "relationshipV2").ok).toBe(false);
    expect(byName(c2, "relationshipV2").detail).toMatch(/interval/);
    const flipped = JSON.parse(JSON.stringify(doc));
    flipped.verdict.status = "NOT_SUPPORTED";
    const c3 = await verifyWorkspaceThesis(
      flipped,
      docHash(flipped),
      inp.facts.capsuleId,
      verifyDeps(dirOf(inp)),
    );
    expect(byName(c3, "relationshipV2").detail).toMatch(/verdict SUPPORTED vs NOT_SUPPORTED/);
  });

  it("an old relationship-v1 document (no plan, no references) keeps verifying its numbers", async () => {
    const inp = inputsFor({ panels: [P_A, P_B] });
    const res = computeResults(inp.facts.input) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const v1 = {
      schema: "nearesis.thesis.v1",
      origin: { capsuleId: inp.facts.capsuleId, capsuleHash: inp.facts.capsuleHash },
      charts: [],
      verdict: { status: "SUPPORTED" },
      sections: [
        {
          id: "executive-claim",
          title: "Executive claim",
          markdown: "Verdict **SUPPORTED** [results.json#/n]",
        },
      ],
      test: {
        rule: "relationship-v1",
        n: Number(res.n),
        pearson: ppmText(res.pearson_ppm),
        lag: [{ days: 7, value: ppmText(res.lag_pearson_ppm["7"]) }],
        window: {
          from: inp.facts.input.series.x.points[0]![0],
          to: inp.facts.input.series.x.points.at(-1)![0],
        },
      },
    };
    const checks = await verifyWorkspaceThesis(v1, docHash(v1), inp.facts.capsuleId, verifyDeps(dirOf(inp)));
    expect(byName(checks, "testNumbers")).toMatchObject({ ok: true });
    expect(checks.some((c) => c.name === "relationshipV2")).toBe(false);
    expect(() =>
      renderThesisMarkdown({ title: "old", doc: { ...v1, version: "v", generatedAt: "g" } as never }),
    ).not.toThrow();
  });

  const portOf = (a: Record<string, AnalyticsPanelData>): PanelDataPort =>
    ({
      async stored(hash: string) {
        return a[hash] ? { kind: "analytics", ast: {} } : null;
      },
      async analytics(hash: string) {
        return { status: 200, body: a[hash]! };
      },
      async query() {
        throw new Error("not used");
      },
      async estimate() {
        throw new Error("not used");
      },
      registry: () => {
        throw new Error("not used");
      },
      async close() {},
    }) as unknown as PanelDataPort;
  const session = { tenantId: "t", workspaceId: "thesis-rerun:x", principalId: "p", aclClasses: ["human"] };

  it("rerun re-executes the stored queries and matches the v2 numbers and verdict; changed data is not a match", async () => {
    const inp = inputsFor({
      panels: [P_A, P_B],
      test: pair(HA, "swaps", HB, "volumeUsd", { expectedSign: "positive" }),
    });
    const { doc } = buildThesis(inp);
    const same = await rerunThesis(doc, inp.facts, portOf({ [HA]: PA, [HB]: PB }), session, new Date());
    expect(same.outcome).toBe("match");
    expect(same.rows.map((r) => r.what)).toEqual(
      expect.arrayContaining([
        "verdict",
        "level correlation (plan's pairing)",
        "correlation of day-over-day changes",
        "rank (Spearman) correlation",
        "interval low",
        "interval high",
      ]),
    );
    expect(same.rows.every((r) => r.original === r.reproduced)).toBe(true);
    const changed = analyticsBody(
      HB,
      [
        ["period", null],
        ["volumeUsd", "USD"],
      ],
      idx.map((i) => [day(i), volume[i]! + ((i * 7919) % 97) * 90_000]),
    );
    const drift = await rerunThesis(doc, inp.facts, portOf({ [HA]: PA, [HB]: changed }), session, new Date());
    expect(["drift", "different"]).toContain(drift.outcome);
    expect(drift.rows.some((r) => r.what.includes("correlation") && r.original !== r.reproduced)).toBe(true);
    const missing = await rerunThesis(doc, inp.facts, portOf({ [HA]: PA }), session, new Date());
    expect(missing.outcome).toBe("incomplete");
  });

  it("rerun of an INVALID_TEST thesis reproduces the same INVALID_TEST verdict", async () => {
    const inp = inputsFor({ panels: [P_A], test: pair(HA, "swaps", HA, "success") });
    const { doc } = buildThesis(inp);
    const r = await rerunThesis(doc, inp.facts, portOf({ [HA]: PA }), session, new Date());
    expect(r.outcome).toBe("match");
    expect(r.rows.find((x) => x.what === "verdict")).toMatchObject({
      original: "INVALID_TEST",
      reproduced: "INVALID_TEST",
    });
  });
});

describe("document hash of a v2 thesis is stable", () => {
  it("builds the identical document twice", () => {
    const inp = inputsFor({ panels: [P_A, P_B], test: pair(HA, "swaps", HB, "volumeUsd") });
    const a = buildThesis(inp);
    const b = buildThesis(inp);
    expect(canonicalJson(a.doc)).toBe(canonicalJson(b.doc));
  });
});
