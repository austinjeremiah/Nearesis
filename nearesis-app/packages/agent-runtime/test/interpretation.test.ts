import { describe, expect, it } from "vitest";
import { InterpretedFinding } from "@nearesis/contracts";
import {
  interpretRun,
  scanFindingText,
  type AnalystDraft,
  type DraftFinding,
  type InterpretationModel,
  type PanelResult,
  type SkepticDraft,
} from "../src/index.ts";

const HASH = (c: string) => c.repeat(64).slice(0, 64);
const P_TX = "11111111-1111-4111-8111-111111111111";
const P_SWAP = "22222222-2222-4222-8222-222222222222";
const P_PRICE = "33333333-3333-4333-8333-333333333333";

const day = (i: number) => `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00.000`;
function panel(
  id: string,
  title: string,
  col: string,
  unit: string,
  vals: Array<number | string | null>,
  over: Partial<PanelResult> = {},
): PanelResult {
  return {
    panelId: id,
    title,
    queryHash: HASH(id[0]!),
    semanticVersion: "1.2.0",
    columns: [
      { name: "day", type: "time", unit: null },
      { name: col, type: "number", unit },
    ],
    rows: vals.map((v, i) => [day(i), v]),
    certification: "certified",
    nullCount: 0,
    partialCount: 0,
    gaps: [],
    sourceWatermarks: { near: "2026-05-30T00:00:00.000Z" },
    truncated: false,
    completeness: "complete",
    ...over,
  };
}

const TX = panel(P_TX, "Daily NEAR transactions", "near.tx_count", "count", [1000, 1100, 1200, 1500, 1800]);
const SWAP = panel(
  P_SWAP,
  "Intents swap volume",
  "intents.swap_volume_usd",
  "USD",
  [200, 180, 400, 420, 800],
);
const PRICE = panel(P_PRICE, "NEAR price", "near.price_usd", "USD", [3.1, 3.2, 3.0, 3.4, 3.5]);

const finding = (over: Partial<DraftFinding> = {}): DraftFinding => ({
  kind: "change",
  basis: "observation",
  status: "supported",
  statement: "Daily NEAR transactions rose from 1000 to 1800, a 80% increase, over the window.",
  facts: [
    { value: "1000", unit: "count", op: "cell", of: [{ panelId: P_TX, column: "near.tx_count", row: 0 }] },
    { value: "1800", unit: "count", op: "cell", of: [{ panelId: P_TX, column: "near.tx_count", row: 4 }] },
    {
      value: "80%",
      unit: "percent",
      op: "pct_change",
      of: [
        { panelId: P_TX, column: "near.tx_count", row: 0 },
        { panelId: P_TX, column: "near.tx_count", row: 4 },
      ],
    },
  ],
  limitations: [],
  ...over,
});

function model(
  analyst: AnalystDraft | Error | "hang",
  skeptic: SkepticDraft | Error | "hang" = { notes: [] },
): InterpretationModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async generate<T>(a: { key: string }): Promise<T> {
      calls.push(a.key);
      const v = a.key.includes(":skeptic") ? skeptic : analyst;
      if (v === "hang") return new Promise<T>(() => undefined);
      if (v instanceof Error) throw v;
      return v as T;
    },
  };
}

const base = {
  tenantId: "55555555-5555-4555-8555-555555555555",
  workspaceId: "66666666-6666-4666-8666-666666666666",
  runId: "44444444-4444-4444-8444-444444444444",
  question: "q",
  clock: () => "2026-11-13T00:00:00.000Z",
};

