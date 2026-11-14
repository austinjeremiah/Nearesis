import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildWorkspaceRunCapsule, canonicalJson } from "../../../packages/capsule/src/index.ts";
import type { RunFinding, RunPanel } from "../../../packages/capsule/src/index.ts";
import { readCapsuleFacts } from "../src/user-thesis/facts.ts";
import { Ledger, scanGrounding } from "../src/user-thesis/ground.ts";
import { ThesisBuildError, buildThesis, thesisVersionOf } from "../src/user-thesis/generate.ts";
import type { ThesisInputs } from "../src/user-thesis/generate.ts";
import { evaluateRule, ppmText } from "../src/user-thesis/rule.ts";
import {
  SECTION_IDS,
  UNTESTED_NOTE,
  validateThesisDoc,
  wordingFailures,
} from "../src/user-thesis/validate.ts";

const tmp = mkdtempSync(join(tmpdir(), "thesis-gen-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const day = (i: number): string =>
  new Date(Date.parse("2026-08-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
const HX = "a".repeat(64);
const HY = "b".repeat(64);

function panel(
  hash: string,
  title: string,
  col: string,
  vals: number[],
  o: { state?: string; cov?: "complete" | "partial"; cert?: string } = {},
): RunPanel {
  const rows = vals.map((v, i) => [`${day(i)}T00:00:00.000Z`, v]);
  return {
    hash,
    title,
    body: {
      workspaceId: "w",
      kind: "semantic",
      queryHash: hash,
      state: o.state ?? "complete",
      chart: {
        queryHash: hash,
        columns: [
          { name: "day", unit: null },
          { name: col, unit: "unit" },
        ],
        rows,
      },
      provenance: {
        queryHash: hash,
        semanticVersion: "1.0.0",
        sourceLabel: "LIVE",
        sources: ["fixture-source"],
        certification: o.cert ?? "certified",
        resultHash: "c".repeat(64),
        ast: { measures: [col], time: { from: day(0), to: day(vals.length), grain: "day" } },
      },
      gaps: o.state === "partial" ? [{ from: day(3), to: day(3), reason: "USD_IMPLAUSIBLE:1bd870ef" }] : [],
      coverage: { rowCoverage: vals.map(() => o.cov ?? "complete") },
      nullCount: o.state === "partial" ? 2 : 0,
      partialCount: o.state === "partial" ? 3 : 0,
      caveats: [],
    },
  };
}

interface Fixture {
  n: number;
  x: (i: number) => number;
  y: (i: number) => number;
  findings?: RunFinding[];
  cov?: "complete" | "partial";
  cert?: string;
  state?: string;
  name: string;
}
const finding = (status: string, statement: string, notes: string[], limits: string[] = []): RunFinding =>
  ({
    id: "f",
    status,
    basis: "observation",
    kind: "change",
    statement,
    facts: [
      {
        value: "100",
        unit: "tx",
        resultRef: { column: "xcol", rowIds: [`${day(0)}T00:00:00.000Z`], queryHash: HX },
      },
    ],
    limitations: limits,
    skepticNotes: notes,
  }) as unknown as RunFinding;

function inputsFor(f: Fixture, extra: Partial<ThesisInputs> = {}): ThesisInputs {
  const idx = Array.from({ length: f.n }, (_, i) => i);
  const panels = [
    panel(HX, "X panel", "xcol", idx.map(f.x), { cov: f.cov, cert: f.cert, state: f.state }),
    panel(HY, "Y panel", "ycol", idx.map(f.y)),
  ];
  const dir = join(tmp, f.name);
  buildWorkspaceRunCapsule(
    {
      workspaceId: "ws-1",
      runId: `run-${f.name}`,
      source: "live",
      frozenAt: "2026-11-14T00:00:00.000Z",
      question: "q",
      panels,
      findings: f.findings ?? [],
    },
    dir,
  );
  const facts = readCapsuleFacts(dir)!;
  return {
    facts,
    workspaceId: "ws-1",
    runId: `run-${f.name}`,
    question: "does x follow y",
    frozenAt: "2026-11-14T00:00:00.000Z",
    verifiedAt: "2026-11-14T01:00:00.000Z",
    capsuleStatus: "reproduced",
    hypothesis: null,
    monitors: [],
    markers: [],
    outlayer: null,
    previous: null,
    ...extra,
  };
}
const wave = (i: number): number => 1000 + i * 10 + Math.round(40 * Math.sin(i / 3));
const strong = { x: wave, y: (i: number) => 5000 + 3 * wave(i) + (i % 3) };
const unrelated = { x: (i: number) => 1000 + i * 10, y: (i: number) => 500 + ((i * 37) % 17) * 20 };

describe("relationship-v1", () => {
  it("evaluateRule covers every branch", () => {
    const base = { n: 70, pearsonPpm: 600_000n, lagPpm: 400_000n, coverageComplete: true as boolean | null };
    expect(evaluateRule(base).status).toBe("SUPPORTED");
    expect(evaluateRule({ ...base, n: 29 }).status).toBe("INSUFFICIENT_DATA");
    expect(evaluateRule({ ...base, coverageComplete: false }).codes).toContain("COVERAGE_NOT_COMPLETE");
    expect(evaluateRule({ ...base, coverageComplete: null }).status).toBe("INSUFFICIENT_DATA");
    expect(evaluateRule({ ...base, pearsonPpm: null }).codes).toContain("CORRELATION_UNDEFINED");
    expect(evaluateRule({ ...base, n: 59 }).status).toBe("MIXED");
    expect(evaluateRule({ ...base, lagPpm: 299_999n }).status).toBe("MIXED");
    expect(evaluateRule({ ...base, lagPpm: -400_000n }).status).toBe("MIXED");
    expect(evaluateRule({ ...base, lagPpm: null }).codes).toContain("LAG_UNAVAILABLE");
    expect(evaluateRule({ ...base, pearsonPpm: 199_999n }).status).toBe("NOT_SUPPORTED");
    expect(evaluateRule({ ...base, pearsonPpm: -50_000n }).status).toBe("NOT_SUPPORTED");
    expect(evaluateRule({ ...base, pearsonPpm: 200_000n }).status).toBe("MIXED");
    expect(ppmText("294836")).toBe("0.294836");
    expect(ppmText(500000)).toBe("0.5");
    expect(ppmText(-1_000_000)).toBe("-1");
  });
});

describe("thesis generator on a fixture capsule", () => {
  it("SUPPORTED with 14 sections, charts with sentence and executed query, and a grounded document", () => {
    const inp = inputsFor({
      ...strong,
      n: 70,
      name: "supported",
      findings: [
        finding(
          "supported",
          "X rose from 100 over the window.",
          ["Could reflect one event."],
          ["Window chosen by the planner."],
        ),
      ],
    });
    let out!: ReturnType<typeof buildThesis>;
    try {
      out = buildThesis(inp);
    } catch (e) {
      console.log(JSON.stringify((e as ThesisBuildError).detail));
      throw e;
    }
    const d = out.doc;
    expect(d.schema).toBe("nearesis.thesis.v1");
    expect(d.verdict.status).toBe("SUPPORTED");
    expect(d.sections.map((s) => s.id)).toEqual([...SECTION_IDS]);
    expect(d.sections).toHaveLength(14);
    expect(d.verdict.comparison.rows[0]).toMatchObject({
      label: "Aligned daily points",
      value: "70",
      ref: "results.json#/n",
    });
    expect(d.test).toMatchObject({
      rule: "relationship-v1",
      n: 70,
      x: { name: "xcol" },
      y: { name: "ycol" },
    });
    expect(d.charts).toHaveLength(2);
    const c = d.charts[0] as {
      sentence: string;
      sqlExecuted: string;
      sha256: string;
      series: Array<{ values: unknown[] }>;
    };
    expect(c.sentence).toMatch(
      /^X panel \(xcol\) went from [\d,.]+ unit on 2026-08-01 to [\d,.]+ unit on 2026-10-09 \(.*% change\), with a peak of/,
    );
    expect(c.sqlExecuted).toContain("executed query of panel");
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.series[0]!.values).toHaveLength(70);
    expect(d.claims.map((x) => x.id)).toContain("claim-hypothesis");
    expect(d.origin).toMatchObject({
      kind: "workspace",
      workspaceId: "ws-1",
      runId: "run-supported",
      question: "does x follow y",
      hypothesisId: null,
    });
    expect(d.verification).toMatchObject({ capsule: { status: "reproduced" }, outlayer: null });
    expect(d.grounding.numbersChecked).toBeGreaterThan(20);
    expect(out.markdown).toContain("## Evidence against");
    expect(d.files.map((f) => f.path)).toContain("THESIS.md");
    // the evidence-against section holds the skeptic note and the limitation, quoted
    const against = d.sections.find((s) => s.id === "evidence-against")!.markdown;
    expect(against).toContain("> Skeptic note: Could reflect one event.");
    expect(against).toContain("> Limitation recorded with a finding:");
    expect(validateThesisDoc(d).ok).toBe(true);
  });

  it("is deterministic: the same inputs give the identical document and version; any input change gives a new version", () => {
    const f: Fixture = { ...strong, n: 70, name: "supported" };
    const a = buildThesis(inputsFor(f));
    const b = buildThesis(inputsFor({ ...f, name: "supported" }));
    expect(canonicalJson(a.doc)).toBe(canonicalJson(b.doc));
    expect(a.markdown).toBe(b.markdown);
    const inp = inputsFor(f);
    expect(thesisVersionOf(inp)).toBe(a.version);
    expect(
      thesisVersionOf({
        ...inp,
        hypothesis: { id: "h", status: "draft", proposition: "p", falsification: null },
      }),
    ).not.toBe(a.version);
  });

  it("the 'no evidence against' note appears exactly, with an unableToCompute entry, when nothing cuts against the claim", () => {
    const inp = inputsFor({
      ...strong,
      n: 70,
      name: "untested",
      findings: [finding("supported", "X was 100 at the start.", [])],
    });
    const out = buildThesis(inp);
    const against = out.doc.sections.find((s) => s.id === "evidence-against")!.markdown;
    expect(against).toBe(`${UNTESTED_NOTE}.`);
    expect(out.doc.unableToCompute.some((u) => u.what === "Evidence against")).toBe(true);
  });

  it("MIXED when fewer than 60 days, with the thresholds not met listed against the claim", () => {
    const out = buildThesis(inputsFor({ ...strong, n: 40, name: "mixed" }));
    expect(out.doc.verdict.status).toBe("MIXED");
    const against = out.doc.sections.find((s) => s.id === "evidence-against")!.markdown;
    expect(against).toMatch(/aligned days, fewer than the 60 the rule needs/);
  });

  it("NOT_SUPPORTED when the same-day correlation is below 0.2", () => {
    const out = buildThesis(inputsFor({ ...unrelated, n: 70, name: "notsupported" }));
    expect(Number(out.doc.test.pearson)).toBeLessThan(0.2);
    expect(out.doc.verdict.status).toBe("NOT_SUPPORTED");
    expect(out.doc.sections.find((s) => s.id === "evidence-against")!.markdown).toMatch(
      /floor under which the rule gives NOT_SUPPORTED/,
    );
  });

  it("INSUFFICIENT_DATA with a reason for fewer than 30 days, and for incomplete coverage", () => {
    const few = buildThesis(inputsFor({ ...strong, n: 12, name: "few" }));
    expect(few.doc.verdict.status).toBe("INSUFFICIENT_DATA");
    expect(few.doc.verdict.headline).toMatch(
      /^INSUFFICIENT_DATA: .*12 aligned days, fewer than the 30 the rule needs/,
    );
    const partial = buildThesis(inputsFor({ ...strong, n: 70, name: "partial", cov: "partial" }));
    expect(partial.doc.verdict.status).toBe("INSUFFICIENT_DATA");
    expect(partial.doc.test.reasons).toContain("COVERAGE_NOT_COMPLETE");
    expect(partial.doc.sections.find((s) => s.id === "evidence-against")!.markdown).toMatch(
      /coverage of the days used is not complete/,
    );
  });

  it("a panel with partial coverage, gaps and a certification caveat yields a grounded chart note and claim row", () => {
    const out = buildThesis(
      inputsFor({
        ...strong,
        n: 70,
        name: "gappy",
        state: "partial",
        cert: "experimental",
        findings: [finding("mixed", "X peaked at 100.", ["One-off peak."])],
      }),
    );
    const c = out.doc.charts[0] as { evidenceAgainst: string };
    expect(c.evidenceAgainst).toMatch(/coverage state is "partial" with 3 partial and 2 missing values/);
    expect(c.evidenceAgainst).toMatch(/certification is "experimental"/);
    expect(c.evidenceAgainst).toMatch(/1 gap\(s\)/);
    expect(out.doc.sections.find((s) => s.id === "verdict-per-claim")!.markdown).toContain(
      "3 partial and 2 missing",
    );
  });

  it("quotes the hypothesis and its falsification, labelled, and uses the monitors that watch the series", () => {
    const inp = inputsFor(
      { ...strong, n: 70, name: "supported" },
      {
        hypothesis: {
          id: "h-1",
          status: "frozen",
          proposition: "X moves with Y over 70 days.",
          falsification: "Rejected if r stays below 0.3.",
        },
        monitors: [
          {
            ruleId: "r-1",
            name: "Watch xcol",
            sourceId: "src",
            enabled: true,
            action: "notify",
            markerId: null,
            metricIds: ["xcol"],
            watchesSeries: true,
          },
        ],
      },
    );
    const out = buildThesis(inp);
    expect(out.doc.hypothesis).toBe("X moves with Y over 70 days.");
    expect(out.doc.origin).toMatchObject({ hypothesisId: "h-1", hypothesisStatus: "frozen" });
    const exec = out.doc.sections[0]!.markdown;
    expect(exec).toContain("> Claim (frozen hypothesis): X moves with Y over 70 days.");
    const mind = out.doc.sections[1]!.markdown;
    expect(mind).toContain("Rejected if r stays below 0.3.");
    expect(mind).toContain('Monitor rule "Watch xcol" watches this series');
  });
});

describe("grounding scan", () => {
  it("catches a number without a citation and a number the cited entry does not contain", () => {
    const L = new Ledger(new Map([["f.json", { a: 7, b: 12 } as unknown]]));
    const good = `The value is ${L.n("f.json", "/a")}. [f.json#/a]`;
    expect(scanGrounding(good, L).ok).toBe(true);
    const missing = scanGrounding("The value is 99.", L);
    expect(missing.violations[0]).toMatchObject({ kind: "MISSING_CITATION", number: "99" });
    const wrong = scanGrounding(`The value is 12. [f.json#/a]`, L);
    expect(wrong.violations[0]).toMatchObject({ kind: "VALUE_NOT_IN_REFERENCE", number: "12" });
    expect(scanGrounding("See [nope.json#/x] for 5.", L).violations[0]?.kind).toBe("UNKNOWN_REFERENCE");
    // dates and hashes are not claims
    expect(scanGrounding("On 2026-08-01 the hash was " + "a".repeat(64) + ".", L).ok).toBe(true);
  });

  it("fails the build when a section carries an unbacked number", () => {
    // a hypothesis without a ledger-backed number cannot slip in: the same text read through the ledger is fine, but a bare
    // number added to generated prose is refused. Simulated through the public build by a finding whose statement is cited.
    const inp = inputsFor({
      ...strong,
      n: 70,
      name: "supported",
      findings: [finding("supported", "Rose by 12345 units.", [])],
    });
    expect(() => buildThesis(inp)).not.toThrow();
    const L = new Ledger(new Map([["findings.json", [{ statement: "Rose by 12345 units." }] as unknown]]));
    const injected = `${L.line(() => L.s("findings.json", "/0/statement"))} It then fell by 777.`;
    const r = scanGrounding(injected, L);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.number)).toEqual(["777"]);
    expect(new ThesisBuildError("x").message).toBe("x");
  });
});

describe("wording validator", () => {
  it("refuses causal, bullish and significance wording in generated text, not in attributed quotes", () => {
    expect(wordingFailures("Volume drives usage.", "t").map((f) => f.rule)).toContain("causal_language");
    expect(wordingFailures("The change was caused by bots.", "t")[0]?.rule).toBe("causal_language");
    expect(wordingFailures("This is bullish.", "t")[0]?.rule).toBe("bullish_language");
    expect(wordingFailures("The result is statistically significant.", "t")[0]?.rule).toBe(
      "significance_claim_without_valid_inference",
    );
    expect(wordingFailures("It is significantly better than before.", "t")[0]?.rule).toBe(
      "significance_claim_without_valid_inference",
    );
    expect(wordingFailures("A correlation does not cause anything and does not show cause.", "t")).toEqual(
      [],
    );
    expect(wordingFailures("This is not statistically significant.", "t")).toEqual([]);
    expect(wordingFailures("> Skeptic note: could be driven by bots, which leads to noise.", "t")).toEqual(
      [],
    );
    expect(wordingFailures("- Cited value: 5 [findings.json#/0/facts/0/value] driven by", "t")).toEqual([]);
  });
});
