/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The reference forecast thesis (kind "forecast" in thesis/raw/manifest.json). Offline and deterministic: reads thesis/raw (and
 * thesis/raw/fees when it exists), runs the forecast engine, writes raw/forecast.json, THESIS.md, FACTS.md, the static site,
 * thesis.json and HASHES.json. Every number passes through the grounding Ledger and is re-checked by the scanner.
 */
import { sha256Hex, canonicalJson } from "../../packages/plugin-sdk/src/canonical.ts";
import type { Chart } from "./charts.ts";
import { datasetBits } from "./charts.ts";
import { addDays, buildForecast, fwd, inv, round, trailingAverage } from "./forecast.ts";
import { loadForecastInputs, columnMap } from "./forecast-inputs.ts";
import type { ForecastInputs } from "./forecast-inputs.ts";
import { computeFacts } from "./facts.ts";
import { commas, fmt, Ledger, scanGrounding, scanSentence } from "./ground.ts";
import type { GroundViolation, Json } from "./ground.ts";
import { THESIS_HYPOTHESIS, THESIS_QUESTION, THESIS_TITLE } from "./hypothesis.ts";
import { SECTION_TITLES } from "./markdown.ts";
import type { Claim, Unable } from "./markdown.ts";
import { renderForecastSite } from "./render-forecast-site.ts";
import { causalHits, validateThesisMarkdown } from "./validate.ts";
import type { Inputs } from "./inputs.ts";

export type FChart = Chart & {
  forecastFrom?: string;
  bands?: boolean;
  refLine?: { value: string; label: string };
  format?: "share" | "number";
};
export interface ForecastBuildOutput {
  files: Map<string, string>;
  /** Files written relative to the THESIS directory (raw/forecast.json). */
  extra: Map<string, string>;
  version: string;
  thesis: Record<string, any>;
  numbersChecked: number;
}
export class ForecastBuildError extends Error {
  constructor(
    message: string,
    readonly detail: unknown = null,
  ) {
    super(message);
  }
}

const F = "raw/forecast.json";
const M = "raw/manifest.json";
const sha = (s: string): string => sha256Hex(s);
const MODEL_NAME: Record<string, string> = {
  naive: "the naive model (last value)",
  drift: "the random-walk-with-drift model",
  trend: "the linear-trend model",
  damped: "the damped-trend model",
  median: "the median of the drift, trend and damped models",
};
/** The direction in which a realised value counts against the thesis at a checkpoint. */
const AGAINST: Record<string, "below" | "above"> = {
  intents_tx: "below",
  tail_signers: "above",
  tail_tx: "above",
  intents_usd: "below",
  take_rate_gas: "above",
  intents_burn_share: "above",
  spread_bps_stable: "above",
  stable_share: "below",
  no_near_share: "below",
  near_token_share: "above",
  usd_per_tail_signer: "below",
};
const TOLL = ["take_rate_gas", "intents_burn_share", "spread_bps_stable"];
const SUPPORT = [
  "intents_tx",
  "tail_tx",
  "tail_signers",
  "intents_usd",
  "usd_per_tail_signer",
  "stable_share",
  "no_near_share",
  "near_token_share",
];

// ------------------------------------------------------------------------------------------------ interpretation.md
export function parseInterpretation(md: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!md) return out;
  const clean = md.replace(/<!--[\s\S]*?-->/g, "");
  const parts = clean.split(/^## (.+)$/m);
  for (let i = 1; i < parts.length - 1; i += 2) {
    const body = parts[i + 1]!.trim();
    if (body) out.set(parts[i]!.trim(), body);
  }
  return out;
}
const BANNED = ["bullish", "will rally", "moon", "guaranteed"];
/** Wording rules for authored prose: causal wording and hype are rejected; forward-looking words (will, forecast, expect) are allowed. */
export function validateInterpretationText(text: string): { rule: string; detail: string }[] {
  const out: { rule: string; detail: string }[] = [];
  for (const h of causalHits(text)) out.push({ rule: "causal_language", detail: `${h.term}: ${h.sentence}` });
  const low = text.toLowerCase();
  for (const b of BANNED)
    if (new RegExp(`\\b${b}\\b`).test(low)) out.push({ rule: "hype_language", detail: b });
  if (/(?<!not )(?<!no )statistically significant|\bsignificantly (better|improv\w+|different)/i.test(text))
    out.push({ rule: "significance_claim", detail: "statistical-significance wording" });
  return out;
}
/** Registers the values behind the pointers of an authored block so the grounding scan can check its numbers. */
function registerAuthored(L: Ledger, block: string): void {
  for (const m of block.matchAll(/\[([^[\]\s|]+)#([^[\]\s|]+)\]/g)) {
    const file = m[1]!;
    const pointer = m[2]!;
    const raw = L.get(file, pointer);
    const id = `${file}#${pointer}`;
    const texts = new Set<string>();
    if (
      typeof raw === "number" ||
      (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw)))
    ) {
      const x = Number(raw);
      for (const v of [x, x * 100, x / 1e3, x / 1e6, x / 1e9]) {
        if (!Number.isFinite(v)) continue;
        texts.add(fmt(v));
        texts.add(String(Math.round(v)));
        texts.add(v.toFixed(1));
        texts.add(v.toFixed(2));
        texts.add(commas(String(Math.round(v))));
        texts.add(String(Number(v.toPrecision(2))));
        texts.add(String(Number(v.toPrecision(3))));
      }
      texts.add(String(raw));
    } else texts.add(typeof raw === "string" ? raw : JSON.stringify(raw));
    // touch through the public API so the entry exists
    for (const t of texts) L.derivedText(file, pointer, t);
    void id;
  }
}

