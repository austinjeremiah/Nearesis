import type { Chart } from "./charts.ts";
import { commas, fmt, fmtPct, Ledger } from "./ground.ts";
import type { Inputs } from "./inputs.ts";

export const HYPOTHESIS =
  "Cross-chain volume through NEAR Intents is a better leading indicator of real network usage than token price.";

export const SECTION_TITLES = [
  "Executive claim",
  "What would change our mind",
  "Sample and sources",
  "Methods",
  "Primary benchmark",
  "Evidence for",
  "Evidence against",
  "Confounders and blind spots",
  "Long-term economic mechanisms",
  "Verdict per claim",
  "Reproduction",
  "Unable to compute",
  "Source index",
  "Changes since previous version",
] as const;

export const CLAIM_FIELDS = [
  "verdict",
  "estimate",
  "uncertainty",
  "counterexample",
  "falsificationCondition",
  "provenance",
] as const;

export interface Claim {
  id: string;
  statement: string;
  kind: "observed fact" | "derived statistic" | "hypothesis" | "interpretation";
  verdict: string;
  estimate: string | null;
  uncertainty: string | null;
  counterexample: string | null;
  falsification: string;
  provenance: string;
  refs: string[];
}
export interface Unable {
  what: string;
  why: string;
  refs: string[];
}
export interface SectionOut {
  id: string;
  title: string;
  markdown: string;
}
export interface ThesisText {
  markdown: string;
  sections: SectionOut[];
  claims: Claim[];
  unableToCompute: Unable[];
  status: string;
  verdictStatus: "SUPPORTED" | "NOT_SUPPORTED" | "MIXED" | "INSUFFICIENT_DATA";
  headline: string;
  summary: string;
  rows: { label: string; value: string | null; unit: string | null; ref: string }[];
  whatWouldChangeOurMind: string[];
  summaryRefs: string[];
  headlineRefs: string[];
  changeRefs: string[][];
}

const EST = "results/estimates.json";
const PRE = "results/preregistration.json";
const RUN = "results/run_summary.json";
const CEV = "results/counterevidence.json";
const ROB = "results/robustness_matrix.json";
const FAL = "results/falsification.json";
const LIM = "results/limitations.json";
const HYP = "results/hypothesis.json";
const SNAP = "results/inputSnapshot.json";
const REP = "results/reproduction.json";
const MOD = "results/models.json";
const MAN = "raw/manifest.json";

const CAND_LABEL: Record<string, string> = { intents: "+Intents", price: "+price", combined: "+both" };
const CAND_ORDER = ["intents", "price", "combined"];
const cell = (s: string): string => s.replace(/\|/g, "/").replace(/\n/g, " ");
const sig = (x: number): string => fmt(x);
const pct = (x: number): string => fmtPct(x);
const abs = (x: number): string => fmt(Math.abs(x));