describe("interpretation stage", () => {
  it("produces a grounded observation whose numbers are tied to ResultRef rows", async () => {
    const m = model({ findings: [finding()] });
    const out = await interpretRun({ ...base, panels: [TX, SWAP, PRICE], model: m });
    expect(out.state).toBe("ready");
    const f = out.findings[0]!;
    expect(InterpretedFinding.parse(f)).toBeTruthy();
    expect(f.basis).toBe("observation");
    expect(f.status).toBe("supported");
    const pct = f.facts.find((x) => x.value === "80%")!;
    expect(pct.resultRef.queryHash).toBe(TX.queryHash);
    expect(pct.resultRef.rowIds).toEqual([day(0), day(4)]);
    expect(pct.resultRef.column).toBe("near.tx_count");
    expect(f.panelIds).toEqual([P_TX]);
    expect(m.calls).toEqual([`${base.runId}:interpret`, `${base.runId}:skeptic`]);
  });

  it("rejects a number that is not in the results (UNGROUNDED_NUMBER) and a derived value that does not recompute", async () => {
    const out = await interpretRun({
      ...base,
      panels: [TX],
      model: model({
        findings: [
          finding({ statement: "Daily NEAR transactions rose from 1000 to 1800 and peaked at 2500." }),
          finding({
            statement: "Daily NEAR transactions rose by 95%.",
            facts: [
              {
                value: "95%",
                unit: "percent",
                op: "pct_change",
                of: [
                  { panelId: P_TX, column: "near.tx_count", row: 0 },
                  { panelId: P_TX, column: "near.tx_count", row: 4 },
                ],
              },
            ],
          }),
          finding({
            statement: "ok",
            facts: [
              {
                value: "1000",
                unit: "count",
                op: "cell",
                of: [{ panelId: P_TX, column: "near.tx_count", row: 99 }],
              },
            ],
          }),
        ],
      }),
    });
    expect(out.state).toBe("unavailable");
    expect(out.reason).toBe("NO_GROUNDED_FINDING");
    expect(out.rejected.map((r) => r.reasonCode)).toEqual([
      "UNGROUNDED_NUMBER",
      "BAD_REFERENCE",
      "BAD_REFERENCE",
    ]);
    expect(out.rejected[0]!.detail).toContain("2500");
  });

  it("never treats an unknown (null) cell as zero", async () => {
    const withNull = panel(P_TX, "Daily NEAR transactions", "near.tx_count", "count", [1000, null, 1200]);
    const out = await interpretRun({
      ...base,
      panels: [withNull],
      model: model({
        findings: [
          finding({
            statement: "The second day is 0.",
            facts: [
              {
                value: "0",
                unit: "count",
                op: "cell",
                of: [{ panelId: P_TX, column: "near.tx_count", row: 1 }],
              },
            ],
          }),
        ],
      }),
    });
    expect(out.rejected[0]!.reasonCode).toBe("BAD_REFERENCE");
    expect(out.rejected[0]!.detail).toContain("not treated as zero");
  });

  it("labels observation vs inference, and an observation may not use inference wording", async () => {
    const swapFacts = [
      {
        value: "200",
        unit: "USD",
        op: "cell" as const,
        of: [{ panelId: P_SWAP, column: "intents.swap_volume_usd", row: 0 }],
      },
      {
        value: "800",
        unit: "USD",
        op: "cell" as const,
        of: [{ panelId: P_SWAP, column: "intents.swap_volume_usd", row: 4 }],
      },
    ];
    const out = await interpretRun({
      ...base,
      panels: [TX, SWAP],
      model: model({
        findings: [
          finding({
            kind: "comparison",
            basis: "inference",
            statement:
              "Intents swap volume went from 200 to 800 while transactions also rose; the two series moved together, which suggests a shared adoption wave.",
            facts: swapFacts,
          }),
          finding({
            kind: "comparison",
            basis: "observation",
            statement: "Intents swap volume went from 200 to 800, which suggests growth.",
            facts: swapFacts,
          }),
          finding({
            kind: "trend",
            basis: "observation",
            statement: "Intents swap volume went from 200 to 800.",
            facts: swapFacts,
          }),
        ],
      }),
    });
    expect(out.state).toBe("ready");
    expect(out.findings.map((f) => f.basis)).toEqual(["inference", "observation"]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.detail).toContain("observation_uses_inference_language");
    expect(out.findings[0]!.limitations.join(" ")).toContain("Stated as an inference");
  });

  it("the research-inference guard blocks significance and causal claims, but allows their negation", () => {
    const rules = (s: string, basis: "observation" | "inference" = "inference") =>
      scanFindingText(s, [], basis).map((v) => v.rule);
    expect(rules("The rise in swap volume is statistically significant.")).toContain(
      "significance_claim_without_valid_inference",
    );
    expect(rules("Swap volume is significantly higher than before.")).toContain("significance_claim");
    expect(rules("The p-value is below 0.05.")).toContain("significance_claim");
    expect(rules("Higher price caused more transactions.")).toContain("causal_claim");
    expect(rules("Transactions rose because the price rose.")).toContain("causal_claim");
    expect(rules("The price drives swap volume.")).toContain("causal_claim");
    expect(
      rules("The two series moved together. This does not show causation and no significance is claimed."),
    ).toEqual([]);
    expect(rules("Swap volume rose while price fell.", "observation")).toEqual([]);
  });

  it("drops a finding that claims causation or significance (guard violation), keeps the clean one", async () => {
    const out = await interpretRun({
      ...base,
      panels: [TX],
      model: model({
        findings: [
          finding({ statement: "Daily NEAR transactions rose from 1000 to 1800 because the price rose." }),
          finding({
            basis: "inference",
            statement: "Daily NEAR transactions rose from 1000 to 1800, a statistically significant gain.",
          }),
          finding(),
        ],
      }),
    });
    expect(out.findings).toHaveLength(1);
    expect(out.rejected.map((r) => r.reasonCode)).toEqual(["GUARD_VIOLATION", "GUARD_VIOLATION"]);
  });

  it("challenges four or more findings with concurrent skeptic calls over disjoint subsets (same verdict rules, one failure degrades only its own findings)", async () => {
    const four = [0, 1, 2, 3].map((i) =>
      finding({
        statement: `Daily NEAR transactions rose from 1000 to 1800, a 80% increase, in reading ${i === 0 ? "one" : i === 1 ? "two" : i === 2 ? "three" : "four"} of the window.`,
      }),
    );
    const WORDS = ["alpha", "beta", "gamma", "delta"];
    const seen: Array<{ key: string; indexes: number[] }> = [];
    const m: InterpretationModel & { calls: string[] } = {
      calls: [],
      async generate<T>(a: { key: string; prompt?: string }): Promise<T> {
        m.calls.push(a.key);
        if (!a.key.includes(":skeptic")) return { findings: four } as T;
        const indexes = [...(a.prompt ?? "").matchAll(/"index":(\d+)/g)].map((x) => Number(x[1]));
        seen.push({ key: a.key, indexes });
        if (a.key.endsWith(":skeptic:2")) throw new Error("provider hiccup");
        return {
          notes: indexes.map((i) => ({
            findingIndex: i,
            alternativeExplanations: [`Another reading could explain finding ${WORDS[i]}.`],
            selectionEffects: [],
            coverageCaveats: [],
            verdict: i === 1 ? "weakened" : "holds",
          })),
        } as T;
      },
    };
    const out = await interpretRun({ ...base, panels: [TX], model: m });
    expect(out.state).toBe("ready");
    // one analyst call, three skeptic calls with distinct keys, each finding challenged exactly once
    expect(m.calls.filter((k) => k.includes(":skeptic")).sort()).toEqual([
      `${base.runId}:skeptic:0`,
      `${base.runId}:skeptic:1`,
      `${base.runId}:skeptic:2`,
    ]);
    expect(seen.flatMap((x) => x.indexes).sort()).toEqual([0, 1, 2, 3]);
    expect(out.findings[0]!.skepticNotes).toContain("Another reading could explain finding alpha.");
    expect(out.findings[3]!.skepticNotes).toContain("Another reading could explain finding delta.");
    expect(out.findings[1]!.status).toBe("mixed"); // a weakened verdict lowers the status exactly as with one call
    // the failed group (indexes 2) is flagged and carries the standard caveats; the others are not degraded
    expect(out.findings.map((f) => f.skepticDegraded)).toEqual([false, false, true, false]);
    expect(out.findings[2]!.skepticNotes.join(" ")).toContain("skeptic pass was unavailable");
  });

  it("analystSplit: concurrent per-panel analyst calls plus one across panels, same grounding, a failed call leaves a stated gap", async () => {
    const calls: Array<{ key: string; system: string }> = [];
    const m: InterpretationModel = {
      async generate<T>(a: { key: string; system: string; prompt: string }): Promise<T> {
        calls.push({ key: a.key, system: a.system });
        if (a.key.includes(":skeptic")) return { notes: [] } as T;
        if (a.key.endsWith(":interpret:1")) throw new Error("provider hiccup");
        if (a.key.endsWith(":interpret:x"))
          return {
            findings: [
              finding({
                kind: "comparison",
                basis: "inference",
                statement:
                  "Daily NEAR transactions rose from 1000 to 1800, a 80% increase, while intents swap volume also moved; the two series moved over the same window, which does not show that either drives the other.",
              }),
            ],
          } as T;
        // per-panel call: the panel it was given
        return { findings: [finding()] } as T;
      },
    };
    const out = await interpretRun({ ...base, panels: [TX, SWAP, PRICE], model: m, analystSplit: true });
    const analyst = calls
      .filter((c) => !c.key.includes(":skeptic"))
      .map((c) => c.key)
      .sort();
    expect(analyst).toEqual([
      `${base.runId}:interpret:0`,
      `${base.runId}:interpret:1`,
      `${base.runId}:interpret:2`,
      `${base.runId}:interpret:x`,
    ]);
    expect(calls.find((c) => c.key.endsWith(":interpret:0"))!.system).toContain(
      "covers only the panel(s) listed",
    );
    expect(calls.find((c) => c.key.endsWith(":interpret:x"))!.system).toContain("comparing or relating");
    expect(out.state).toBe("ready");
    // the two answered per-panel calls returned the same statement: kept once; the comparison is kept
    expect(out.findings.map((f) => f.kind).sort()).toEqual(["change", "comparison"]);
    // panel group 1 failed: every finding says so
    for (const f of out.findings)
      expect(f.limitations.join(" ")).toContain("did not complete (MODEL_ERROR: provider hiccup)");
    // a single panel is never split
    const single = model({ findings: [finding()] });
    await interpretRun({ ...base, panels: [TX], model: single, analystSplit: true });
    expect(single.calls).toEqual([`${base.runId}:interpret`, `${base.runId}:skeptic`]);
  });

  it("adds skeptic notes: deterministic caveats always, model notes when clean, and a verdict can only lower the status", async () => {
    const sk: SkepticDraft = {
      notes: [
        {
          findingIndex: 0,
          alternativeExplanations: [
            "A single airdrop campaign could produce the same rows.",
            "The result is statistically significant.",
          ],
          selectionEffects: ["The window starts at a local low."],
          coverageCaveats: [],
          verdict: "weakened",
        },
      ],
    };
    const out = await interpretRun({
      ...base,
      panels: [TX, SWAP],
      model: model(
        {
          findings: [
            finding({
              kind: "comparison",
              basis: "inference",
              statement:
                "Daily NEAR transactions rose from 1000 to 1800 while swaps rose; they moved together.",
            }),
          ],
        },
        sk,
      ),
    });
    const f = out.findings[0]!;
    expect(f.skepticNotes.join("\n")).toContain("Correlation is not causation");
    expect(f.skepticNotes).toContain("A single airdrop campaign could produce the same rows.");
    expect(f.skepticNotes).toContain("The window starts at a local low.");
    expect(f.skepticNotes.some((n) => n.includes("statistically significant"))).toBe(false);
    expect(f.status).toBe("mixed");
    expect(f.skepticDegraded).toBe(false);
  });

  it("carries coverage gaps, partial and unknown values into limitations and lowers the status", async () => {
    const gappy = panel(
      P_TX,
      "Daily NEAR transactions",
      "near.tx_count",
      "count",
      [1000, 1100, 1200, 1500, 1800],
      {
        gaps: [
          { from: "2026-05-02T00:00:00.000Z", to: "2026-05-03T00:00:00.000Z", reason: "source not loaded" },
        ],
        partialCount: 1,
        nullCount: 2,
        certification: "experimental",
      },
    );
    const out = await interpretRun({ ...base, panels: [gappy], model: model({ findings: [finding()] }) });
    const f = out.findings[0]!;
    expect(f.status).toBe("mixed");
    const l = f.limitations.join("\n");
    expect(l).toContain("coverage gap");
    expect(l).toContain("not treated as zero");
    expect(l).toContain("partial value");
    expect(l).toContain("experimental");
  });

  it("degrades to 'interpretation unavailable' when the analyst model times out", async () => {
    const out = await interpretRun({ ...base, panels: [TX], model: model("hang"), analystTimeoutMs: 20 });
    expect(out).toMatchObject({ state: "unavailable", reason: "MODEL_TIMEOUT", findings: [] });
  });

  it("keeps findings, flagged degraded, when only the skeptic call times out", async () => {
    const out = await interpretRun({
      ...base,
      panels: [TX],
      model: model({ findings: [finding()] }, "hang"),
      skepticTimeoutMs: 20,
    });
    expect(out.state).toBe("ready");
    const f = out.findings[0]!;
    expect(f.skepticDegraded).toBe(true);
    expect(f.skepticNotes.length).toBeGreaterThan(0);
    expect(f.skepticNotes.join(" ")).toContain("MODEL_TIMEOUT");
  });

  it("reports a budget refusal as BUDGET_EXCEEDED, not as a failure of the panels", async () => {
    const { AgentRuntimeError } = await import("../src/errors.ts");
    const out = await interpretRun({
      ...base,
      panels: [TX],
      model: model(new AgentRuntimeError("BUDGET_EXCEEDED", "over")),
    });
    expect(out).toMatchObject({ state: "unavailable", reason: "BUDGET_EXCEEDED: over" });
  });

  it("returns none when no panel has numeric rows", async () => {
    const out = await interpretRun({
      ...base,
      panels: [panel(P_TX, "x", "c", "u", [])],
      model: model({ findings: [] }),
    });
    expect(out.state).toBe("none");
  });

  it("end to end with mock inference: Daily NEAR transactions vs Intents swap volume since May, with NEAR price", async () => {
    const q = "Daily NEAR transactions vs Intents swap volume since May, with NEAR price";
    const ref = (p: string, c: string, row: number) => ({ panelId: p, column: c, row });
    const out = await interpretRun({
      ...base,
      question: q,
      panels: [TX, SWAP, PRICE],
      model: model(
        {
          findings: [
            finding({
              kind: "trend",
              statement: "Daily NEAR transactions rose from 1000 on 2026-05-01 to 1800 on 2026-05-05.",
            }),
            {
              kind: "comparison",
              basis: "inference",
              status: "supported",
              statement:
                "Intents swap volume rose by 300% while daily NEAR transactions rose by 80%; the two series moved together over the window, which does not show that either drives the other.",
              facts: [
                {
                  value: "300%",
                  unit: "percent",
                  op: "pct_change",
                  of: [ref(P_SWAP, "intents.swap_volume_usd", 0), ref(P_SWAP, "intents.swap_volume_usd", 4)],
                },
                {
                  value: "80%",
                  unit: "percent",
                  op: "pct_change",
                  of: [ref(P_TX, "near.tx_count", 0), ref(P_TX, "near.tx_count", 4)],
                },
              ],
              limitations: [],
            },
            {
              kind: "spike",
              basis: "observation",
              status: "supported",
              statement:
                "Intents swap volume doubled from 180 on 2026-05-02 to 400 on 2026-05-03, the largest one-day step in the window.",
              facts: [
                { value: "180", unit: "USD", op: "cell", of: [ref(P_SWAP, "intents.swap_volume_usd", 1)] },
                { value: "400", unit: "USD", op: "cell", of: [ref(P_SWAP, "intents.swap_volume_usd", 2)] },
              ],
              limitations: [],
            },
            {
              kind: "change",
              basis: "observation",
              status: "supported",
              statement: "The NEAR price moved from 3.1 to 3.5 USD, a 12.9% rise.",
              facts: [
                {
                  value: "12.9%",
                  unit: "percent",
                  op: "pct_change",
                  of: [ref(P_PRICE, "near.price_usd", 0), ref(P_PRICE, "near.price_usd", 4)],
                },
                { value: "3.1", unit: "USD", op: "cell", of: [ref(P_PRICE, "near.price_usd", 0)] },
                { value: "3.5", unit: "USD", op: "cell", of: [ref(P_PRICE, "near.price_usd", 4)] },
              ],
              limitations: [],
            },
          ],
        },
        {
          notes: [
            {
              findingIndex: 1,
              alternativeExplanations: ["A shared market-wide activity wave could lift both series."],
              selectionEffects: ["The window is short."],
              coverageCaveats: [],
              verdict: "holds",
            },
          ],
        },
      ),
    });
    expect(out.state).toBe("ready");
    expect(out.findings.map((f) => f.kind)).toEqual(["trend", "comparison", "spike", "change"]);
    expect(out.rejected.map((r) => `${r.reasonCode}:${r.detail}`)).toEqual([]);
    const cmp = out.findings[1]!;
    expect(cmp.panelIds.sort()).toEqual([P_SWAP, P_TX].sort());
    expect(cmp.skepticNotes.join("\n")).toContain("Correlation is not causation");
    expect(cmp.skepticNotes).toContain("A shared market-wide activity wave could lift both series.");
    for (const f of out.findings) {
      expect(f.facts.length).toBeGreaterThan(0);
      expect(f.skepticNotes.length).toBeGreaterThan(0);
      for (const fact of f.facts) expect(fact.resultRef.rowIds.length).toBeGreaterThan(0);
    }
  });
});