// ------------------------------------------------------------------------------------------------ main
export function buildForecastBundle(thesisDir: string): ForecastBuildOutput {
  const inp = loadForecastInputs(thesisDir);
  const { manifest } = inp;
  const feesOn = inp.fees.present;
  const has = (id: string): boolean => inp.meta.has(id);

  // ---- forecast ------------------------------------------------------------------------------------------------------------
  const totals = ["intents_usd", ...(has("intents_burn_near") ? ["intents_burn_near"] : [])];
  const engine = buildForecast({
    series: inp.series,
    crossover: { a: "intents_tx", b: "tail_tx" },
    total: totals,
    threshold: { id: "stable_share", value: 0.5 },
  }) as Record<string, any>;
  const fc: Record<string, any> = { ...engine, facts: computeFacts(inp) };
  for (const [id, s] of Object.entries<any>(fc.series)) {
    const dir = AGAINST[id] ?? null;
    s.againstDirection = dir;
    s.group = inp.meta.get(id)?.group ?? "core";
    s.checkpoints.forEach((c: any) => {
      c.against = dir ? { direction: dir, bound: dir === "below" ? c.band80[0] : c.band80[1] } : null;
    });
  }
  // fee-derived quantities (D4: NEAR burnt attributable to Intents; D5: the toll split)
  const price = columnMap(inp.raw.get("near_price_daily")!, "value");
  const lastClose = price.get(inp.days[inp.days.length - 1]!) as number;
  fc.derived.lastClose = {
    day: inp.days[inp.days.length - 1],
    usdPerNear: lastClose,
    note: "NEAR price is held fixed at the last close; it is not a price forecast.",
  };
  if (fc.derived.intents_burn_near_12m) {
    const b = fc.derived.intents_burn_near_12m;
    fc.derived.intents_burn_near_12m = {
      ...b,
      usdAtLastClose: {
        central: round(b.centralTotal * lastClose, 2),
        p10: round(b.p10 * lastClose, 2),
        p90: round(b.p90 * lastClose, 2),
        priceHeldFixed: true,
      },
    };
  }
  for (const id of totals) {
    const sr = fc.series[id];
    const d = fc.derived[`${id}_12m`];
    if (sr && d)
      d.bandSum80 = {
        lo: round(
          sr.path.band80Lo.reduce((a: number, b: number) => a + b, 0),
          2,
        ),
        hi: round(
          sr.path.band80Hi.reduce((a: number, b: number) => a + b, 0),
          2,
        ),
        note: "Sum of the eighty percent band path of the thirty-day average over the next 365 days: treats the whole year as one perfectly correlated band, so it is narrower than the simulated range.",
      };
  }
  const split: any[] = [];
  for (const [key, id, label] of [
    ["burn", "take_rate_gas", "NEAR burnt as gas by the Intents contracts"],
    ["spread", "spread_bps_stable", "user-paid spread, stablecoin to stablecoin"],
  ] as const) {
    const s = fc.series[id];
    if (!s) continue;
    split.push({
      key,
      series: id,
      label,
      centsPer100Usd: { last30: s.last30, plus90: s.horizons[0], plus365: s.horizons[2] },
    });
  }
  fc.derived.toll_split = {
    unit: "cents per 100 USD settled (one basis point is one cent per 100 USD)",
    rows: split,
    last30Total: split.length
      ? round(
          split.reduce((a, r) => a + (r.centsPer100Usd.last30 ?? 0), 0),
          4,
        )
      : null,
  };
  const forecastText = `${JSON.stringify(fc, null, 1)}\n`;
  const docs = new Map(inp.docs);
  docs.set(F, JSON.parse(forecastText) as Json);
  const fcDoc = docs.get(F) as Record<string, any>;

  const version = `v-${sha(canonicalJson([...inp.files.map((f) => [f.cite, f.sha256]), ["engine", sha(forecastText)]])).slice(0, 12)}`;
  const L = new Ledger(docs);

  // ---- value formatting ------------------------------------------------------------------------------------------------------
  const kind = (id: string): "share" | "usd" | "bps" | "count" => {
    const u = inp.meta.get(id)!;
    return u.transform === "logit"
      ? "share"
      : u.unit === "USD" || u.unit === "USD per signer"
        ? "usd"
        : u.unit.startsWith("basis")
          ? "bps"
          : "count";
  };
  const showFor =
    (id: string) =>
    (x: number): string => {
      const k = kind(id);
      if (k === "share") return `${fmt(x * 100)}%`;
      if (k === "usd") return `${fmt(x)} USD`;
      if (k === "bps") return `${fmt(x)} bps`;
      return fmt(x);
    };
  const sp = (id: string): string => `/series/${id}`;
  const v = (id: string, suffix: string): string => L.n(F, `${sp(id)}${suffix}`, showFor(id));
  const band = (id: string, base: string, which: "band80" | "band50" = "band80"): string =>
    `${v(id, `${base}/${which}/0`)} to ${v(id, `${base}/${which}/1`)}`;
  const label = (id: string): string => inp.meta.get(id)!.label;
  const present = (ids: string[]): string[] => ids.filter((i) => fcDoc.series[i]);
  const pctS = (p: string): string => L.n(F, p, (x) => `${fmt(x * 100)}%`);
  const horizonLine = (id: string, i: number): string => {
    const h = L.n(F, `${sp(id)}/horizons/${i}/horizon`);
    const beyond = fcDoc.series[id].horizons[i].beyondBacktest;
    return `in ${h} days (${fcDoc.series[id].horizons[i].date}) ${v(id, `/horizons/${i}/central`)} (eighty percent band ${band(id, `/horizons/${i}`)})${beyond ? ", beyond the horizons the backtest can score" : ""}`;
  };
  const modelLine = (id: string): string => {
    const s = fcDoc.series[id];
    const skill = s.skill90;
    const maxH = L.n(F, "/method/config/horizons/2");
    return skill === null
      ? `the model used is ${MODEL_NAME[s.chosenModel]}, whose skill against naive at ${maxH} days could not be computed`
      : `the model used is ${MODEL_NAME[s.chosenModel]}, with an error ${s.chosenModel === "naive" ? "equal to the naive baseline" : `${pctS(`${sp(id)}/skill90`)} ${skill >= 0 ? "lower than" : "higher than"} the naive baseline`} at ${maxH} days`;
  };
  const calVal = (id: string): number | null =>
    fcDoc.series[id].calibration.pooledForward80 ?? fcDoc.series[id].calibration.pooledLeaveOneOut80;
  const calPtr = (id: string): string =>
    `${sp(id)}/calibration/${fcDoc.series[id].calibration.pooledForward80 !== null ? "pooledForward80" : "pooledLeaveOneOut80"}`;
  const calHow = (id: string): string =>
    fcDoc.series[id].calibration.pooledForward80 !== null
      ? "in a time-ordered check that uses only earlier origins"
      : "when each origin is left out";
  const verdictOf = (id: string): string => L.s(F, `${sp(id)}/verdict`);
  const sections = new Map<string, string>();
  const sec = (title: (typeof SECTION_TITLES)[number], body: string): void =>
    void sections.set(title, body.trim());
  const refs = (r: string[]): string => r.map((x) => ` [${x}]`).join("");
  const trow = (fn: () => string[]): string => {
    const r = L.collect(() => fn().join(" | "));
    return `| ${r.text}${refs(r.refs)} |`;
  };
  const claimsOut: Claim[] = [];
  const unable: Unable[] = [];
  const addU = (what: string, why: () => string): void => {
    const r = L.collect(why);
    unable.push({ what, why: r.text, refs: r.refs });
  };

  // ---- core numbers used in several places ------------------------------------------------------------------------------------
  const T = fcDoc.lastDay as string;
  const feesNote = (): string =>
    feesOn
      ? `The fee inputs were read from thesis/raw/fees (${inp.fees.missing.length ? `series not found there: ${inp.fees.missing.map((m) => m.id).join(", ")}` : "every fee series was found"}).`
      : "The fee inputs (thesis/raw/fees/manifest.json) do not exist yet, so every toll-booth series, claim and chart below is not computed; a rebuild picks them up without a code change.";

  // ---- headline ------------------------------------------------------------------------------------------------------------------
  const headParts = L.collect(() => {
    const parts: string[] = [];
    if (fcDoc.series.take_rate_gas)
      parts.push(
        `the gas take rate is ${v("take_rate_gas", "/last30")} of settled value today and is forecast at ${v("take_rate_gas", "/horizons/2/central")} in ${L.n(F, `${sp("take_rate_gas")}/horizons/2/horizon`)} days (eighty percent band ${band("take_rate_gas", "/horizons/2")}, beyond the horizons the backtest can score)`,
      );
    parts.push(
      `settled volume is ${v("intents_usd", "/last30")} a day and is forecast at ${v("intents_usd", "/horizons/2/central")} in ${L.n(F, `${sp("intents_usd")}/horizons/2/horizon`)} days (band ${band("intents_usd", "/horizons/2")})`,
    );
    parts.push(
      `${v("no_near_share", "/last30")} of the volume touches no NEAR-chain asset today (forecast ${v("no_near_share", "/horizons/2/central")})`,
    );
    return `FORECAST: ${parts.join("; ")}.`;
  });
  const headline = headParts.text;
  const co = fcDoc.derived.crossover as Record<string, any>;
  const crossText = (): string => {
    if (co.aboveAtLastDay)
      return `On ${T} the thirty-day average of Intents transactions (${L.n(F, "/derived/crossover/last30A")}) is already above that of long-tail organic transactions (${L.n(F, "/derived/crossover/last30B")}); the simulated probability that it is still above in ${L.n(F, "/method/config/reportHorizons/2")} days is ${pctS("/derived/crossover/aboveAt12Months")}.`;
    return `The thirty-day average of Intents transactions (${L.n(F, "/derived/crossover/last30A")}) is below that of long-tail organic transactions (${L.n(F, "/derived/crossover/last30B")}) on ${T}; the central forecast crosses ${co.centralDate === null ? "never within the next year" : `on ${L.s(F, "/derived/crossover/centralDate")}`}, and the simulated probability of a crossing within six months is ${pctS("/derived/crossover/within6Months")} and within twelve months ${pctS("/derived/crossover/within12Months")}.`;
  };

  // ============================================================ 1 Executive claim
  const exec = [
    `Verdict **FORECAST**: this thesis does not test a past relationship; it forecasts dated numbers and states, before the data arrives, the observations that would show the forecast wrong.`,
    `Thesis: ${THESIS_HYPOTHESIS}`,
    `Central question: ${THESIS_QUESTION}`,
    `${headParts.text}${refs(headParts.refs)}`,
    L.line(crossText),
    L.line(
      () =>
        `Evidence against comes first in weight, not in order: a year of data cannot score a twelve-month horizon (the longest scored horizon is ${L.n(F, "/method/config/horizons/2")} days, so the forecasts at ${L.n(F, "/method/config/reportHorizons/1")} and ${L.n(F, "/method/config/reportHorizons/2")} days are extrapolations), and ${present([...TOLL, ...SUPPORT]).filter((i) => verdictOf(i) === "FORECAST_LOW_SKILL").length === 0 ? "every" : L.count(F, "/series", present([...TOLL, ...SUPPORT]).filter((i) => verdictOf(i) === "FORECAST_LOW_SKILL").length)} of ${L.count(F, "/series", present([...TOLL, ...SUPPORT]).length)} forecast series ${present([...TOLL, ...SUPPORT]).filter((i) => verdictOf(i) === "FORECAST_LOW_SKILL").length === 0 ? "have" : "are labelled FORECAST_LOW_SKILL, meaning they do not"} beat the naive model by at least ten percent at ${L.n(F, "/method/config/horizons/2")} days with a calibrated band.`,
    ),
    feesNote(),
    "This is a forecast, not a causal claim, and no statistical-significance claim is made. Every sentence is produced by a deterministic template from the frozen files, or is an authored analysis block whose numbers each carry a pointer.",
  ].join("\n\n");
  sec("Executive claim", exec);

  // ============================================================ 2 What would change our mind
  const changeLines: { text: string; refs: string[] }[] = [];
  for (const id of present([...TOLL, "intents_tx", "tail_signers", "intents_usd", "stable_share"])) {
    const rr = L.collect(() => {
      const s = fcDoc.series[id];
      const dir = s.againstDirection as string;
      const cps = s.checkpoints
        .map(
          (c: any, i: number) =>
            `${c.date} (${L.n(F, `${sp(id)}/checkpoints/${i}/against/bound`, showFor(id))})`,
        )
        .join(", ");
      return `${label(id)}: wrong if the realised thirty-day average is ${dir} the eighty percent band at two consecutive checkpoints; the bounds are ${cps}.`;
    });
    changeLines.push(rr);
  }
  changeLines.push(
    L.collect(
      () =>
        `Crossover: wrong if there is no crossover of Intents transactions above long-tail organic transactions by ${L.s(F, "/derived/crossover/twelveMonthsDate")} while the forecast probability within twelve months is above one half (it is ${pctS("/derived/crossover/within12Months")}).`,
    ),
  );
  changeLines.push(
    L.collect(
      () =>
        `Stable-to-stable share: wrong if the thirty-day average is still below one half on ${L.s(F, "/derived/crossover/twelveMonthsDate")} while the simulated probability of crossing within twelve months is above one half (it is ${pctS("/derived/stable_share_threshold/within12Months")}).`,
    ),
  );
  changeLines.push({
    text: "A fee source this thesis cannot see: a protocol or app fee that reaches NEAR-aligned parties would change the take rate; the thesis measures gas burnt and the user-paid spread only.",
    refs: [],
  });
  sec("What would change our mind", changeLines.map((c) => `- ${c.text}${refs(c.refs)}`).join("\n"));

  // ============================================================ 3 Sample and sources
  const dsRows = manifest.datasets.map((d, i) =>
    trow(() => [
      `${L.s(M, `/datasets/${i}/title`)} (${d.id})`,
      L.n(M, `/datasets/${i}/rows`, (x) => commas(String(x))),
      L.s(M, `/datasets/${i}/source`).replace(/\|/g, "/"),
      d.sqlBigQuery
        ? d.bigQueryExecuted
          ? `BigQuery cross-check executed, ${L.n(M, `/datasets/${i}/bigQueryBytesBilled`, (x) => commas(String(x)))} bytes billed`
          : "BigQuery SQL shipped, not executed"
        : "no BigQuery source",
    ]),
  );
  const cc = manifest.crossChecks.map((c, i) =>
    trow(() => [
      `${c.local} against ${c.bigquery}`,
      L.n(M, `/crossChecks/${i}/daysCompared`),
      L.n(M, `/crossChecks/${i}/daysEqual`),
      L.n(M, `/crossChecks/${i}/maxAbsDiff`),
    ]),
  );
  const bqRows = manifest.bigQueryQueries.map((q, i) =>
    trow(() => [
      q.id,
      q.executed ? "executed" : "not executed",
      q.bytesBilled !== null ? L.n(M, `/bigQueryQueries/${i}/dryRunBytes`, (x) => commas(String(x))) : "none",
      q.bytesBilled !== null ? L.n(M, `/bigQueryQueries/${i}/bytesBilled`, (x) => commas(String(x))) : "none",
      q.rows !== null ? L.n(M, `/bigQueryQueries/${i}/rows`) : "none",
    ]),
  );
  const missingLines = manifest.datasets
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.coverage.missingDays.length)
    .map(({ d, i }) =>
      L.line(
        () =>
          `- ${d.id}: ${L.count(M, `/datasets/${i}/coverage/missingDays`, d.coverage.missingDays.length)} days absent (${d.coverage.missingDays.length > 6 ? `first ${d.coverage.missingDays[0]}, last ${d.coverage.missingDays[d.coverage.missingDays.length - 1]}` : d.coverage.missingDays.join(", ")}); they are listed in the manifest and are never filled with zero.`,
      ),
    );
  const sample = [
    L.line(
      () =>
        `Daily series run from ${L.s(M, "/window/from")} to ${L.s(M, "/window/to")}, the earliest and the last full day held in every account table (${L.count(F, "/series/intents_tx/observedDays", fcDoc.series.intents_tx.observedDays)} observed days for the Intents transaction series). Swap data runs through the next day only partially and is not used. The data was frozen at ${L.s(M, "/frozenAt")}; the method was frozen at ${L.s(M, "/methodFrozenAt")}.`,
    ),
    "| Dataset | Rows | Source | BigQuery |\n|---|---|---|---|\n" + dsRows.join("\n"),
    "Days with no usable value, listed and not filled:",
    missingLines.join("\n"),
    "BigQuery queries (all on the transactions table with a block_date filter, dry run first):",
    "| Query | Status | Dry run bytes | Bytes billed | Rows |\n|---|---|---|---|---|\n" + bqRows.join("\n"),
    "Cross-check of the local series against BigQuery, day by day, exact integers:",
    cc.length
      ? "| Series pair | Days compared | Days equal | Largest absolute difference |\n|---|---|---|---|\n" +
        cc.join("\n")
      : "No BigQuery result is present, so no cross-check was made.",
    L.line(
      () =>
        `Internal consistency: on ${L.n(M, "/internalChecks/organicEqualsHeadPlusTail/daysEqual")} of ${L.n(M, "/internalChecks/organicEqualsHeadPlusTail/days")} days organic transactions equal head plus tail transactions exactly.`,
    ),
    feesNote(),
  ].join("\n\n");
  sec("Sample and sources", sample);

  // ============================================================ 4 Methods
  const defLines = [
    "tail_daily",
    "intents_tx_daily",
    "intents_volume_daily",
    "intents_mix_daily",
    "new_signers_daily",
    "head_accounts_break",
  ].map((id) => {
    const i = manifest.datasets.findIndex((d) => d.id === id);
    return L.line(() => `- ${L.s(M, `/datasets/${i}/title`)}: ${L.s(M, `/datasets/${i}/definition`)}`);
  });
  const methods = [
    L.line(
      () =>
        `Each series is a daily series. The model works on the seven-day mean of the observed days (a day with no value is skipped, never counted as zero), on a transformed scale: ln(one plus x) for counts and amounts, the logit for shares, ln(x) for ratios such as the take rate.`,
    ),
    L.line(
      () =>
        `Five candidate models: the last value (naive); a random walk with drift estimated on the trailing ${L.n(F, "/method/config/trailing")} days; a linear trend on the trailing ${L.n(F, "/method/config/trailing")} days; a damped trend (Holt, damping ${L.n(F, "/method/config/phi")}, smoothing parameters fitted by one-step squared error on a fixed grid); and the median of the last three.`,
    ),
    L.line(
      () =>
        `Rolling-origin backtest: origins every ${L.n(F, "/method/config/originStep")} days from day ${L.n(F, "/method/config/firstOrigin")} of the series; horizons ${L.n(F, "/method/config/horizons/0")}, ${L.n(F, "/method/config/horizons/1")} and ${L.n(F, "/method/config/horizons/2")} days; the target is the thirty-day average ending at the horizon, scored by the absolute error of its transformed value. Skill is one minus the model error divided by the naive error. The model with the lowest error at ${L.n(F, "/method/config/horizons/2")} days is used for each series, the simpler model on a tie.`,
    ),
    L.line(
      () =>
        `Bands: the fifty and eighty percent half-widths are the empirical quantiles of the chosen model's absolute backtest errors at each scored horizon; beyond ${L.n(F, "/method/config/horizons/2")} days they widen with the square root of the horizon ratio, which is an assumption because the data cannot score longer horizons. Calibration reports how often the eighty percent band held the realised value in a time-ordered check that sets the width from earlier origins only (the verdict uses it when it has at least six test points, otherwise leaving each origin out in turn).`,
    ),
    L.line(
      () =>
        `Simulation: ${L.n(F, "/method/config/paths")} paths from a block bootstrap (block length ${L.n(F, "/method/config/block")} days) of the chosen model's one-step residuals, with seeds derived from the input hash ${L.s(F, "/inputHash").slice(0, 12)}. The crossover and the twelve-month totals are read from these paths.`,
    ),
    L.line(
      () =>
        `Verdict per series: FORECAST_WITH_SKILL when the model beats naive by at least ${L.n(F, "/method/config/skillThreshold", (x) => `${fmt(x * 100)}%`)} at ${L.n(F, "/method/config/horizons/2")} days and the eighty percent band is calibrated between ${L.n(F, "/method/config/calibrationRange/0", (x) => `${fmt(x * 100)}%`)} and ${L.n(F, "/method/config/calibrationRange/1", (x) => `${fmt(x * 100)}%`)}; otherwise FORECAST_LOW_SKILL. A model that cannot beat naive is reported as such and naive is used with its wider bands.`,
    ),
    "Series definitions, quoted from the manifest:",
    defLines.join("\n"),
    L.line(
      () =>
        `Overlap of the Intents and long-tail series: ${L.s(
          M,
          `/datasets/${manifest.datasets.findIndex((d) => d.id === "tail_daily")}/definition`,
        )
          .split("OVERLAP ANSWER:")[1]!
          .split(" The same accounts")[0]!
          .trim()}`,
    ),
    feesOn
      ? L.line(() => `Fee inputs: ${L.s("raw/fees/manifest.json", "/datasets/0/definition")}`)
      : "Fee inputs: not present; see Unable to compute.",
  ].join("\n\n");
  sec("Methods", methods);

  // ============================================================ 5 Primary benchmark
  const order = present([...TOLL, "intents_burn_near", ...SUPPORT]);
  const bench = order.map((id) =>
    trow(() => {
      const s = fcDoc.series[id];
      const row = (m: string, h: number): string => {
        const i = s.backtest.table.findIndex((t: any) => t.model === m && t.horizon === h);
        return s.backtest.table[i].mae === null ? "n/a" : L.n(F, `${sp(id)}/backtest/table/${i}/mae`);
      };
      return [
        label(id),
        MODEL_NAME[s.chosenModel]!.replace("the ", ""),
        row("naive", 90),
        row(s.chosenModel, 30),
        row(s.chosenModel, 60),
        row(s.chosenModel, 90),
        s.skill90 === null ? "n/a" : pctS(`${sp(id)}/skill90`),
        calVal(id) === null ? "n/a" : pctS(calPtr(id)),
        L.s(F, `${sp(id)}/verdict`),
      ];
    }),
  );
  sec(
    "Primary benchmark",
    [
      L.line(
        () =>
          `Backtest of the model used for each series (error is the mean absolute error of the thirty-day average on the transformed scale, lower is better): ${L.count(F, "/series/intents_tx/backtest/origins", fcDoc.series.intents_tx.backtest.origins)} origins for the Intents transaction series.`,
      ),
      "| Series | Model used | Naive error at the longest horizon | Error at the first horizon | Error at the second horizon | Error at the longest horizon | Skill against naive at the longest horizon | Band coverage (time-ordered check) | Verdict |\n|---|---|---|---|---|---|---|---|---|\n" +
        bench.join("\n"),
      "The full table of all five models by horizon, and every origin, is in raw/forecast.json under each series.",
    ].join("\n\n"),
  );

  // ============================================================ 6 Evidence for
  const forLines: string[] = [];
  for (const id of order.filter((i) =>
    ["take_rate_gas", "intents_burn_share", "intents_usd", "intents_tx", "stable_share"].includes(i),
  )) {
    forLines.push(
      L.line(
        () =>
          `- ${label(id)}: the thirty-day average is ${v(id, "/last30")} on ${T}; forecast ${horizonLine(id, 0)}, ${horizonLine(id, 2)}.`,
      ),
    );
  }
  const cpRows: string[] = [];
  for (const id of order.filter((i) => !["intents_burn_near", "usd_per_tail_signer"].includes(i)))
    for (let i = 0; i < 3; i++)
      cpRows.push(
        trow(() => [
          label(id),
          L.s(F, `${sp(id)}/checkpoints/${i}/date`),
          v(id, `/checkpoints/${i}/central`),
          band(id, `/checkpoints/${i}`, "band50"),
          band(id, `/checkpoints/${i}`, "band80"),
          L.s(F, `${sp(id)}/verdict`),
        ]),
      );
  forLines.push(
    L.line(
      () =>
        `- The simulated twelve-month total of settled volume is ${L.n(F, "/derived/intents_usd_12m/centralTotal", (x) => `${fmt(x)} USD`)} on the central path and ${L.n(F, "/derived/intents_usd_12m/p10", (x) => `${fmt(x)} USD`)} to ${L.n(F, "/derived/intents_usd_12m/p90", (x) => `${fmt(x)} USD`)} across the middle eighty percent of paths, against ${L.n(F, "/derived/intents_usd_12m/observedTotalLast365", (x) => `${fmt(x)} USD`)} observed over the last ${L.n(F, "/derived/intents_usd_12m/observedDaysLast365")} observed days (days marked partial are not filled).`,
    ),
  );
  sec("Evidence for", forLines.join("\n"));
  sections.set(
    "Primary benchmark",
    `${sections.get("Primary benchmark")!}\n\nCheckpoints that can prove the thesis wrong (the thirty-day average ending on each date):\n\n| Series | Date | Central | Fifty percent band | Eighty percent band | Verdict |\n|---|---|---|---|---|---|\n${cpRows.join("\n")}`,
  );

  // ============================================================ 7 Evidence against
  const nov = (f: string) => fcDoc.facts.monthly.findIndex((m: any) => m.month === f);
  const iOct = nov("2026-10");
  const iNov = nov("2026-11");
  const against = [
    L.line(
      () =>
        `- Gas is only one toll. Protocol fees, app fees and referral fees may reach NEAR-aligned parties in ways this thesis cannot see; it measures NEAR burnt as gas and the user-paid spread, and nothing else.`,
    ),
    L.line(
      () =>
        `- A low take rate with large volume can still be the larger number in absolute terms: the twelve-month NEAR burnt by the Intents contracts ${fcDoc.derived.intents_burn_near_12m ? `is ${L.n(F, "/derived/intents_burn_near_12m/centralTotal", (x) => `${fmt(x)} NEAR`)} on the central path, worth ${L.n(F, "/derived/intents_burn_near_12m/usdAtLastClose/central", (x) => `${fmt(x)} USD`)} at the last close` : "cannot be computed without the fee inputs"}.`,
    ),
    L.line(
      () =>
        `- The NEAR price is held fixed at the last close of ${L.n(F, "/derived/lastClose/usdPerNear", (x) => `${fmt(x)} USD`)} in every USD figure for NEAR burnt; it is not a price forecast. The price moved from ${L.n(F, "/facts/price/first", (x) => `${fmt(x)} USD`)} to ${L.n(F, "/facts/price/last", (x) => `${fmt(x)} USD`)} (${L.n(F, "/facts/price/change", (x) => `${fmt(x * 100)}%`)}) over the same months.`,
    ),
    L.line(
      () =>
        `- The fee window and the contract set are choices: the take rate counts NEAR burnt by the narrow set of Intents contracts over the window frozen in the fee manifest, divided by settled USD from the Explorer API; another window or a wider contract set gives another rate.`,
    ),
    L.line(
      () =>
        `- Intents activity depends on one protocol's design choices. Private settlement since 2026-10-27 hides part of it, so lower recent values can be unobserved activity rather than less activity.`,
    ),
    L.line(
      () =>
        `- A year of data cannot score a twelve-month horizon: the longest scored horizon is ${L.n(F, "/method/config/horizons/2")} days with about ${L.count(F, "/series/intents_tx/backtest/origins", fcDoc.series.intents_tx.backtest.origins)} origins, so the forecasts at ${L.n(F, "/method/config/reportHorizons/1")} and ${L.n(F, "/method/config/reportHorizons/2")} days are extrapolations and the bands beyond ${L.n(F, "/method/config/horizons/2")} days rest on a stated square-root assumption.`,
    ),
    L.line(
      () =>
        `- Account counts are signers, not people: one person can use several accounts, and the long tail includes automated accounts below the head threshold of ${L.n(M, "/headThreshold")} organic transactions a day.`,
    ),
    L.line(
      () =>
        `- The November 2026 jump may be an outlier: Intents transactions averaged ${L.n(F, `/facts/monthly/${iNov}/intents_tx`)} a day in ${L.s(F, `/facts/monthly/${iNov}/month`)} against ${L.n(F, `/facts/monthly/${iOct}/intents_tx`)} in ${L.s(F, `/facts/monthly/${iOct}/month`)}, and a trend model reads a jump as a trend.`,
    ),
    L.line(
      () =>
        `- Stable-to-stable swaps include same-stablecoin cross-chain transfers, so a rising stable-to-stable share measures stablecoin movement through Intents, not trading.`,
    ),
    ...present(order).map((id) =>
      L.line(
        () =>
          `- ${label(id)}: ${modelLine(id)}; the eighty percent band held the realised value ${calVal(id) === null ? "in no scored case" : `in ${pctS(calPtr(id))} of scored cases ${calHow(id)}`}; verdict ${verdictOf(id)}.`,
      ),
    ),
  ];
  sec("Evidence against", against.join("\n"));

  // ============================================================ 8 Confounders
  const brk = "/facts/break";
  sec(
    "Confounders and blind spots",
    [
      L.line(
        () =>
          `- The known break on ${L.s(F, `${brk}/day`)}: total transactions changed by ${L.n(F, `${brk}/totalChange`, (x) => `${fmt(x * 100)}%`)} overnight (from ${L.n(F, `${brk}/totalPrev`)} to ${L.n(F, `${brk}/totalDay`)}) while head transactions changed by ${L.n(F, `${brk}/headChange`, (x) => `${fmt(x * 100)}%`)} and long-tail transactions by ${L.n(F, `${brk}/tailTxChange`, (x) => `${fmt(x * 100)}%`)} and long-tail signers by ${L.n(F, `${brk}/tailSignersChange`, (x) => `${fmt(x * 100)}%`)}. Because the heavy head is excluded, F2 and F3 are not affected by it by construction, and the numbers confirm it.`,
      ),
      L.line(
        () =>
          `- Composition excursion in May 2026: the NEAR-token leg share of settled volume peaked at ${L.n(F, "/facts/excursion/peakShare", (x) => `${fmt(x * 100)}%`)} on ${L.s(F, "/facts/excursion/peakDay")} and averaged ${L.n(F, "/facts/excursion/mayShare", (x) => `${fmt(x * 100)}%`)} in the month against ${L.n(F, "/facts/excursion/juneShare", (x) => `${fmt(x * 100)}%`)} in June. In ${L.s(F, "/facts/excursion/from")} to ${L.s(F, "/facts/excursion/to")} the route ${L.s(F, "/facts/excursion/topRoute")} carried ${L.n(F, "/facts/excursion/topRouteUsd", (x) => `${fmt(x)} USD`)} (${L.n(F, "/facts/excursion/topRouteShareOfNearLeg", (x) => `${fmt(x * 100)}%`)} of the NEAR-leg volume of those days; median swap ${L.n(F, "/facts/excursion/topRouteMedianUsd", (x) => `${fmt(x)} USD`)}) and ${L.s(F, "/facts/excursion/secondRoute")} carried ${L.n(F, "/facts/excursion/secondRouteUsd", (x) => `${fmt(x)} USD`)}; together the two are ${L.n(F, "/facts/excursion/twoRoutesShareOfNearLeg", (x) => `${fmt(x * 100)}%`)} of it, so the excursion is two routes, not broad NEAR use.`,
      ),
      "- Swap data: the Explorer feed has partial days (listed in the manifest), is not all Intents activity, and shows a swap's USD value as the provider recorded it. Registry mapping decides which volume counts as stable or NEAR-chain; an unmapped leg is reported separately and never counted as either.",
      "- Accounts are not people, the head threshold is a choice, and 'new' signers are new since the window start, not lifetime.",
      "- Seasonal effects are not modelled (the data holds one year, so a weekly or yearly pattern cannot be separated from the trend).",
      feesNote(),
    ].join("\n"),
  );

  // ============================================================ 9 Mechanisms
  sec(
    "Long-term economic mechanisms",
    [
      "- NEAR is paid when a transaction burns gas: a share of the gas fee is burnt, so the Intents contracts pay NEAR in proportion to the transactions addressed to them, not in proportion to the dollars those transactions settle. A larger settled size per transaction therefore lowers the take rate, and more transactions of the same size raise the NEAR burnt without changing the rate.",
      "- The user-paid spread (the gap between the quoted and the executed price) is paid to market makers and the protocol's solver network; it reaches NEAR only if the receiving parties are NEAR-aligned, which this thesis cannot observe.",
      "- Stablecoin movement between other chains pays the same gas as any other swap but carries little price risk for the user, so a rising stable-to-stable share can lower the take rate without lowering the activity.",
      "- These mechanisms are stated as hypotheses to be checked by the checkpoints, not as findings.",
    ].join("\n"),
  );

  // ============================================================ 10 Claims
  const mk = (
    id: string,
    kindOf: Claim["kind"],
    statement: () => string,
    verdict: () => string,
    estimate: () => string,
    uncertainty: () => string,
    counterexample: () => string,
    falsification: () => string,
    provenance: string,
  ): void => {
    const all = L.collect(() => {
      const parts = [statement(), verdict(), estimate(), uncertainty(), counterexample(), falsification()];
      return parts.join("\u0001");
    });
    const [a, b, c, d, e, f] = all.text.split("\u0001") as [string, string, string, string, string, string];
    claimsOut.push({
      id,
      statement: a,
      kind: kindOf,
      verdict: b,
      estimate: c,
      uncertainty: d,
      counterexample: e,
      falsification: f,
      provenance,
      refs: all.refs,
    });
  };
  const seriesClaim = (id: string, statement: string, dirWord: string): void =>
    mk(
      `claim-${id}`,
      "hypothesis",
      () => statement,
      () => verdictOf(id),
      () => `${label(id)}: ${horizonLine(id, 2)}`,
      () =>
        `${modelLine(id)}; coverage of the eighty percent band ${calVal(id) === null ? "not available" : pctS(calPtr(id))}`,
      () =>
        `Last thirty-day average ${v(id, "/last30")}; the forecast ${fcDoc.series[id].verdict === "FORECAST_LOW_SKILL" ? "does not beat naive with a calibrated band" : "beats naive"}`,
      () =>
        `Wrong if the realised thirty-day average is ${dirWord} the eighty percent band at two consecutive checkpoints (${fcDoc.series[id].checkpoints.map((c: any) => c.date).join(", ")}); the first bound is ${v(id, "/checkpoints/0/against/bound")}`,
      `raw/forecast.json series ${id}`,
    );
  const unavailableClaim = (id: string, statement: string): void =>
    void claimsOut.push({
      id: `claim-${id}`,
      statement,
      kind: "hypothesis",
      verdict: "NOT_COMPUTED",
      estimate: "none",
      uncertainty: "none",
      counterexample: "none",
      falsification:
        "Computed when thesis/raw/fees/manifest.json provides the series; then the checkpoint rule of the series applies.",
      provenance: "thesis/raw/fees/manifest.json (absent)",
      refs: [],
    });
  if (fcDoc.series.take_rate_gas)
    seriesClaim(
      "take_rate_gas",
      "The share of settled value that reaches NEAR as gas burnt stays small as volume grows (take rate by gas, basis points).",
      "above",
    );
  else
    unavailableClaim(
      "take_rate_gas",
      "The share of settled value that reaches NEAR as gas burnt stays small as volume grows (take rate by gas).",
    );
  if (fcDoc.series.intents_burn_share)
    seriesClaim("intents_burn_share", "Intents stays a minor share of all NEAR burnt.", "above");
  else unavailableClaim("intents_burn_share", "Intents stays a minor share of all NEAR burnt.");
  if (fcDoc.series.spread_bps_stable)
    seriesClaim(
      "spread_bps_stable",
      "The user-paid spread on stablecoin-to-stablecoin swaps stays small.",
      "above",
    );
  else
    unavailableClaim(
      "spread_bps_stable",
      "The user-paid spread on stablecoin-to-stablecoin swaps stays small.",
    );
  if (fcDoc.derived.intents_burn_near_12m)
    mk(
      "claim-burn-twelve-months",
      "derived statistic",
      () =>
        "NEAR burnt by the Intents contracts over the next twelve months, in NEAR and in USD at a fixed last close.",
      () => "FORECAST",
      () =>
        `${L.n(F, "/derived/intents_burn_near_12m/centralTotal", (x) => `${fmt(x)} NEAR`)}, ${L.n(F, "/derived/intents_burn_near_12m/usdAtLastClose/central", (x) => `${fmt(x)} USD`)} at the last close`,
      () =>
        `Middle eighty percent of simulated paths: ${L.n(F, "/derived/intents_burn_near_12m/p10", (x) => `${fmt(x)} NEAR`)} to ${L.n(F, "/derived/intents_burn_near_12m/p90", (x) => `${fmt(x)} NEAR`)}; price held fixed`,
      () => "A large amount in absolute terms can sit beside a small take rate",
      () =>
        "Wrong if the realised twelve-month NEAR burnt by the Intents contracts falls outside the simulated eighty percent range",
      "raw/forecast.json derived",
    );
  else
    unavailableClaim(
      "burn-twelve-months",
      "NEAR burnt by the Intents contracts over the next twelve months, in NEAR and USD.",
    );
  if (fcDoc.derived.toll_split.rows.length)
    mk(
      "claim-toll-split",
      "derived statistic",
      () =>
        "Per hundred dollars settled, how many cents go to NEAR burn and to the measured user-paid spread.",
      () => "FORECAST",
      () =>
        fcDoc.derived.toll_split.rows
          .map(
            (r: any, i: number) =>
              `${r.label}: ${L.n(F, `/derived/toll_split/rows/${i}/centsPer100Usd/last30`, (x) => `${fmt(x)} cents`)}`,
          )
          .join("; "),
      () => "See the series claims for the bands",
      () => "Fees outside gas and the spread are not measured",
      () => "Wrong if either component leaves its eighty percent band at two consecutive checkpoints",
      "raw/forecast.json derived toll_split",
    );
  else
    unavailableClaim(
      "toll-split",
      "Per hundred dollars settled, how many cents go to NEAR burn and to the user-paid spread.",
    );

  seriesClaim("intents_tx", "Transactions touching the Intents contracts keep rising.", "below");
  seriesClaim("tail_tx", "Long-tail organic transactions keep falling.", "above");
  seriesClaim("tail_signers", "The long tail of ordinary accounts keeps shrinking.", "above");
  seriesClaim("intents_usd", "Settled volume stays at or above its current level.", "below");
  mk(
    "claim-crossover",
    "hypothesis",
    () => "Intents transactions overtake long-tail organic transactions.",
    () =>
      co.aboveAtLastDay ? "ALREADY_ABOVE" : co.centralDate === null ? "NO_CROSSING_IN_FORECAST" : "FORECAST",
    () =>
      co.aboveAtLastDay
        ? `Already above on ${T}`
        : co.centralDate === null
          ? "No crossing within the next year on the central path"
          : `Central crossing ${L.s(F, "/derived/crossover/centralDate")}`,
    () =>
      `Probability within six months ${pctS("/derived/crossover/within6Months")}, within twelve months ${pctS("/derived/crossover/within12Months")}`,
    () => "The two thirty-day averages are close, so a small error in either moves the date",
    () =>
      `Wrong if there is no crossing by ${L.s(F, "/derived/crossover/twelveMonthsDate")} while the twelve-month probability is above one half`,
    "raw/forecast.json derived crossover",
  );
  mk(
    "claim-usd-twelve-months",
    "derived statistic",
    () => "Settled volume over the next twelve months.",
    () => "FORECAST",
    () => `${L.n(F, "/derived/intents_usd_12m/centralTotal", (x) => `${fmt(x)} USD`)} on the central path`,
    () =>
      `Middle eighty percent of paths: ${L.n(F, "/derived/intents_usd_12m/p10", (x) => `${fmt(x)} USD`)} to ${L.n(F, "/derived/intents_usd_12m/p90", (x) => `${fmt(x)} USD`)}`,
    () => "Partial swap days in the history are absent, not filled",
    () => "Wrong if the realised twelve-month total falls outside the simulated eighty percent range",
    "raw/forecast.json derived",
  );
  seriesClaim(
    "stable_share",
    "Stablecoin-to-stablecoin movement keeps rising as a share of settled volume.",
    "below",
  );
  mk(
    "claim-stable-half",
    "hypothesis",
    () => "The stable-to-stable share crosses one half.",
    () => (fcDoc.derived.stable_share_threshold.aboveAtLastDay ? "ALREADY_ABOVE" : "FORECAST"),
    () =>
      fcDoc.derived.stable_share_threshold.centralDate === null
        ? "No crossing within the next year on the central path"
        : `Central crossing ${L.s(F, "/derived/stable_share_threshold/centralDate")}`,
    () => `Probability within twelve months ${pctS("/derived/stable_share_threshold/within12Months")}`,
    () =>
      `The thirty-day average is ${L.n(F, "/derived/stable_share_threshold/last30", (x) => `${fmt(x * 100)}%`)} today`,
    () =>
      `Wrong if the share is still below one half on ${L.s(F, "/derived/crossover/twelveMonthsDate")} while the probability above is above one half`,
    "raw/forecast.json derived",
  );
  seriesClaim("no_near_share", "Almost all settled volume touches no NEAR-chain asset.", "below");
  seriesClaim("near_token_share", "The NEAR token remains a minor leg of settled volume.", "above");

  const cell = (s: string): string => s.replace(/\|/g, "/").replace(/\n/g, " ");
  const claimTable = [
    "| id | statement | kind | verdict | estimate | uncertainty | counterexample | falsificationCondition | provenance |",
    "|---|---|---|---|---|---|---|---|---|",
    ...claimsOut.map((c) => {
      const cells = [
        c.id,
        c.statement,
        c.kind,
        c.verdict,
        c.estimate ?? "none",
        c.uncertainty ?? "none",
        c.counterexample ?? "none",
        c.falsification,
        c.provenance,
      ];
      return `| ${cells.map(cell).join(" | ")}${refs(c.refs)} |`;
    }),
  ].join("\n");
  sec("Verdict per claim", claimTable);

  // ============================================================ 11 Reproduction
  sec(
    "Reproduction",
    [
      "From the repository root `nearesis-app`:",
      "- `pnpm thesis:data` re-freezes thesis/raw from the local databases (read-only SELECTs); add `--bigquery` to re-run the billed BigQuery cross-checks.",
      "- `pnpm thesis:build` runs the forecast engine on the frozen data and writes raw/forecast.json, THESIS.md, FACTS.md, the static site, thesis.json and HASHES.json, offline.",
      "- `pnpm thesis:verify` rebuilds into a temporary directory and compares every hash, including raw/forecast.json; it exits with an error if any file differs.",
      "- `pnpm thesis:verify --dir thesis/archive/intents-vs-price-v1` verifies the archived previous version.",
      "Input hashes are listed in the Source index; output hashes are in thesis/build/HASHES.json.",
    ].join("\n"),
  );

  // ============================================================ 12 Unable to compute
  for (const m of inp.fees.missing) addU(`Fee series ${m.id}`, () => `Not computed: ${m.why}.`);
  if (!inp.fees.topPayers && feesOn)
    addU("Top fee payers", () => "Not computed: no fee dataset named like a payer table was found.");
  addU(
    "Fees other than gas and the user-paid spread",
    () =>
      "Protocol fees, app fees and referral fees paid to NEAR-aligned parties are not in the frozen data.",
  );
  addU(
    "Private (shielded) Intents settlement after 2026-10-27",
    () => "Not observed on chain or in the Explorer feed; lower later values mean unobserved, not zero.",
  );
  addU(
    "Forecast skill at twelve months",
    () =>
      `The backtest scores horizons up to ${L.n(F, "/method/config/horizons/2")} days only; the forecasts at ${L.n(F, "/method/config/reportHorizons/1")} and ${L.n(F, "/method/config/reportHorizons/2")} days are extrapolations.`,
  );
  addU(
    "Causal effect of Intents on the long tail of accounts",
    () => "Excluded by design: this thesis forecasts and does not test a causal link.",
  );
  for (const q of manifest.bigQueryQueries)
    if (!q.executed)
      addU(
        `BigQuery query ${q.id}`,
        () => "The SQL ships but was not executed in this build; no cross-check exists.",
      );
  manifest.datasets.forEach((d, i) => {
    if (d.coverage.missingDays.length)
      addU(
        `Days missing in ${d.id}`,
        () =>
          `${L.count(M, `/datasets/${i}/coverage/missingDays`, d.coverage.missingDays.length)} days (${d.coverage.missingDays.length > 6 ? `first ${d.coverage.missingDays[0]}, last ${d.coverage.missingDays[d.coverage.missingDays.length - 1]}` : d.coverage.missingDays.join(", ")}); absent, never filled with zero.`,
      );
  });
  sec("Unable to compute", unable.map((u) => `- **${u.what}**: ${u.why}${refs(u.refs)}`).join("\n"));

  // ============================================================ 13 Source index
  const srcLines = [
    "Citations in square brackets are `file#pointer`. `raw/` is thesis/raw (raw/forecast.json is generated by the build from the other raw files), `archive/` is thesis/archive, and the other paths are under thesis/.",
    "| Cited as | Location | sha256 |\n|---|---|---|\n" +
      inp.files.map((f) => `| ${f.cite} | ${f.where} | ${f.sha256} |`).join("\n"),
    `raw/forecast.json is generated: its sha256 is in thesis/build/HASHES.json and its inputs are the files above.`,
  ].join("\n\n");
  sec("Source index", srcLines);

  // ============================================================ 14 Changes
  const changes: string[] = [
    `First generated version of this forecast bundle, id ${version}. The version id is derived from the input hashes and the forecast file, so any change in the frozen data changes it.`,
  ];
  if (inp.archive)
    changes.push(
      L.line(
        () =>
          `- The previous reference thesis (${L.s("archive/thesis.json", "/hypothesis")}) is archived at ${inp.archive!.path} with its verdict ${L.s("archive/thesis.json", "/verdict/status")} (version ${L.s("archive/thesis.json", "/version")}). It stays verifiable with \`pnpm thesis:verify --dir thesis/archive/intents-vs-price-v1\` and its files are served under /v1/thesis/files/archive/intents-vs-price-v1/.`,
      ),
    );
  sec("Changes since previous version", changes.join("\n\n"));

  // ---- authored analysis blocks ------------------------------------------------------------------------------------------
  const ids = SECTION_TITLES.map((t) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
  );
  const authored = parseInterpretation(inp.interpretation);
  for (const k of authored.keys())
    if (!ids.includes(k))
      throw new ForecastBuildError(`interpretation.md: unknown section id ${k}`, { known: ids });
  const authoredViolations: GroundViolation[] = [];
  let checked = 0;
  SECTION_TITLES.forEach((title, i) => {
    const block = authored.get(ids[i]!);
    if (!block) return;
    const bad = validateInterpretationText(block);
    if (bad.length)
      throw new ForecastBuildError(`interpretation.md section ${ids[i]} fails the wording rules`, bad);
    registerAuthored(L, block);
    const r = scanGrounding(block, L);
    checked += r.numbersChecked;
    for (const x of r.violations)
      authoredViolations.push({ ...x, text: `interpretation ${ids[i]}: ${x.text}` });
    sections.set(title, `**Analysis**\n\n${block}\n\n**Computed**\n\n${sections.get(title)!}`);
  });
  if (authoredViolations.length)
    throw new ForecastBuildError(
      `ungrounded numbers in interpretation.md: ${authoredViolations.length}`,
      authoredViolations.slice(0, 20),
    );

  // ---- assemble ----------------------------------------------------------------------------------------------------------------
  const outSections = SECTION_TITLES.map((title, i) => ({
    id: ids[i]!,
    title,
    markdown: sections.get(title)!,
  }));
  const markdown =
    `# ${THESIS_TITLE}\n\n` +
    `Version ${version}; generated from frozen data only (frozen at ${manifest.frozenAt}).\n\n` +
    outSections.map((s) => `## ${s.title}\n\n${s.markdown}`).join("\n\n") +
    "\n";

  // ---- charts ---------------------------------------------------------------------------------------------------------------------
  const feeDatasets = inp.fees.manifest?.datasets ?? [];
  const bitsInp = {
    manifest: { ...manifest, datasets: [...manifest.datasets, ...feeDatasets] },
    sql: inp.sql,
  } as unknown as Inputs;
  const bits = (idsIn: string[]) => datasetBits(bitsInp, idsIn);
  const charts: FChart[] = [];
  const fromOf = (id: string): string[] => {
    const f = inp.meta.get(id)!.from;
    if (id === "usd_per_tail_signer") return ["intents_volume_daily", "tail_daily"];
    if (id === "intents_burn_share" && f === "fees/derived")
      return feesDatasetIds(["intents_burn_near", "total_burn_near"]);
    return [f.startsWith("fees/") ? f.slice(5) : f];
  };
  function feesDatasetIds(sids: string[]): string[] {
    return sids.map((s) => inp.meta.get(s)?.from.slice(5)).filter((x): x is string => !!x);
  }
  const histX = inp.days;
  const futX = Array.from({ length: 365 }, (_, k) => addDays(T, k + 1));
  const dec = (x: number | null): string | null => (x === null ? null : String(round(x, 4)));
  const forecastChart = (id: string, title: string, against: string, extra: Partial<FChart> = {}): void => {
    const sv = inp.series.find((s) => s.id === id)!;
    const hist = trailingAverage(sv.values, 30);
    const s = fcDoc.series[id];
    const joinHist = hist[hist.length - 1] ?? null;
    const padH = (a: (number | null)[]): (string | null)[] => a.map(dec);
    const padF = (arr: number[]): (string | null)[] => [
      ...histX.map((_, k) => (k === histX.length - 1 ? dec(joinHist) : null)),
      ...arr.map((x) => dec(x)),
    ];
    const mkS = (name: string, arr: number[]) => ({ name, values: padF(arr) });
    const sent = L.collect(
      () =>
        `${label(id)}: the thirty-day average is ${v(id, "/last30")} on ${T}, and it is forecast ${horizonLine(id, 0)} and ${horizonLine(id, 2)}; ${modelLine(id)}.`,
    );
    const ag = L.collect(
      () =>
        `${against} Verdict ${verdictOf(id)}: band coverage ${calVal(id) === null ? "not available" : pctS(calPtr(id))} ${calHow(id)}, and the forecasts beyond ${L.n(F, "/method/config/horizons/2")} days cannot be scored.`,
    );
    const b = bits(fromOf(id));
    charts.push({
      id: `forecast-${id.replace(/_/g, "-")}`,
      title,
      kind: "line",
      xKind: "date",
      unit: `${inp.meta.get(id)!.unit} (thirty-day average)`,
      sentence: sent.text,
      sentenceRefs: sent.refs,
      evidenceAgainst: ag.text,
      evidenceAgainstRefs: ag.refs,
      x: [...histX, ...futX],
      series: [
        { name: "history", values: [...padH(hist), ...futX.map(() => null)] },
        mkS("forecast", s.path.central),
        mkS("band80_lo", s.path.band80Lo),
        mkS("band80_hi", s.path.band80Hi),
        mkS("band50_lo", s.path.band50Lo),
        mkS("band50_hi", s.path.band50Hi),
      ],
      datasetIds: fromOf(id),
      sqlExecuted: b.sqlExecuted,
      sqlBigQuery: b.sqlBigQuery,
      bigQueryExecuted: b.bigQueryExecuted,
      queries: b.queries,
      source: b.source,
      window: { from: histX[0]!, to: futX[futX.length - 1]! },
      caveats: [
        ...b.caveats,
        "The forecast part (after the last observed day) is a model output, drawn dashed.",
      ],
      sha256: b.sha256,
      forecastFrom: futX[0],
      bands: true,
      format: inp.meta.get(id)!.transform === "logit" ? "share" : "number",
      ...extra,
    });
  };
  const GENERIC_AGAINST = "A year of data is a short sample for a trend;";
  const tollAgainst =
    "Gas is only one toll, and protocol or app fees that reach NEAR-aligned parties are not visible here; the fee window and contract set are choices.";
  if (fcDoc.series.take_rate_gas)
    forecastChart("take_rate_gas", "Take rate by gas over time, with forecast", tollAgainst);
  if (fcDoc.series.intents_burn_share)
    forecastChart("intents_burn_share", "Intents' share of all NEAR burnt", tollAgainst);
  // who pays NEAR's tolls
  if (inp.fees.topPayers) {
    const tp = inp.fees.topPayers;
    const b = bits([tp.id]);
    const top = Math.min(15, tp.names.length);
    const total = tp.values.reduce((a, x) => a + Number(x), 0);
    const sent = L.collect(
      () =>
        `${tp.names[0]} is the largest fee payer with ${L.n(tp.file, `/rows/0/${tp.valueCol}`, (x) => fmt(x))} (${L.derived(tp.file, "share_of_listed", ["/rows"], fmt((Number(tp.values[0]) / total) * 100))}% of the listed total) among ${L.count(tp.file, "/rows", tp.names.length)} listed payers.`,
    );
    charts.push({
      id: "top-fee-payers",
      title: "Who pays NEAR's tolls: top fee payers",
      kind: "bar",
      xKind: "label",
      unit: "as in the fee file",
      sentence: sent.text,
      sentenceRefs: sent.refs,
      evidenceAgainst: "Payers are accounts, not people; one operator can run many accounts.",
      evidenceAgainstRefs: [],
      x: tp.names.slice(0, top),
      series: [{ name: "value", values: tp.values.slice(0, top) }],
      datasetIds: [tp.id],
      sqlExecuted: b.sqlExecuted,
      sqlBigQuery: b.sqlBigQuery,
      bigQueryExecuted: b.bigQueryExecuted,
      queries: b.queries,
      source: b.source,
      window: { from: inp.manifest.window.from, to: inp.manifest.window.to },
      caveats: b.caveats,
      sha256: b.sha256,
    });
  }
  // the toll split
  if (fcDoc.derived.toll_split.rows.length) {
    const rows = fcDoc.derived.toll_split.rows as any[];
    const sent = L.collect(
      () =>
        `Per hundred dollars settled, ${rows.map((r, i) => `${L.n(F, `/derived/toll_split/rows/${i}/centsPer100Usd/last30`, (x) => `${fmt(x)} cents`)} go to ${r.label}`).join(" and ")} on the last thirty days${fcDoc.derived.toll_split.rows.length > 1 ? `, ${L.n(F, "/derived/toll_split/last30Total", (x) => `${fmt(x)} cents`)} together` : ""}.`,
    );
    charts.push({
      id: "toll-split",
      title: "The toll split: cents per 100 USD settled",
      kind: "bar",
      xKind: "label",
      unit: "cents per 100 USD settled",
      sentence: sent.text,
      sentenceRefs: sent.refs,
      evidenceAgainst:
        "Only gas burnt and the measured user-paid spread are in the split; other fees are not observed.",
      evidenceAgainstRefs: [],
      x: rows.map((r) => r.label),
      series: [
        { name: "last 30 days", values: rows.map((r) => String(r.centsPer100Usd.last30)) },
        { name: "forecast in 365 days", values: rows.map((r) => String(r.centsPer100Usd.plus365.central)) },
      ],
      datasetIds: [],
      sqlExecuted: "-- Derived from the take rate and spread series in raw/forecast.json; no SQL.",
      sqlBigQuery: null,
      bigQueryExecuted: false,
      queries: [],
      source: "raw/forecast.json derived toll_split",
      window: { from: inp.manifest.window.from, to: futX[futX.length - 1]! },
      caveats: ["One basis point is one cent per hundred dollars."],
      sha256: sha(JSON.stringify(rows)),
    });
  }
  forecastChart(
    "no_near_share",
    "Volume that touches no NEAR asset",
    "Registry mapping decides which volume counts; the May excursion shows a few routes can move the share.",
  );
  forecastChart(
    "intents_usd",
    "Settled volume per day",
    "Partial swap days are absent, and private settlement since 2026-10-27 is not observed.",
  );
  forecastChart(
    "intents_tx",
    "F1 Intents transactions per day",
    "Intents activity depends on one protocol's design, and the November jump may be an outlier.",
  );
  forecastChart(
    "tail_tx",
    "F2 long-tail organic transactions per day",
    GENERIC_AGAINST + " accounts are signers, not people.",
  );
  forecastChart("tail_signers", "F3 long-tail signers per day", GENERIC_AGAINST + " signers are not people.");
  // crossover chart
  {
    const a = fcDoc.series.intents_tx;
    const b2 = fcDoc.series.tail_tx;
    const hA = trailingAverage(inp.series.find((s) => s.id === "intents_tx")!.values, 30);
    const hB = trailingAverage(inp.series.find((s) => s.id === "tail_tx")!.values, 30);
    const join = (h: (number | null)[], arr: number[]): (string | null)[] => [
      ...histX.map((_, k) => (k === histX.length - 1 ? dec(h[h.length - 1] ?? null) : null)),
      ...arr.map((x) => dec(x)),
    ];
    const sent = L.collect(crossText);
    const bq = bits(["intents_tx_daily", "tail_daily"]);
    charts.push({
      id: "crossover",
      title: "Crossover: Intents transactions and long-tail organic transactions",
      kind: "line",
      xKind: "date",
      unit: "transactions per day (thirty-day average)",
      sentence: sent.text,
      sentenceRefs: sent.refs,
      evidenceAgainst:
        "The two series are close, the November jump may be an outlier, and the crossover date moves with a small error in either series.",
      evidenceAgainstRefs: [],
      x: [...histX, ...futX],
      series: [
        { name: "F1 history", values: [...hA.map(dec), ...futX.map(() => null)] },
        { name: "F1 forecast", values: join(hA, a.path.central) },
        { name: "F2 history", values: [...hB.map(dec), ...futX.map(() => null)] },
        { name: "F2 forecast", values: join(hB, b2.path.central) },
        { name: "F1 band80_lo", values: join(hA, a.path.band80Lo) },
        { name: "F1 band80_hi", values: join(hA, a.path.band80Hi) },
        { name: "F2 band80_lo", values: join(hB, b2.path.band80Lo) },
        { name: "F2 band80_hi", values: join(hB, b2.path.band80Hi) },
      ],
      datasetIds: ["intents_tx_daily", "tail_daily"],
      sqlExecuted: bq.sqlExecuted,
      sqlBigQuery: bq.sqlBigQuery,
      bigQueryExecuted: bq.bigQueryExecuted,
      queries: bq.queries,
      source: bq.source,
      window: { from: histX[0]!, to: futX[futX.length - 1]! },
      caveats: bq.caveats,
      sha256: bq.sha256,
      forecastFrom: futX[0],
      bands: true,
      ...(co.centralDate ? { refLine: { value: String(co.centralDate), label: "central crossover" } } : {}),
    });
  }
  forecastChart(
    "stable_share",
    "F5 stable-to-stable share of settled volume",
    "Same-stablecoin cross-chain transfers count as stable-to-stable.",
    { refLine: { value: "0.5", label: "one half" } },
  );
  forecastChart(
    "near_token_share",
    "F7 share of volume with a NEAR-token leg",
    "Two routes drove the May peak, so the series has an outlier month.",
  );
  forecastChart(
    "usd_per_tail_signer",
    "F8 settled volume per long-tail signer",
    "A ratio of two forecast quantities; both are uncertain.",
  );
  // backtest skill bars
  {
    const ids2 = order.filter((i) => i !== "intents_burn_near");
    const skillAt = (id: string, h: number): string | null => {
      const t = fcDoc.series[id].backtest.table.find(
        (x: any) => x.model === fcDoc.series[id].chosenModel && x.horizon === h,
      );
      return t && t.skill !== null ? String(t.skill) : null;
    };
    const best = ids2.reduce(
      (a, i) => ((fcDoc.series[i].skill90 ?? -9) > (fcDoc.series[a].skill90 ?? -9) ? i : a),
      ids2[0]!,
    );
    const sent = L.collect(
      () =>
        `The model used beats naive at the longest horizon for ${L.count(F, "/series", ids2.filter((i) => (fcDoc.series[i].skill90 ?? 0) > 0).length)} of ${L.count(F, "/series", ids2.length)} series; the best skill is ${pctS(`${sp(best)}/skill90`)} for ${label(best)}.`,
    );
    charts.push({
      id: "backtest-skill",
      title: "Backtest skill against naive, by horizon",
      kind: "bar",
      xKind: "label",
      unit: "skill (one minus error ratio; above zero beats naive)",
      sentence: sent.text,
      sentenceRefs: sent.refs,
      evidenceAgainst: "Skill is scored on about ten origins at the longest horizon, so it is noisy.",
      evidenceAgainstRefs: [],
      x: ids2.map((i) => inp.meta.get(i)!.label.replace(/^F\d /, "")),
      series: [30, 60, 90].map((h) => ({ name: `${h} days`, values: ids2.map((i) => skillAt(i, h)) })),
      datasetIds: [],
      sqlExecuted:
        "-- Not a SQL result: the backtest is computed by scripts/thesis/forecast.ts from the frozen series.",
      sqlBigQuery: null,
      bigQueryExecuted: false,
      queries: [],
      source: "raw/forecast.json backtest tables",
      window: { from: histX[0]!, to: T },
      caveats: [],
      sha256: sha(JSON.stringify(ids2.map((i) => fcDoc.series[i].backtest.table))),
    });
  }
  // April 2026 break
  {
    const dFrom = addDays("2026-04-02", -30);
    const dTo = addDays("2026-04-02", 29);
    const xs = Array.from({ length: 60 }, (_, k) => addDays(dFrom, k));
    const tt = columnMap(inp.raw.get("transactions_daily")!, "tx_total");
    const hh = columnMap(inp.raw.get("transactions_daily")!, "tx_head");
    const tl = columnMap(inp.raw.get("tail_daily")!, "tail_tx");
    const b = bits(["transactions_daily", "tail_daily"]);
    const sent = L.collect(
      () =>
        `On ${L.s(F, "/facts/break/day")} total transactions changed by ${L.n(F, "/facts/break/totalChange", (x) => `${fmt(x * 100)}%`)} overnight while long-tail transactions changed by ${L.n(F, "/facts/break/tailTxChange", (x) => `${fmt(x * 100)}%`)}.`,
    );
    charts.push({
      id: "april-break",
      title: "The 2026-04-02 break: total, head and tail transactions",
      kind: "line",
      xKind: "date",
      unit: "transactions per day",
      sentence: sent.text,
      sentenceRefs: sent.refs,
      evidenceAgainst:
        "Sixty days around one date show one event; they say nothing about whether the head will return.",
      evidenceAgainstRefs: [],
      x: xs,
      series: [
        { name: "total", values: xs.map((d) => dec(tt.get(d) ?? null)) },
        { name: "head", values: xs.map((d) => dec(hh.get(d) ?? null)) },
        { name: "tail", values: xs.map((d) => dec(tl.get(d) ?? null)) },
      ],
      datasetIds: ["transactions_daily", "tail_daily"],
      sqlExecuted: b.sqlExecuted,
      sqlBigQuery: b.sqlBigQuery,
      bigQueryExecuted: b.bigQueryExecuted,
      queries: b.queries,
      source: b.source,
      window: { from: dFrom, to: dTo },
      caveats: b.caveats,
      sha256: b.sha256,
      refLine: { value: "2026-04-02", label: "break" },
    });
  }
  // chain pairs
  {
    const pr = inp.raw.get("chain_pairs_monthly")!;
    const monthsAll = [...new Set(pr.rows.map((r) => String(r[0])))].sort();
    const pairNames = (fcDoc.facts.chainPairs.pairs as any[]).map((p) => p.pair as string);
    const b = bits(["chain_pairs_monthly"]);
    const sent = L.collect(
      () =>
        `The largest chain pair, ${L.s(F, "/facts/chainPairs/pairs/0/pair")}, carried ${L.n(F, "/facts/chainPairs/pairs/0/usd", (x) => `${fmt(x)} USD`)} (${L.n(F, "/facts/chainPairs/pairs/0/shareOfListed", (x) => `${fmt(x * 100)}%`)} of the ten listed pairs) over the window.`,
    );
    charts.push({
      id: "chain-pairs",
      title: "Monthly volume of the top 10 chain pairs",
      kind: "line",
      xKind: "label",
      unit: "USD per month",
      sentence: sent.text,
      sentenceRefs: sent.refs,
      evidenceAgainst:
        "The first and last months are partial, and a chain pair is the registry's blockchain of each asset, not the route a user sees.",
      evidenceAgainstRefs: [],
      x: monthsAll,
      series: pairNames.map((p) => ({
        name: p,
        values: monthsAll.map((m) => {
          const [o, d] = p.split(" to ");
          const r = pr.rows.find((x) => x[0] === m && x[1] === o && x[2] === d);
          return r ? String(r[3]) : null;
        }),
      })),
      datasetIds: ["chain_pairs_monthly"],
      sqlExecuted: b.sqlExecuted,
      sqlBigQuery: b.sqlBigQuery,
      bigQueryExecuted: b.bigQueryExecuted,
      queries: b.queries,
      source: b.source,
      window: { from: inp.manifest.window.from, to: inp.manifest.window.to },
      caveats: b.caveats,
      sha256: b.sha256,
    });
  }
  // median trade size and price
  {
    const med = columnMap(inp.raw.get("swaps_daily")!, "median_usd");
    const b = bits(["swaps_daily"]);
    const hist = trailingAverage(
      inp.days.map((d) => med.get(d) ?? null),
      30,
    );
    const sent = L.collect(
      () =>
        `The median successful swap averaged ${L.n(F, "/facts/tradeSize/medianFirst30", (x) => `${fmt(x)} USD`)} over the first thirty days and ${L.n(F, "/facts/tradeSize/medianLast30", (x) => `${fmt(x)} USD`)} over the last thirty.`,
    );
    charts.push({
      id: "median-trade-size",
      title: "Median successful swap (USD), thirty-day average",
      kind: "line",
      xKind: "date",
      unit: "USD",
      sentence: sent.text,
      sentenceRefs: sent.refs,
      evidenceAgainst:
        "A median hides the tails: a few very large swaps move volume without moving the median.",
      evidenceAgainstRefs: [],
      x: histX,
      series: [{ name: "median swap (30-day mean)", values: hist.map(dec) }],
      datasetIds: ["swaps_daily"],
      sqlExecuted: b.sqlExecuted,
      sqlBigQuery: b.sqlBigQuery,
      bigQueryExecuted: b.bigQueryExecuted,
      queries: b.queries,
      source: b.source,
      window: { from: histX[0]!, to: T },
      caveats: b.caveats,
      sha256: b.sha256,
    });
    const pb = bits(["near_price_daily"]);
    const psent = L.collect(
      () =>
        `The NEAR daily close went from ${L.n(F, "/facts/price/first", (x) => `${fmt(x)} USD`)} to ${L.n(F, "/facts/price/last", (x) => `${fmt(x)} USD`)} (${L.n(F, "/facts/price/change", (x) => `${fmt(x * 100)}%`)}) over the window.`,
    );
    charts.push({
      id: "near-price",
      title: "NEAR daily close (USD)",
      kind: "line",
      xKind: "date",
      unit: "USD per NEAR",
      sentence: psent.text,
      sentenceRefs: psent.refs,
      evidenceAgainst:
        "Price moved a lot in the same months; USD figures for NEAR burnt hold the price fixed at the last close.",
      evidenceAgainstRefs: [],
      x: histX,
      series: [{ name: "close", values: inp.days.map((d) => dec(price.get(d) ?? null)) }],
      datasetIds: ["near_price_daily"],
      sqlExecuted: pb.sqlExecuted,
      sqlBigQuery: pb.sqlBigQuery,
      bigQueryExecuted: pb.bigQueryExecuted,
      queries: pb.queries,
      source: pb.source,
      window: { from: histX[0]!, to: T },
      caveats: pb.caveats,
      sha256: pb.sha256,
    });
  }

  // ---- grounding scan of everything shown ---------------------------------------------------------------------------------------
  const violations: GroundViolation[] = [];
  const take = (r: { violations: GroundViolation[]; numbersChecked: number }, where: string): void => {
    checked += r.numbersChecked;
    for (const x of r.violations) violations.push({ ...x, text: `${where}: ${x.text}` });
  };
  take(scanGrounding(markdown, L), "THESIS.md");
  for (const c of charts) {
    take(scanSentence(c.sentence, c.sentenceRefs, L), `chart ${c.id} sentence`);
    if (c.evidenceAgainst)
      take(scanSentence(c.evidenceAgainst, c.evidenceAgainstRefs, L), `chart ${c.id} evidenceAgainst`);
  }
  take(scanSentence(headline, headParts.refs, L), "headline");
  if (violations.length)
    throw new ForecastBuildError(`ungrounded numbers: ${violations.length}`, violations.slice(0, 20));
  const valid = validateThesisMarkdown(markdown, "FORECAST");
  if (!valid.ok) throw new ForecastBuildError("THESIS.md failed structural validation", valid.failures);

  // ---- verdict block, tables -----------------------------------------------------------------------------------------------------
  const rowsOut: any[] = [];
  for (const id of order) {
    const s = fcDoc.series[id];
    s.horizons.forEach((h: any, i: number) => {
      rowsOut.push({
        label: `${label(id)}, +${h.horizon} days${h.beyondBacktest ? " (beyond the backtest)" : ""}`,
        value: String(h.central),
        unit: inp.meta.get(id)!.unit,
        band80: [String(h.band80[0]), String(h.band80[1])],
        date: h.date,
        ref: `${F}#${sp(id)}/horizons/${i}/central`,
      });
    });
  }
  rowsOut.push({
    label: "Crossover of Intents transactions above long-tail organic transactions (central date)",
    value: co.centralDate,
    unit: "date",
    band80: co.p10Date && co.p90Date ? [co.p10Date, co.p90Date] : null,
    date: co.centralDate,
    ref: `${F}#/derived/crossover/centralDate`,
  });
  rowsOut.push({
    label: "Probability of that crossover within twelve months",
    value: String(co.within12Months),
    unit: "probability",
    band80: null,
    date: co.twelveMonthsDate,
    ref: `${F}#/derived/crossover/within12Months`,
  });
  const u12 = fcDoc.derived.intents_usd_12m;
  rowsOut.push({
    label: "Settled volume over the next twelve months",
    value: String(u12.centralTotal),
    unit: "USD",
    band80: [String(u12.p10), String(u12.p90)],
    date: co.twelveMonthsDate,
    ref: `${F}#/derived/intents_usd_12m/centralTotal`,
  });
  fcDoc.derived.toll_split.rows.forEach((r: any, i: number) => {
    rowsOut.push({
      label: `Toll per 100 USD settled: ${r.label}`,
      value: String(r.centsPer100Usd.last30),
      unit: "cents per 100 USD",
      band80: null,
      date: T,
      ref: `${F}#/derived/toll_split/rows/${i}/centsPer100Usd/last30`,
    });
  });
  const summary = L.collect(crossText);
  const wouldChange = changeLines.map((c) => `${c.text}${refs(c.refs)}`);
  const forecastBlock = {
    lastDay: T,
    firstForecastDay: futX[0],
    method: fcDoc.method,
    inputHash: fcDoc.inputHash,
    series: order.map((id) => {
      const s = fcDoc.series[id];
      return {
        id,
        label: label(id),
        unit: inp.meta.get(id)!.unit,
        group: s.group,
        transform: s.transform,
        last30: s.last30,
        chosenModel: s.chosenModel,
        skill90: s.skill90,
        calibration: calVal(id),
        verdict: s.verdict,
        againstDirection: s.againstDirection,
        horizons: s.horizons,
        checkpoints: s.checkpoints,
        ref: `${F}#${sp(id)}`,
      };
    }),
    checkpoints: cfgCheckpoints(fcDoc),
    derived: {
      crossover: fcDoc.derived.crossover,
      intents_usd_12m: fcDoc.derived.intents_usd_12m,
      stable_share_threshold: fcDoc.derived.stable_share_threshold,
      intents_burn_near_12m: fcDoc.derived.intents_burn_near_12m ?? null,
      toll_split: fcDoc.derived.toll_split,
      lastClose: fcDoc.derived.lastClose,
    },
    methodFrozenAt: manifest.methodFrozenAt,
    daysOfData: inp.days.length,
    coverage: {
      primaryComplete: ["intents_tx", "tail_tx", "tail_signers"].every(
        (i) => fcDoc.series[i].missingDays.length === 0,
      ),
      allComplete: order.every((i) => fcDoc.series[i].missingDays.length === 0),
      missingDaysBySeries: Object.fromEntries(order.map((i) => [i, fcDoc.series[i].missingDays.length])),
    },
    feesPresent: feesOn,
    feesMissing: inp.fees.missing,
  };
  const hdr = inp.manifest.datasets.find((d) => d.id === "head_accounts_break")!;
  const hdrRaw = inp.raw.get("head_accounts_break")!;
  const headAccounts = {
    columns: hdrRaw.columns.map((c) => c.name),
    rows: hdrRaw.rows,
    definition: hdr.definition,
    ref: "raw/head_accounts_break.json",
  };

  const mdHash = sha(markdown);
  const factsMd = buildFactsMd(L, fcDoc, inp, order);
  const factsHash = sha(factsMd);
  const thesis: Record<string, any> = {
    schema: "nearesis.thesis.v1",
    version,
    generatedAt: manifest.frozenAt,
    title: THESIS_TITLE,
    question: THESIS_QUESTION,
    hypothesis: THESIS_HYPOTHESIS,
    verdict: {
      status: "FORECAST",
      headline,
      intentsVsPrice: {
        summary: summary.text,
        rows: rowsOut.map((r) => ({ label: r.label, value: r.value, unit: r.unit, ref: r.ref })),
      },
      forecast: { rows: rowsOut },
      whatWouldChangeOurMind: wouldChange,
    },
    forecast: forecastBlock,
    headAccounts,
    sections: outSections,
    claims: claimsOut,
    charts,
    tables: [
      ...manifest.datasets.map((d) => ({
        name: d.id,
        system: /bigquery/i.test(d.source)
          ? "BigQuery"
          : /explorer/i.test(d.source)
            ? "Explorer API"
            : "local",
        purpose: d.definition,
        columns: d.columns.map((c) => c.name),
      })),
      ...feeDatasets.map((d) => ({
        name: `fees/${d.id}`,
        system: "local",
        purpose: d.definition,
        columns: d.columns.map((c) => c.name),
      })),
    ],
    sampleQuery: sampleQuery(inp),
    unableToCompute: unable,
    reproduce: {
      command: "pnpm thesis:build",
      check: "pnpm thesis:verify",
      hashes: [
        ...inp.files.map((f) => ({ path: f.where, sha256: f.sha256 })),
        { path: "thesis/build/THESIS.md", sha256: mdHash },
      ],
    },
    files: [],
  };
  const site = renderForecastSite(thesis, factsMd);
  thesis.files = [
    { path: "build/THESIS.md", sha256: mdHash, bytes: Buffer.byteLength(markdown) },
    { path: "build/site/index.html", sha256: sha(site), bytes: Buffer.byteLength(site) },
    { path: "build/FACTS.md", sha256: factsHash, bytes: Buffer.byteLength(factsMd) },
    { path: "raw/forecast.json", sha256: sha(forecastText), bytes: Buffer.byteLength(forecastText) },
  ];
  const json = `${JSON.stringify({ ...thesis, grounding: { numbersChecked: checked, references: L.entries.size } }, null, 2)}\n`;
  const hashes = `${JSON.stringify(
    {
      schema: "nearesis.thesis.hashes.v1",
      version,
      generatedAt: manifest.frozenAt,
      files: [
        ...thesis.files,
        { path: "build/thesis.json", sha256: sha(json), bytes: Buffer.byteLength(json) },
      ],
      inputs: inp.files.map((f) => ({ path: f.where, sha256: f.sha256 })),
    },
    null,
    2,
  )}\n`;
  const files = new Map<string, string>([
    ["THESIS.md", markdown],
    ["FACTS.md", factsMd],
    ["site/index.html", site],
    ["thesis.json", json],
    ["HASHES.json", hashes],
  ]);
  return {
    files,
    extra: new Map([["raw/forecast.json", forecastText]]),
    version,
    thesis,
    numbersChecked: checked,
  };
}