export function buildThesisText(inp: Inputs, L: Ledger, charts: Chart[], version: string): ThesisText {
  const est = L.get(EST, "/byHorizonCandidate") as Record<string, Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const keys = Object.keys(est)
    .map((k) => ({ key: k, h: Number(k.split(":")[0]), cand: k.split(":")[1]! }))
    .sort((a, b) => a.h - b.h || CAND_ORDER.indexOf(a.cand) - CAND_ORDER.indexOf(b.cand));
  const horizons = [...new Set(keys.map((k) => k.h))];
  const E = (key: string, f: string): string => `/byHorizonCandidate/${key}/${f}`;
  const N = keys.length;
  const status = String(L.get(RUN, "/status"));
  const strength = String(L.get(RUN, "/evidenceStrength"));
  const verdictStatus = (status === "UNSUPPORTED" ? "NOT_SUPPORTED" : status) as ThesisText["verdictStatus"];
  const pHor = L.get(HYP, "/primaryHorizon") as number;
  const pCand = String(L.get(HYP, "/primaryComparison")).split(" ")[0]!;
  const pKey = `${pHor}:${pCand}`;
  const minOrig = L.get(PRE, "/thresholds/minDevOrigins") as number;
  const delta = (k: string): number => est[k]!.delta_mae as number;
  const worse = keys.filter((k) => delta(k.key) < 0);
  const fdrHits = keys.filter((k) => est[k.key]!.fdr_reject === true);
  const priceBetter = horizons.filter(
    (h) => est[`${h}:price`]!.mae_candidate < est[`${h}:intents`]!.mae_candidate,
  );
  const lowOrigins = horizons.filter((h) => (est[`${h}:intents`]!.n_origins as number) < minOrig);
  const upperPos = keys.filter((k) => (est[k.key]!.delta_mae_ci.hi as number) > 0);
  const cnt = (n: number): string => L.count(EST, "/byHorizonCandidate", n);
  const cntKeys = (n: number): string => cnt(n);
  void cntKeys;
  const sections = new Map<string, string>();
  const sec = (title: (typeof SECTION_TITLES)[number], body: string): void =>
    void sections.set(title, body.trim());

  // ---- shared sentences -------------------------------------------------------------------------------------------
  const reasonLine = (): string => `${L.s(RUN, "/reasons/0")}`;
  const windowLine = (): string => {
    const a = L.s(RUN, "/window/start");
    const b = L.s(RUN, "/window/end");
    const c = L.s(MAN, "/window/from");
    const d = L.s(MAN, "/window/to");
    const same = a === c && b === d;
    return `The research window runs from ${a} to ${b}; the chart window runs from ${c} to ${d}; ${same ? "the two windows are identical" : "the two windows differ, so a chart and a forecast number do not cover the same days"}.`;
  };
  const incompleteSig = (): string => {
    const comps = L.get(EST, "/inferenceSummary/comparisons") as Record<
      string,
      { significanceClaimAllowed: boolean }
    >;
    const m = Object.values(comps).filter((c) => !c.significanceClaimAllowed).length;
    const total = Object.keys(comps).length;
    return `${L.count(EST, "/inferenceSummary/comparisons", m)} of ${L.count(EST, "/inferenceSummary/comparisons", total)}`;
  };

  // ---- 1 Executive claim --------------------------------------------------------------------------------------------
  const claimSentence =
    status === "SUPPORTED"
      ? "the frozen results meet the preregistered criteria for the claim that cross-chain volume through NEAR Intents leads usage better than token price; this is a predictive result only."
      : status === "MIXED"
        ? "the frozen results are mixed on whether cross-chain volume through NEAR Intents is a better leading indicator of real network usage than token price."
        : "the frozen results do not show that cross-chain volume through NEAR Intents is a better leading indicator of real network usage than token price.";
  const headlineParts = L.collect(
    () =>
      `${status}: ${claimSentence.replace(/;.*$/, "").replace(/\.$/, "")}; ${cnt(worse.length)} of ${cnt(N)} added-predictor models had higher out-of-sample error than the baseline.`,
  );
  const exec = [
    `Verdict **${status}** (evidence strength ${strength}): ${claimSentence}`,
    L.line(
      () =>
        `Evidence against comes first: ${cnt(worse.length)} of ${cnt(N)} candidate comparisons had higher out-of-sample error than the baseline, ${cnt(fdrHits.length)} of ${cnt(N)} passed the false discovery rate test, and the model with price had lower error than the model with Intents volume at ${L.count(EST, "/byHorizonCandidate", priceBetter.length)} of ${L.count(EST, "/byHorizonCandidate", horizons.length)} horizons.`,
    ),
    L.line(() => `The run reports ${status} for this reason: \`${reasonLine()}\``),
    L.line(windowLine),
    L.line(
      () =>
        `This is a predictive analysis and not a causal claim, and no statistical-significance claim is made: the comparison method is not validated for ${incompleteSig()} comparisons.`,
    ),
  ].join("\n\n");
  sec("Executive claim", exec);

  // ---- 2 What would change our mind --------------------------------------------------------------------------------
  const changeItems: { text: string; refs: string[] }[] = [];
  const addChange = (fn: () => string): void => void changeItems.push(L.collect(fn));
  addChange(() => {
    const hs = horizons.map((h) => L.n(EST, E(`${h}:intents`, "horizon"))).join(", ");
    const ns = horizons.map((h) => L.n(EST, E(`${h}:intents`, "n_origins"))).join(", ");
    return `At least ${L.n(PRE, "/thresholds/minDevOrigins")} scored origins at every horizon (this run had ${ns} origins at horizons ${hs}).`;
  });
  addChange(
    () =>
      `A relative improvement of at least ${L.n(PRE, "/thresholds/minRelativeImprovement", (x) => pct(x))}% over the baseline, confirmed on a sealed lockbox of ${L.n(RUN, "/lockbox/n")} days (opened in this run: ${String(L.get(RUN, "/lockbox/opened"))}).`,
  );
  addChange(() => {
    const ps = keys.map((k) => est[k.key]!.p_adjusted as number);
    const mk = keys[ps.indexOf(Math.min(...ps))]!.key;
    return `A false discovery rate rejection at q ${L.n(PRE, "/fdr/q")} across the family of ${L.n(EST, "/fdr/m")} comparisons (the smallest adjusted p-value here is ${L.n(EST, E(mk, "p_adjusted"))}).`;
  });
  addChange(
    () =>
      `A ${L.n(PRE, "/thresholds/bootstrap/level", (x) => pct(x))}% moving-block bootstrap interval for the change in error that sits entirely on the side of the candidate (the upper bound for the primary comparison here is ${L.n(EST, E(pKey, "delta_mae_ci/hi"))}).`,
  );
  addChange(
    () =>
      `A placebo p-value at or below ${L.n(PRE, "/thresholds/placebo/alpha")} from ${L.n(PRE, "/thresholds/placebo/n")} placebo draws (placebo ${L.get(FAL, "/placebo") === null ? "was not computed in this run" : "was computed"}).`,
  );
  addChange(
    () =>
      `Robustness variants that agree with the primary sign in at least ${L.n(PRE, "/thresholds/robustnessAgreeShare", (x) => pct(x))}% of cases.`,
  );
  addChange(() => "A complete dataset: every source must report complete coverage for the whole window.");
  addChange(() => "The Intents model beating the price model, not only the baseline, at the same horizon.");
  sec(
    "What would change our mind",
    changeItems.map((c) => `- ${c.text}${c.refs.map((r) => ` [${r}]`).join("")}`).join("\n"),
  );

  // ---- 3 Sample and sources ------------------------------------------------------------------------------------------
  const ds = inp.manifest.datasets;
  const bq = (i: number): string => {
    const d = ds[i]!;
    if (!d.sqlBigQuery) return "no BigQuery source";
    if (!d.bigQueryExecuted) return "BigQuery SQL shipped, not executed in this build";
    const b = d.bigQueryBytesBilled;
    if (b === null) return "BigQuery executed";
    const gib = L.n(MAN, `/datasets/${i}/bigQueryBytesBilled`, (x) => fmt(x / 2 ** 30));
    return `BigQuery executed, ${L.n(MAN, `/datasets/${i}/bigQueryBytesBilled`, (x) => commas(String(x)))} bytes billed (${gib} GiB)`;
  };
  const dsRows = ds.map((d, i) => {
    const r = L.collect(
      () =>
        `| ${cell(d.title)} (${d.id}) | ${L.n(MAN, `/datasets/${i}/rows`, (x) => commas(String(x)))} | ${cell(d.source)} | ${cell(bq(i))} |`,
    );
    return `${r.text} ${r.refs.map((x) => `[${x}]`).join("")} |`;
  });
  const sample = [
    L.line(
      () =>
        `Chart window ${L.s(MAN, "/window/from")} to ${L.s(MAN, "/window/to")}, frozen at ${L.s(MAN, "/frozenAt")}. All chart data is read from the frozen files in thesis/raw; nothing is fetched at build time.`,
    ),
    "| Dataset | Rows | Source | BigQuery | Cited as |\n|---|---|---|---|---|\n" + dsRows.join("\n"),
    L.line(
      () =>
        `Forecast sample (frozen research run ${L.s(RUN, "/snapshotId")}): ${L.n(RUN, "/devScoredOrigins")} scored development origins from ${L.n(RUN, "/developmentRows", (x) => commas(String(x)))} development rows, ${L.n(RUN, "/postRegimeRows")} post-regime rows, ${L.n(RUN, "/lockbox/n")} lockbox days. ${L.n(RUN, "/routes/mappedSwaps", (x) => commas(String(x)))} swaps were mapped to a canonical asset; ${L.n(RUN, "/routes/unmappedOrNullCanonicalSwaps", (x) => commas(String(x)))} of ${L.n(RUN, "/routes/windowSwaps", (x) => commas(String(x)))} swaps were unmapped and are excluded, not guessed.`,
    ),
    "Volume counts only swaps that finished with status SUCCESS, valued at the USD amount recorded for the input side, with swaps that have no USD value left out (a finished swap with no USD value makes that day incomplete). Refunded swaps, whose provider USD values can be implausible, are therefore excluded. Daily totals are floating-point sums.",
    ...ds
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.id === "intents_volume_daily")
      .map(
        ({ d, i }) =>
          L.line(
            () => `Dataset definition recorded in the manifest: ${L.s(MAN, `/datasets/${i}/definition`)}`,
          ) +
          (d.caveats.length
            ? "\n\n" +
              d.caveats
                .map((_, ci) =>
                  L.line(() => `- Caveat from the manifest: ${L.s(MAN, `/datasets/${i}/caveats/${ci}`)}`),
                )
                .join("\n")
            : ""),
      ),
  ].join("\n\n");
  sec("Sample and sources", sample);

  // ---- 4 Methods -------------------------------------------------------------------------------------------------------
  const methods = [
    L.line(
      () =>
        `The test is ${L.s(PRE, "/split/method").replace(/_/g, " ")} forecasting of ${L.s(HYP, "/primaryOutcome")}, with horizons of ${horizons.map((h) => L.n(EST, E(`${h}:intents`, "horizon"))).join(", ")} days and a minimum training length of ${L.n(PRE, "/split/minTrain")} days.`,
    ),
    L.line(
      () =>
        `Models: ${L.s(MOD, "/estimator")}. Candidates add lagged Intents volume, lagged price returns, or both to the baseline of usage and calendar history.`,
    ),
    L.line(
      () =>
        `Uncertainty: a moving-block bootstrap with block length ${L.n(PRE, "/thresholds/bootstrap/block")} and ${L.n(PRE, "/thresholds/bootstrap/n")} resamples gives the ${L.n(PRE, "/thresholds/bootstrap/level", (x) => pct(x))}% intervals; ${L.s(
          PRE,
          "/fdr/method",
        )
          .split("_")
          .map((w) => w[0]!.toUpperCase() + w.slice(1))
          .join(
            "-",
          )} control at q ${L.n(PRE, "/fdr/q")} is applied across the frozen family of ${L.n(EST, "/fdr/m")} comparisons; the last ${L.n(PRE, "/split/lockboxDays")} days form a sealed lockbox; the random seed is ${L.n(PRE, "/randomSeed", (x) => String(x))}.`,
    ),
    "The claim is predictive only. Causality is excluded from the claim, and a forecasting gain would not show that Intents volume moves usage. Every sentence in this document is produced by a deterministic template from the frozen files; no language model writes any number.",
  ].join("\n\n");
  sec("Methods", methods);

  // ---- 5 Primary benchmark ---------------------------------------------------------------------------------------------
  const bench = horizons.map((h) => {
    const r = L.collect(
      () =>
        `| ${L.n(EST, E(`${h}:intents`, "horizon"))} | ${L.n(EST, E(`${h}:intents`, "n_origins"))} | ${L.n(EST, E(`${h}:intents`, "mae_baseline"))} | ${L.n(EST, E(`${h}:intents`, "mae_candidate"))} | ${L.n(EST, E(`${h}:price`, "mae_candidate"))} | ${L.n(EST, E(`${h}:combined`, "mae_candidate"))} |`,
    );
    return `${r.text} ${r.refs.map((x) => `[${x}]`).join("")} |`;
  });
  const deltas = keys.map((k) => {
    const r = L.collect(
      () =>
        `| ${CAND_LABEL[k.cand] ?? k.cand} | ${L.n(EST, E(k.key, "horizon"))} | ${L.n(EST, E(k.key, "n_origins"))} | ${L.n(EST, E(k.key, "delta_mae"))} | ${L.n(EST, E(k.key, "delta_mae_ci/lo"))} to ${L.n(EST, E(k.key, "delta_mae_ci/hi"))} | ${L.n(EST, E(k.key, "relative_improvement"), pct)}% | ${L.n(EST, E(k.key, "p_adjusted"))} |`,
    );
    return `${r.text} ${r.refs.map((x) => `[${x}]`).join("")} |`;
  });
  const primaryLine = L.line(
    () =>
      `The primary comparison is ${CAND_LABEL[pCand] ?? pCand} against the baseline at horizon ${L.n(HYP, "/primaryHorizon")}: mean absolute error ${L.n(EST, E(pKey, "mae_baseline"))} for the baseline against ${L.n(EST, E(pKey, "mae_candidate"))} with Intents added, ${L.n(EST, E(pKey, "n_origins"))} scored origins, a change in error of ${L.n(EST, E(pKey, "delta_mae"))} (negative means the candidate is worse) and an adjusted p-value of ${L.n(EST, E(pKey, "p_adjusted"))}.`,
  );
  sec(
    "Primary benchmark",
    [
      primaryLine,
      "Out-of-sample mean absolute error on the log scale (lower is better), by horizon in days:",
      "| Horizon (days) | Origins | Baseline | +Intents | +price | +both | Source |\n|---|---|---|---|---|---|---|\n" +
        bench.join("\n"),
      "Change in error against the baseline (delta MAE; negative means the candidate had higher error), with the block-bootstrap interval, relative change and false-discovery-rate adjusted p-value:",
      "| Candidate | Horizon (days) | Origins | Delta MAE | Interval | Relative change | Adjusted p | Source |\n|---|---|---|---|---|---|---|---|\n" +
        deltas.join("\n"),
    ].join("\n\n"),
  );

  // ---- 6 Evidence for (descriptive only) -------------------------------------------------------------------------------------
  const chartBullets = ["intents-volume", "intents-swaps"]
    .map((id) => charts.find((c) => c.id === id))
    .filter((c): c is Chart => !!c && c.sentenceRefs.length > 0)
    .map((c) => `- ${c.sentence}${c.sentenceRefs.map((r) => ` [${r}]`).join("")}`);
  const forBullets = [
    ...chartBullets,
    L.line(() => {
      const best = keys.reduce((a, b) =>
        (est[b.key]!.delta_mae_ci.hi as number) > (est[a.key]!.delta_mae_ci.hi as number) ? b : a,
      );
      return `- In ${cnt(upperPos.length)} of ${cnt(N)} comparisons the upper bound of the interval is above zero, so a small gain cannot be ruled out; the most favourable bound is ${L.n(EST, E(best.key, "delta_mae_ci/hi"))} for ${CAND_LABEL[best.cand] ?? best.cand} at horizon ${L.n(EST, E(best.key, "horizon"))}.`;
    }),
    "- None of this is a forecasting gain. Activity through Intents is observed and the series move, but the preregistered test found no model that used it to predict usage better than the baseline; see Evidence against.",
  ];
  sec("Evidence for", forBullets.join("\n"));

  // ---- 7 Evidence against --------------------------------------------------------------------------------------------------
  const robRows = L.get(ROB, "/rows") as Record<
    string,
    { status: string; estimates?: { delta_mae: number }[]; n_origins?: number; reason?: string }
  >;
  const robKeys = Object.keys(robRows).sort();
  const robOk = robKeys.filter((k) => robRows[k]!.status === "OK" && robRows[k]!.estimates?.[0]);
  const robNeg = robOk.filter((k) => robRows[k]!.estimates![0]!.delta_mae < 0);
  const robTable = robKeys.map((k) => {
    const r = robRows[k]!;
    const body = L.collect(() => {
      if (r.status === "OK" && r.estimates?.[0]) {
        return `| ${k} | ${r.status} | ${L.n(ROB, `/rows/${k}/n_origins`)} | ${L.n(ROB, `/rows/${k}/estimates/0/delta_mae`)} | ${L.n(ROB, `/rows/${k}/estimates/0/relative_improvement`, pct)}% | |`;
      }
      return `| ${k} | ${r.status} | | | | ${cell(L.s(ROB, `/rows/${k}/reason`))} |`;
    });
    return `${body.text} ${body.refs.map((x) => `[${x}]`).join("")} |`;
  });
  const cev = L.get(CEV, "/") as { kind: string; candidate: string; horizon: number }[];
  const againstBullets = [
    L.line(() => {
      const worst = keys.reduce((a, b) =>
        est[b.key]!.relative_improvement < est[a.key]!.relative_improvement ? b : a,
      );
      return `- Every candidate did worse than the baseline: ${cnt(worse.length)} of ${cnt(N)} comparisons have negative delta MAE (higher out-of-sample error). The largest shortfall is ${L.n(EST, E(worst.key, "relative_improvement"), (x) => abs(x * 100))}% for ${CAND_LABEL[worst.cand] ?? worst.cand} at horizon ${L.n(EST, E(worst.key, "horizon"))}.`;
    }),
    L.line(() => {
      const ps = keys.map((k) => est[k.key]!.p_adjusted as number);
      const mk = keys[ps.indexOf(Math.min(...ps))]!.key;
      return `- No comparison passes the false discovery rate test: ${cnt(fdrHits.length)} of ${cnt(N)} rejections at q ${L.n(PRE, "/fdr/q")}; the smallest adjusted p-value is ${L.n(EST, E(mk, "p_adjusted"))}. The counterevidence file lists ${L.count(CEV, "", cev.length)} entries of kind ${L.s(
        CEV,
        "/0/kind",
      )
        .replace(/_/g, " ")
        .replace(/\bfdr\b/g, "FDR")}.`;
    }),
    L.line(
      () =>
        `- Intents volume did not beat price: the model with price had lower error than the model with Intents at ${L.count(EST, "/byHorizonCandidate", priceBetter.length)} of ${L.count(EST, "/byHorizonCandidate", horizons.length)} horizons (${horizons.map((h) => `horizon ${L.n(EST, E(`${h}:price`, "horizon"))}: ${L.n(EST, E(`${h}:price`, "mae_candidate"))} for price against ${L.n(EST, E(`${h}:intents`, "mae_candidate"))} for Intents`).join("; ")}).`,
    ),
    ...(lowOrigins.length
      ? [
          L.line(
            () =>
              `- Too few origins: ${lowOrigins.map((h) => `horizon ${L.n(EST, E(`${h}:intents`, "horizon"))} has ${L.n(EST, E(`${h}:intents`, "n_origins"))} scored origins`).join(" and ")}, against a preregistered minimum of ${L.n(PRE, "/thresholds/minDevOrigins")}.`,
          ),
        ]
      : []),
    L.line(() => `- The dataset is incomplete, so the run reports ${status}: \`${reasonLine()}\``),
    L.line(
      () =>
        `- Robustness variants point the same way: of ${L.count(ROB, "/rows", robOk.length)} variants that could be computed, ${L.count(ROB, "/rows", robNeg.length)} have negative delta MAE for the primary comparison (see the table below).`,
    ),
    L.line(
      () =>
        `- Statistical inference is limited: ${L.s(
          LIM,
          `/${Math.max(
            0,
            (L.get(LIM, "/") as string[]).findIndex((x) => /significance is not claimed/i.test(x)),
          )}`,
        )}`,
    ),
  ];
  sec(
    "Evidence against",
    [
      againstBullets.join("\n"),
      "Robustness variants of the primary comparison (development window; negative delta MAE means the candidate is worse):",
      "| Variant | Status | Origins | Delta MAE | Relative change | Reason | Source |\n|---|---|---|---|---|---|---|\n" +
        robTable.join("\n"),
    ].join("\n\n"),
  );

  // ---- 8 Confounders and blind spots -----------------------------------------------------------------------------------------
  const lim = L.get(LIM, "/") as string[];
  const limLines = lim.map((_, i) => L.line(() => `- ${L.s(LIM, `/${i}`)}`));
  const conf = [
    limLines.join("\n"),
    "- Price, Intents swaps and network usage can all respond to the same market conditions, so co-movement between them is not evidence that one leads another.",
    "- Accounts that belong to Intents infrastructure are excluded from the forecast target by a fixed rule; usage by automated accounts that are not on that list is still counted.",
    L.line(() => {
      const same =
        L.s(RUN, "/window/start") === L.s(MAN, "/window/from") &&
        L.s(RUN, "/window/end") === L.s(MAN, "/window/to");
      return `- The chart window (${L.s(MAN, "/window/from")} to ${L.s(MAN, "/window/to")}) and the research window (${L.s(RUN, "/window/start")} to ${L.s(RUN, "/window/end")}) ${same ? "are the same" : "differ"}; the daily series come from different systems (see the dataset table), so a day can be partial in one and complete in another.`;
    }),
    ...ds
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.caveats.length > 0 && d.id !== "intents_volume_daily")
      .flatMap(({ d, i }) =>
        d.caveats.map((_, ci) => L.line(() => `- ${d.id}: ${L.s(MAN, `/datasets/${i}/caveats/${ci}`)}`)),
      ),
  ].join("\n");
  sec("Confounders and blind spots", conf);

  // ---- 9 Long-term economic mechanisms (interpretation) -----------------------------------------------------------------------------
  sec(
    "Long-term economic mechanisms",
    [
      "Interpretation, not a result: nothing in this section is computed from the frozen files, and none of it is a claim of the thesis.",
      "- Cross-chain swaps could bring new accounts onto the network and create demand for contract calls, storage and fees; the data here do not show whether they do.",
      "- Swap volume could mostly reflect traders moving existing balances through solvers, which would add transactions without adding new usage.",
      "- Token price could reflect speculation and wider market mood more than product usage, which would weaken price as a gauge of usage in either direction.",
      "- Fee-sensitive or incentive-driven flows can fade when incentives change, so a rise in volume over a short window says little about how long it lasts.",
      "- Any mechanism would need its own preregistered test with account-level data before it could be stated as evidence.",
    ].join("\n"),
  );

  // ---- 10 Claims ---------------------------------------------------------------------------------------------------------------------
  const claims: Claim[] = [];
  const prereg = String(L.get(PRE, "/hash"));
  const dsHash = String(L.get(SNAP, "/datasetHash"));
  const prov =
    (key: string): (() => string) =>
    () =>
      `preregistration ${prereg}; dataset ${dsHash}; ${L.ref(EST, `/byHorizonCandidate/${key}`)}`;
  const falsification = (): string =>
    `Rejected if the lockbox relative improvement stays below ${L.n(PRE, "/thresholds/minRelativeImprovement", (x) => pct(x))}% or the placebo p-value exceeds ${L.n(PRE, "/thresholds/placebo/alpha")}.`;
  const addClaim = (c: {
    id: string;
    statement: () => string;
    kind: Claim["kind"];
    verdict: () => string;
    estimate: () => string | null;
    uncertainty: () => string | null;
    counterexample: () => string | null;
    falsification: () => string;
    provenance: () => string;
  }): void => {
    const parts = {
      statement: L.collect(c.statement),
      verdict: L.collect(c.verdict),
      estimate: L.collect(() => c.estimate() ?? ""),
      uncertainty: L.collect(() => c.uncertainty() ?? ""),
      counterexample: L.collect(() => c.counterexample() ?? ""),
      falsification: L.collect(c.falsification),
      provenance: L.collect(c.provenance),
    };
    const refs = [...new Set(Object.values(parts).flatMap((p) => p.refs))];
    claims.push({
      id: c.id,
      statement: parts.statement.text,
      kind: c.kind,
      verdict: parts.verdict.text,
      estimate: parts.estimate.text || null,
      uncertainty: parts.uncertainty.text || null,
      counterexample: parts.counterexample.text || null,
      falsification: parts.falsification.text,
      provenance: parts.provenance.text,
      refs,
    });
  };
  addClaim({
    id: "claim-hypothesis",
    statement: () => HYPOTHESIS,
    kind: "hypothesis",
    verdict: () => status,
    estimate: () =>
      `Primary comparison delta MAE ${L.n(EST, E(pKey, "delta_mae"))}, relative change ${L.n(EST, E(pKey, "relative_improvement"), pct)}%`,
    uncertainty: () =>
      `${L.n(EST, E(pKey, "delta_mae_ci/level"), (x) => pct(x))}% block-bootstrap interval ${L.n(EST, E(pKey, "delta_mae_ci/lo"))} to ${L.n(EST, E(pKey, "delta_mae_ci/hi"))} over ${L.n(EST, E(pKey, "n_origins"))} origins`,
    counterexample: () =>
      `The model with price had lower error than the model with Intents at ${L.count(EST, "/byHorizonCandidate", priceBetter.length)} of ${L.count(EST, "/byHorizonCandidate", horizons.length)} horizons`,
    falsification,
    provenance: prov(pKey),
  });
  keys.forEach((k, i) => {
    const ceIdx = cev.findIndex((e) => e.candidate === k.cand && e.horizon === k.h);
    const primary = k.key === pKey;
    addClaim({
      id: `claim-${k.cand}-h${k.h}`,
      statement: () =>
        `${CAND_LABEL[k.cand] ?? k.cand} versus baseline at horizon ${L.n(EST, E(k.key, "horizon"))}${primary ? " (primary)" : ""}`,
      kind: "derived statistic",
      verdict: () => status,
      estimate: () =>
        `delta MAE ${L.n(EST, E(k.key, "delta_mae"))}, relative ${L.n(EST, E(k.key, "relative_improvement"), pct)}%; baseline ${L.n(EST, E(k.key, "mae_baseline"))}, candidate ${L.n(EST, E(k.key, "mae_candidate"))}`,
      uncertainty: () =>
        `${L.n(EST, E(k.key, "delta_mae_ci/level"), (x) => pct(x))}% block-bootstrap interval ${L.n(EST, E(k.key, "delta_mae_ci/lo"))} to ${L.n(EST, E(k.key, "delta_mae_ci/hi"))}; ${L.n(EST, E(k.key, "n_origins"))} origins`,
      counterexample: () =>
        ceIdx >= 0
          ? `${L.s(CEV, `/${ceIdx}/kind`)
              .replace(/_/g, " ")
              .replace(
                /\bfdr\b/g,
                "FDR",
              )}: adjusted p-value ${L.n(CEV, `/${ceIdx}/p_adjusted`)}${(est[k.key]!.n_origins as number) < minOrig ? `; only ${L.n(EST, E(k.key, "n_origins"))} origins against the minimum of ${L.n(PRE, "/thresholds/minDevOrigins")}` : ""}`
          : `the lower interval bound ${L.n(EST, E(k.key, "delta_mae_ci/lo"))} is the smallest effect compatible with the data`,
      falsification,
      provenance: prov(k.key),
    });
    void i;
  });
  charts
    .filter((c) => c.kind === "line" && c.sentenceRefs.length && c.id !== "price-vs-usage")
    .forEach((c) =>
      addClaim({
        id: `claim-observed-${c.id}`,
        statement: () => `Observed: ${c.title}`,
        kind: "observed fact",
        verdict: () => "OBSERVED",
        estimate: () => c.sentence,
        uncertainty: () =>
          "Exact counts or sums from the frozen file; no sampling error, but days listed as missing are not filled.",
        counterexample: () => c.evidenceAgainst ?? "None found in this series.",
        falsification: () =>
          "Wrong if the raw file is altered or re-frozen differently; pnpm thesis:verify then fails.",
        provenance: () => `raw file ${c.datasetIds.join(", ")} sha256 ${c.sha256}`,
      }),
    );
  addClaim({
    id: "claim-mechanisms",
    statement: () =>
      "Qualitative mechanisms linking Intents activity to network usage (section Long-term economic mechanisms)",
    kind: "interpretation",
    verdict: () => "NOT TESTED",
    estimate: () => "None; an interpretation carries no number.",
    uncertainty: () => "Not quantified.",
    counterexample: () =>
      "The forecast comparison found no gain from Intents volume, which does not fit a strong mechanism.",
    falsification: () =>
      "Not testable with these data; a mechanism needs its own preregistered test with account-level data.",
    provenance: () => "interpretation; no data file",
  });
  // Observed-fact rows reuse chart refs (already in the ledger); attach them so the table line cites them.
  const chartRefs = new Map(
    charts.map((c) => [`claim-observed-${c.id}`, [...c.sentenceRefs, ...c.evidenceAgainstRefs]]),
  );
  for (const c of claims) {
    const extra = chartRefs.get(c.id);
    if (extra) c.refs = [...new Set([...c.refs, ...extra])];
  }
  const claimTable = [
    `| Claim | ${CLAIM_FIELDS.join(" | ")} |`,
    `|${"---|".repeat(CLAIM_FIELDS.length + 1)}`,
    ...claims.map((c) => {
      const cells = [
        c.statement,
        c.verdict,
        c.estimate ?? "none",
        c.uncertainty ?? "none",
        c.counterexample ?? "none",
        c.falsification,
        c.provenance,
      ].map((x) => cell(x));
      return `| ${cells.join(" | ")} ${c.refs.map((r) => `[${r}]`).join("")} |`;
    }),
  ].join("\n");
  sec("Verdict per claim", claimTable);

  // ---- 11 Reproduction -------------------------------------------------------------------------------------------------------------------
  sec(
    "Reproduction",
    [
      "From the repository root `nearesis-app`:",
      "- `pnpm thesis:build` rebuilds THESIS.md, the static dashboard, thesis.json and HASHES.json offline from thesis/raw and the frozen research results.",
      "- `pnpm thesis:verify` rebuilds into a temporary directory and compares every hash with thesis/build/HASHES.json; it exits with an error if any file differs.",
      "- `pnpm thesis:data` re-freezes thesis/raw from the local stores (the only step that needs the databases).",
      L.line(
        () =>
          `The research results come from the run recorded by: \`${L.s(REP, "/command")}\` with seed ${L.n(REP, "/seed", (x) => String(x))}.`,
      ),
      "Input hashes are listed in the Source index; output hashes are in thesis/build/HASHES.json.",
    ].join("\n"),
  );

  // ---- 12 Unable to compute ------------------------------------------------------------------------------------------------------------
  const unable: Unable[] = [];
  const addU = (what: string | (() => string), why: () => string): void => {
    const w = L.collect(() => (typeof what === "function" ? what() : what));
    const r = L.collect(why);
    unable.push({ what: w.text, why: r.text, refs: [...new Set([...w.refs, ...r.refs])] });
  };
  addU(
    "Any lag, window or model outside the preregistered family",
    () => "The frozen run tested the preregistered family only; nothing else was searched.",
  );
  addU(
    "Causal effect of Intents activity on usage",
    () => "Excluded by design: the test is predictive only.",
  );
  if (L.get(FAL, "/placebo") === null)
    addU(
      "Placebo test",
      () =>
        "Not computed in this run (placebo is null in the falsification file); " +
        L.n(PRE, "/thresholds/placebo/n") +
        " placebo draws are preregistered.",
    );
  if (L.get(FAL, "/robustness") === null)
    addU(
      "Robustness agreement share",
      () => "Not computed in this run (the falsification file holds no robustness result).",
    );
  if (L.get(FAL, "/lagComparison") === null)
    addU(
      "Lag comparison",
      () => "Not computed in this run (lag comparison is null in the falsification file).",
    );
  if (L.get(EST, "/holdout") === null)
    addU(
      "Lockbox holdout evaluation",
      () =>
        `The lockbox of ${L.n(RUN, "/lockbox/n")} days was not opened in this run, so no out-of-sample confirmation exists.`,
    );
  lowOrigins.forEach((h) =>
    addU(
      () => `Minimum origins at horizon ${L.n(EST, E(`${h}:intents`, "horizon"))}`,
      () =>
        `Only ${L.n(EST, E(`${h}:intents`, "n_origins"))} scored origins against the preregistered minimum of ${L.n(PRE, "/thresholds/minDevOrigins")}; the horizon is reported but cannot reach the threshold.`,
    ),
  );
  addU("Complete-dataset check", () => reasonLine());
  robKeys
    .filter((k) => robRows[k]!.status !== "OK")
    .forEach((k) => addU(`Robustness variant: ${k}`, () => L.s(ROB, `/rows/${k}/reason`)));
  const unobserved = lim.findIndex((s) => /unobserved/i.test(s));
  if (unobserved >= 0)
    addU("Private Intents execution after the privacy regime date", () => L.s(LIM, `/${unobserved}`));
  ds.forEach((d, i) => {
    if (!d.file || d.rows === 0)
      addU(
        `Dataset ${d.id}`,
        () => `Not available in the frozen raw data. ${L.s(MAN, `/datasets/${i}/caveats/0`)}`,
      );
    if (d.sqlBigQuery && !d.bigQueryExecuted)
      addU(
        `BigQuery query for ${d.id}`,
        () =>
          `The SQL ships in thesis/sql/bigquery but was not executed in this build (manifest: ${String(L.get(MAN, `/datasets/${i}/bigQueryExecuted`))}).`,
      );
    if (d.coverage.missingDays.length)
      addU(
        `Days missing in ${d.id}`,
        () =>
          `${d.coverage.missingDays.length > 8 ? `${L.count(MAN, `/datasets/${i}/coverage/missingDays`, d.coverage.missingDays.length)} days, first ${d.coverage.missingDays[0]} and last ${d.coverage.missingDays[d.coverage.missingDays.length - 1]}` : d.coverage.missingDays.join(", ")}; these days are absent, never filled with zero.`,
      );
  });
  sec(
    "Unable to compute",
    unable.map((u) => `- **${u.what}**: ${u.why}${u.refs.map((r) => ` [${r}]`).join("")}`).join("\n"),
  );

  // ---- 13 Source index -------------------------------------------------------------------------------------------------------------------
  sec(
    "Source index",
    [
      "Citations in square brackets are `file#pointer`. The prefix `raw/` is thesis/raw, `results/` is the frozen research run docs/research/live-results/live-20260505-20261111-live-organic-v3-3ac682146b75, and the other paths are under thesis/.",
      "| Cited as | Location | sha256 |\n|---|---|---|\n" +
        inp.files.map((f) => `| ${f.cite} | ${f.where} | ${f.sha256} |`).join("\n"),
    ].join("\n\n"),
  );

  // ---- 14 Changes ----------------------------------------------------------------------------------------------------------------------------
  sec(
    "Changes since previous version",
    `First generated version of this bundle, id ${version}. The version id is derived from the input hashes above, so any change in the frozen data or results changes it.`,
  );

  // ---- assemble ----------------------------------------------------------------------------------------------------------------------------------
  const ids = SECTION_TITLES.map((t) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
  );
  const outSections: SectionOut[] = SECTION_TITLES.map((title, i) => ({
    id: ids[i]!,
    title,
    markdown: sections.get(title)!,
  }));
  const markdown =
    `# THESIS: is cross-chain volume through NEAR Intents a better leading indicator of network usage than token price?\n\n` +
    `Version ${version}; generated from frozen data only (frozen at ${String(L.get(MAN, "/frozenAt"))}).\n\n` +
    outSections.map((s) => `## ${s.title}\n\n${s.markdown}`).join("\n\n") +
    "\n";

  // ---- verdict block ------------------------------------------------------------------------------------------------------------------------------
  const sum = L.collect(() => {
    const rows = horizons.map((h) => `${L.n(EST, E(`${h}:price`, "horizon"))}`);
    return `At every tested horizon (${rows.join(", ")} days) no model with Intents volume or price beat the baseline, and the model with price had lower error than the model with Intents at ${L.count(EST, "/byHorizonCandidate", priceBetter.length)} of ${L.count(EST, "/byHorizonCandidate", horizons.length)} horizons.`;
  });
  const rowsOut: ThesisText["rows"] = [];
  for (const h of horizons) {
    const lab = (s: string) => `${s}, horizon ${h} days`;
    const push = (label: string, key: string, field: string, unit: string | null) =>
      rowsOut.push({ label, value: String(L.get(EST, E(key, field))), unit, ref: `${EST}#${E(key, field)}` });
    push(lab("Baseline MAE"), `${h}:intents`, "mae_baseline", "MAE, log scale");
    push(lab("MAE with Intents volume"), `${h}:intents`, "mae_candidate", "MAE, log scale");
    push(lab("MAE with price"), `${h}:price`, "mae_candidate", "MAE, log scale");
    push(lab("MAE with both"), `${h}:combined`, "mae_candidate", "MAE, log scale");
    push(lab("Adjusted p-value, Intents versus baseline"), `${h}:intents`, "p_adjusted", null);
    push(lab("Origins scored"), `${h}:intents`, "n_origins", "origins");
  }
  const headline = headlineParts.text;
  return {
    markdown,
    sections: outSections,
    claims,
    unableToCompute: unable,
    status,
    verdictStatus,
    headline,
    summary: sum.text,
    rows: rowsOut,
    whatWouldChangeOurMind: changeItems.map((c) => `${c.text}${c.refs.map((r) => ` [${r}]`).join("")}`),
    summaryRefs: sum.refs,
    headlineRefs: headlineParts.refs,
    changeRefs: changeItems.map((c) => c.refs),
  };
}
void sig;