function cfgCheckpoints(fc: Record<string, any>): string[] {
  return fc.method.config.checkpoints as string[];
}

function sampleQuery(inp: ForecastInputs): { title: string; sql: string } {
  if (inp.tablesMd) {
    const lines = inp.tablesMd.split("\n");
    let title = "Sample query";
    for (let i = 0; i < lines.length; i++) {
      const h = /^#{1,6}\s+(.+)$/.exec(lines[i]!);
      if (h) title = h[1]!.trim();
      if (/^```sql\s*$/i.test(lines[i]!)) {
        const body: string[] = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) body.push(lines[i]!);
        return { title, sql: body.join("\n").trim() };
      }
    }
  }
  return { title: "No sample query available", sql: "-- none" };
}

// ------------------------------------------------------------------------------------------------ FACTS.md
function buildFactsMd(L: Ledger, fc: Record<string, any>, inp: ForecastInputs, order: string[]): string {
  const lines: string[] = [
    `# FACTS: every number available to cite`,
    "",
    "Write analysis in thesis/interpretation.md (`## <section-id>` headings). Cite a number as `[file#pointer]` right after it, on the same line. Numbers are checked against the value behind the pointer; write them to three significant digits, in thousands, millions or billions, or as a percent (a share of 0.357 may be written 35.7 percent or 36 percent). Forward-looking words are allowed; causal words are not.",
    "",
    `Last full day ${fc.lastDay}; forecasts are thirty-day averages ending on the stated date; horizons beyond ${fc.method.config.horizons[2]} days are extrapolations the backtest cannot score.`,
    "",
  ];
  const pt = (file: string, pointer: string, meaning: string): void => {
    const val = L.get(file, pointer);
    const shown = typeof val === "number" ? fmt(val) : typeof val === "string" ? val : JSON.stringify(val);
    lines.push(`- \`${file}#${pointer}\` = ${shown}: ${meaning}`);
  };
  const F = "raw/forecast.json";
  const M = "raw/manifest.json";
  const sec = (t: string): void => void lines.push("", `## ${t}`, "");
  for (const id of order) {
    const s = fc.series[id];
    const lab = inp.meta.get(id)!.label;
    sec(`${lab} (${id}; unit: ${inp.meta.get(id)!.unit})`);
    pt(F, `/series/${id}/last30`, `last thirty-day average (${s.last30Window.observedDays} observed days)`);
    lines.push(`- model used: ${s.chosenModel} (${s.chosenReason}); verdict ${s.verdict}`);
    pt(
      F,
      `/series/${id}/skill90`,
      "skill against naive at the longest scored horizon (fraction; 0.1 = ten percent better)",
    );
    pt(
      F,
      `/series/${id}/calibration/pooledLeaveOneOut80`,
      "share of backtest points inside the eighty percent band when each origin is left out (rank-driven, near three quarters by construction)",
    );
    if (s.calibration.pooledForward80 !== null)
      pt(
        F,
        `/series/${id}/calibration/pooledForward80`,
        "share inside the eighty percent band in the time-ordered check that uses only earlier origins (used for the verdict)",
      );
    pt(F, `/series/${id}/calibration/pooledInSample80`, "the same, in sample");
    s.backtest.table.forEach((t: any, i: number) => {
      if (t.model === s.chosenModel || t.model === "naive")
        lines.push(
          `- \`${F}#/series/${id}/backtest/table/${i}/mae\` = ${t.mae === null ? "n/a" : fmt(t.mae)}: error of ${t.model} at ${t.horizon} days over ${t.origins} origins${t.skill !== null ? ` (skill ${fmt(t.skill)})` : ""}`,
        );
    });
    s.horizons.forEach((h: any, i: number) => {
      pt(
        F,
        `/series/${id}/horizons/${i}/central`,
        `forecast at +${h.horizon} days (${h.date})${h.beyondBacktest ? ", extrapolation" : ""}`,
      );
      pt(F, `/series/${id}/horizons/${i}/band80/0`, "eighty percent band, lower");
      pt(F, `/series/${id}/horizons/${i}/band80/1`, "eighty percent band, upper");
      pt(F, `/series/${id}/horizons/${i}/band50/0`, "fifty percent band, lower");
      pt(F, `/series/${id}/horizons/${i}/band50/1`, "fifty percent band, upper");
    });
    s.checkpoints.forEach((c: any, i: number) => {
      pt(F, `/series/${id}/checkpoints/${i}/central`, `checkpoint ${c.date}: forecast`);
      pt(F, `/series/${id}/checkpoints/${i}/band80/0`, `checkpoint ${c.date}: eighty percent lower`);
      pt(F, `/series/${id}/checkpoints/${i}/band80/1`, `checkpoint ${c.date}: eighty percent upper`);
    });
  }
  sec("Derived: crossover of Intents transactions over long-tail organic transactions");
  for (const k of [
    "last30A",
    "last30B",
    "centralHorizon",
    "within6Months",
    "within12Months",
    "aboveAt6Months",
    "aboveAt12Months",
  ]) {
    pt(F, `/derived/crossover/${k}`, k);
  }
  for (const k of ["centralDate", "medianDate", "p10Date", "p90Date"])
    if (fc.derived.crossover[k]) pt(F, `/derived/crossover/${k}`, k);
  lines.push(`- already above at the last day: ${fc.derived.crossover.aboveAtLastDay}`);
  sec("Derived: settled volume over the next twelve months (USD)");
  for (const k of [
    "centralTotal",
    "p10",
    "p25",
    "p50",
    "p75",
    "p90",
    "observedTotalLast365",
    "observedDaysLast365",
    "missingDaysLast365",
  ])
    pt(F, `/derived/intents_usd_12m/${k}`, k);
  pt(
    F,
    "/derived/intents_usd_12m/bandSum80/lo",
    "sum of the eighty percent band path over a year, lower (narrower than the simulated range)",
  );
  pt(F, "/derived/intents_usd_12m/bandSum80/hi", "the same, upper");
  sec("Derived: stable-to-stable share crossing one half");
  for (const k of ["last30", "within6Months", "within12Months"])
    pt(F, `/derived/stable_share_threshold/${k}`, k);
  if (fc.derived.stable_share_threshold.centralDate)
    pt(F, "/derived/stable_share_threshold/centralDate", "central crossing date");
  if (fc.derived.stable_share_threshold.medianDate)
    pt(F, "/derived/stable_share_threshold/medianDate", "median simulated crossing date");
  sec("Derived: NEAR burnt by the Intents contracts (needs the fee inputs) and the toll split");
  if (fc.derived.intents_burn_near_12m) {
    for (const k of ["centralTotal", "p10", "p90"])
      pt(F, `/derived/intents_burn_near_12m/${k}`, `${k} (NEAR)`);
    for (const k of ["central", "p10", "p90"])
      pt(F, `/derived/intents_burn_near_12m/usdAtLastClose/${k}`, `${k} (USD at the fixed last close)`);
  } else
    lines.push("- not computed: the fee inputs do not provide the NEAR burnt by the Intents contracts yet");
  pt(
    F,
    "/derived/lastClose/usdPerNear",
    "last NEAR close used for every USD figure of NEAR burnt (price held fixed, not a forecast)",
  );
  fc.derived.toll_split.rows.forEach((r: any, i: number) => {
    pt(
      F,
      `/derived/toll_split/rows/${i}/centsPer100Usd/last30`,
      `cents per 100 USD settled to: ${r.label} (last thirty days)`,
    );
    pt(F, `/derived/toll_split/rows/${i}/centsPer100Usd/plus365/central`, `the same, forecast in 365 days`);
  });
  if (!fc.derived.toll_split.rows.length)
    lines.push("- not computed: no take-rate or spread series from the fee inputs");
  sec("Break on 2026-04-02 and the head accounts");
  for (const k of Object.keys(fc.facts.break))
    if (typeof fc.facts.break[k] === "number") pt(F, `/facts/break/${k}`, k);
  const hr = inp.raw.get("head_accounts_break")!;
  hr.rows.forEach((r, i) => {
    lines.push(
      `- \`raw/head_accounts_break.json#/rows/${i}\`: ${r[0]}: head days before ${r[1]}, transactions before ${r[2]}, head days after ${r[4]}, transactions after ${r[5]} (pointers /rows/${i}/2 and /rows/${i}/5)`,
    );
  });
  sec("Composition: what moves through Intents (monthly)");
  fc.facts.monthly.forEach((m: any, i: number) => {
    for (const k of [
      "intents_tx",
      "tail_tx",
      "tail_signers",
      "intents_usd",
      "stable_share",
      "no_near_share",
      "near_token_share",
      "median_swap_usd",
    ])
      if (m[k] !== null)
        pt(F, `/facts/monthly/${i}/${k}`, `${m.month}: ${k} (monthly mean per day, or volume share)`);
  });
  sec("May 2026 excursion (near-token leg)");
  for (const k of Object.keys(fc.facts.excursion)) {
    const val = fc.facts.excursion[k];
    if (typeof val === "number" || (typeof val === "string" && k !== "from" && k !== "to"))
      pt(F, `/facts/excursion/${k}`, k);
  }
  sec("Chain pairs (window totals)");
  fc.facts.chainPairs.pairs.forEach((p: any, i: number) => {
    pt(F, `/facts/chainPairs/pairs/${i}/usd`, `${p.pair}: USD over the window`);
    pt(F, `/facts/chainPairs/pairs/${i}/shareOfListed`, `${p.pair}: share of the ten listed pairs`);
  });
  pt(
    F,
    "/facts/chainPairs/shareListedOfWindow",
    "share of all window volume that the ten listed pairs carry",
  );
  sec("Price and trade size");
  for (const k of ["first", "last", "change"]) pt(F, `/facts/price/${k}`, `NEAR close ${k}`);
  for (const k of Object.keys(fc.facts.tradeSize)) pt(F, `/facts/tradeSize/${k}`, k);
  sec("Data checks and cost");
  inp.manifest.crossChecks.forEach((c, i) => {
    pt(
      M,
      `/crossChecks/${i}/daysEqual`,
      `${c.local} against ${c.bigquery}: days equal out of ${c.daysCompared}`,
    );
  });
  inp.manifest.bigQueryQueries.forEach((q, i) => {
    if (q.executed) pt(M, `/bigQueryQueries/${i}/bytesBilled`, `${q.id}: bytes billed`);
  });
  pt(M, "/internalChecks/organicEqualsHeadPlusTail/daysEqual", "days on which organic = head + tail exactly");
  if (inp.fees.present) {
    sec("Fee inputs found");
    for (const id of inp.series.map((s) => s.id).filter((i) => inp.meta.get(i)!.group === "fees"))
      lines.push(`- series ${id} bound from ${inp.meta.get(id)!.from}`);
    for (const m of inp.fees.missing) lines.push(`- missing series ${m.id}: ${m.why}`);
  } else {
    sec("Fee inputs");
    lines.push(
      "- thesis/raw/fees/manifest.json does not exist yet: no toll-booth number is available; rebuild when it appears.",
    );
  }
  void fwd;
  void inv;
  return `${lines.join("\n")}\n`;
}
