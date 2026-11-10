/**
 * C17 — Chart semantic violation corpus (fx.canvas.semantic-violations, SYNTHETIC).
 * (a)-(c) run the real compiler in packages/canvas-schema; (d) renders the gap case in the production web build.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { observe } from "@nearesis/acceptance";
import type { MetricMetadata } from "@nearesis/contracts";
import {
  compileVisualization,
  hashCanonical,
  type QueryResultShape,
  type VizRequest,
} from "@nearesis/canvas-schema";
import { launch, openPage, startWeb, stopWeb, WEB_DIR } from "./harness.ts";

const meta = (id: string, member: string, over: Partial<MetricMetadata>): MetricMetadata => ({
  id,
  displayName: id,
  kind: "count",
  unit: "count",
  grain: "day",
  aggregationLaw: "sum",
  denominator: null,
  zeroPolicy: "zero_requires_complete_coverage",
  sources: ["near-explorer"],
  transformations: [],
  expectedUpdateLag: "P1D",
  botProxyDefinition: null,
  visibility: "public",
  segmentOverlap: "n/a",
  certifiedVersion: "1.0.0",
  certified: true,
  owner: "engine-b",
  docUri: "docs/metrics/METRICS.md",
  testFixture: "fx.canvas.semantic-violations",
  uncertainty: "synthetic",
  cubeMember: member,
  ...over,
});
const CATALOG: MetricMetadata[] = [
  meta("intents.oneclick_completed_swap_count", "intents.swap_count", {}),
  meta("intents.oneclick_volume_usd", "intents.volume_usd", { unit: "usd", kind: "flow" }),
  meta("near.distinct_signer_proxy", "near_usage.distinct_signer_proxy", {
    unit: "signers",
    aggregationLaw: "non_additive",
    sources: ["near-bigquery"],
  }),
  meta("near.period_unique_signers", "near_usage.period_unique_signers", {
    unit: "signers",
    aggregationLaw: "count_distinct",
    grain: "week",
    sources: ["near-bigquery"],
  }),
  meta("intents.route_quote_cost_bps", "quotes.cost_bps", {
    unit: "bps",
    kind: "rate",
    aggregationLaw: "avg",
    sources: ["intents-1click"],
  }),
  meta("near.contract_interactions_by_taxonomy", "taxonomy.interactions", {
    segmentOverlap: "overlapping",
    sources: ["near-bigquery"],
  }),
  meta("near.verified_interaction_count", "taxonomy.verified_interactions", {
    segmentOverlap: "disjoint",
    sources: ["near-bigquery"],
  }),
];

const day = { name: "t.day", unit: null, role: "time" as const, timeSemantics: "event_time" as const };
const shape = (
  fields: QueryResultShape["fields"],
  grain: QueryResultShape["grain"] = "day",
): QueryResultShape => ({ queryHash: "a".repeat(64), grain, fields });
const m = (name: string, unit: string) => ({ name, unit, role: "measure" as const, metricId: name });
const req = (o: Partial<VizRequest> & Pick<VizRequest, "mark" | "result">): VizRequest => ({
  panelId: "00000000-0000-4000-8000-000000000001",
  title: "case",
  query: { hash: "a".repeat(64), semanticVersion: "1.0.0", grain: o.result.grain ?? "day" },
  completeness: "complete",
  layout: { x: 0, y: 0, w: 6, h: 4 },
  ...o,
});

const taxonomy = shape([
  { name: "taxonomy.segment", unit: null, role: "dimension" },
  m("taxonomy.interactions", "count"),
]);
const verified = shape([
  { name: "taxonomy.segment", unit: null, role: "dimension" },
  m("taxonomy.verified_interactions", "count"),
]);
const dual = shape([day, m("intents.swap_count", "count"), m("intents.volume_usd", "usd")]);
const quoteSettle = shape([
  { name: "quotes.settled_at", unit: null, role: "time", timeSemantics: "settlement_time" },
  m("quotes.cost_bps", "bps"),
]);
const quoteFetched = shape([
  { name: "quotes.fetched_at", unit: null, role: "time", timeSemantics: "fetched_at" },
  m("quotes.cost_bps", "bps"),
]);
const signersWeek = shape([day, m("near_usage.distinct_signer_proxy", "signers")], "week");
const uniquesWeek = shape([day, m("near_usage.period_unique_signers", "signers")], "week");
const swaps = shape([day, m("intents.swap_count", "count")]);

const CASES: Array<{
  rule: string;
  violation: VizRequest;
  valid: VizRequest;
  expect: string | { transform: string };
}> = [
  {
    rule: "pie over overlapping segments",
    violation: req({
      mark: "pie",
      result: taxonomy,
      x: "taxonomy.segment",
      y: ["taxonomy.interactions"],
      share: { denominator: "all_interactions", categoryPolicy: "overlapping" },
    }),
    valid: req({
      mark: "pie",
      result: verified,
      x: "taxonomy.segment",
      y: ["taxonomy.verified_interactions"],
      share: { denominator: "all_verified_interactions", categoryPolicy: "disjoint" },
    }),
    expect: "SHARE_OVERLAPPING_SEGMENTS",
  },
  {
    rule: "share bar without denominator",
    violation: req({
      mark: "bar",
      result: verified,
      x: "taxonomy.segment",
      y: ["taxonomy.verified_interactions"],
      share: { denominator: null, categoryPolicy: "disjoint" },
    }),
    valid: req({
      mark: "bar",
      result: verified,
      x: "taxonomy.segment",
      y: ["taxonomy.verified_interactions"],
      share: { denominator: "all_verified_interactions", categoryPolicy: "disjoint" },
    }),
    expect: "SHARE_DENOMINATOR_MISSING",
  },
  {
    rule: "dual axis USD vs count without disclosure",
    violation: req({
      mark: "line",
      result: dual,
      x: "t.day",
      y: ["intents.swap_count", "intents.volume_usd"],
      unitStrategy: "dual_axis",
    }),
    valid: req({
      mark: "line",
      result: dual,
      x: "t.day",
      y: ["intents.swap_count", "intents.volume_usd"],
      unitStrategy: "dual_axis_disclosed",
    }),
    expect: { transform: "dual_axis_disclosure" },
  },
  {
    rule: "quote series on settlement time",
    violation: req({ mark: "line", result: quoteSettle, x: "quotes.settled_at", y: ["quotes.cost_bps"] }),
    valid: req({ mark: "line", result: quoteFetched, x: "quotes.fetched_at", y: ["quotes.cost_bps"] }),
    expect: "QUOTE_TIME_AXIS",
  },
  {
    rule: "weekly sum of daily distinct signers",
    violation: req({
      mark: "bar",
      result: signersWeek,
      x: "t.day",
      y: ["near_usage.distinct_signer_proxy"],
      aggregation: "sum",
    }),
    valid: req({ mark: "bar", result: uniquesWeek, x: "t.day", y: ["near_usage.period_unique_signers"] }),
    expect: "PERIOD_UNIQUE_SUM_REFUSED",
  },
  {
    rule: "log axis with zero",
    violation: req({
      mark: "line",
      result: swaps,
      x: "t.day",
      y: ["intents.swap_count"],
      scale: "log",
      stats: { min: { "intents.swap_count": 0 }, hasGaps: false },
    }),
    valid: req({
      mark: "line",
      result: swaps,
      x: "t.day",
      y: ["intents.swap_count"],
      scale: "log",
      stats: { min: { "intents.swap_count": 3 }, hasGaps: false },
    }),
    expect: "LOG_AXIS_NONPOSITIVE",
  },
  {
    rule: "interpolation across gap day",
    violation: req({
      mark: "line",
      result: swaps,
      x: "t.day",
      y: ["intents.swap_count"],
      interpolateGaps: true,
      stats: { min: { "intents.swap_count": 1 }, hasGaps: true },
    }),
    valid: req({
      mark: "line",
      result: swaps,
      x: "t.day",
      y: ["intents.swap_count"],
      interpolateGaps: false,
      stats: { min: { "intents.swap_count": 1 }, hasGaps: true },
    }),
    expect: "GAP_INTERPOLATION_REFUSED",
  },
];

let browser: Browser;
beforeAll(async () => {
  await startWeb();
  browser = await launch();
}, 300_000);
afterAll(async () => {
  await browser?.close();
  await stopWeb();
});

describe("C17 chart semantic validation", () => {
  it("refuses or explicitly transforms every violation; valid counterparts compile; gaps render as breaks", async () => {
    const table = CASES.map((c) => {
      const v = compileVisualization(c.violation, CATALOG);
      const ok = compileVisualization(c.valid, CATALOG);
      const violationCodes = v.ok ? [] : v.issues.map((i) => i.code);
      const transforms = v.ok ? v.value.viz.transforms : [];
      const suggestion = v.ok ? null : (v.issues.find((i) => i.suggestion)?.suggestion ?? null);
      return {
        rule: c.rule,
        expect: c.expect,
        violationCompiled: v.ok,
        violationCodes,
        transforms,
        suggestion,
        validCompiled: ok.ok,
        validIssues: ok.ok ? [] : ok.issues.map((i) => i.code),
      };
    });
    for (const [i, row] of table.entries()) {
      const exp = CASES[i]!.expect;
      if (typeof exp === "string") {
        expect(row.violationCompiled, row.rule).toBe(false);
        expect(row.violationCodes, row.rule).toContain(exp);
      } else {
        // (a) allowed explicit transform: compiled only with the declared, visible label
        expect(row.violationCompiled, row.rule).toBe(true);
        expect(
          row.transforms.map((t) => t.kind),
          row.rule,
        ).toContain(exp.transform);
        expect(
          row.transforms.every((t) => t.label.length > 10),
          row.rule,
        ).toBe(true);
      }
      expect(row.validCompiled, `${row.rule} valid counterpart: ${row.validIssues.join(",")}`).toBe(true);
    }
    // (b) the weekly-sum case suggests period_unique_signers
    expect(table[4]!.suggestion).toBe("near.period_unique_signers");

    // (d) render the gap case in the browser.
    const w = await openPage(browser, "/w/fixture?scenario=gaps");
    await w.page.waitForTimeout(800);
    const gap = await w.page.evaluate(() => {
      const charts = (
        window as unknown as {
          __nearesis: { charts: Record<string, { getOption: () => Record<string, unknown> }> };
        }
      ).__nearesis.charts;
      const opt = Object.values(charts)[0]!.getOption() as {
        series: Array<{
          connectNulls?: boolean;
          data: Array<[number, number | null]>;
          markArea?: { data: Array<Array<{ name?: string; xAxis?: number }>> };
        }>;
      };
      const s = opt.series[0]!;
      const gapPoint = s.data.find((p) => new Date(p[0]).toISOString().startsWith("2026-10-15"));
      const shaded = (s.markArea?.data ?? []).filter((a) => String(a[0]?.name ?? "").startsWith("missing"));
      return {
        connectNulls: s.connectNulls ?? false,
        gapValue: gapPoint ? gapPoint[1] : "absent",
        shadedAreas: shaded.map((a) => [
          new Date(a[0]!.xAxis!).toISOString(),
          new Date(a[1]!.xAxis!).toISOString(),
        ]),
        gapLabel: document.querySelector("[data-testid='gap-label']")?.textContent ?? null,
      };
    });
    const shotPath = `${WEB_DIR}test-results/C17-gap.png`;
    await w.page.locator("[data-panel-kind='timeSeries']").first().screenshot({ path: shotPath });
    expect(gap.connectNulls).toBe(false);
    expect(gap.gapValue).toBeNull();
    expect(gap.shadedAreas).toEqual([["2026-10-15T00:00:00.000Z", "2026-10-16T00:00:00.000Z"]]);
    expect(gap.gapLabel).toMatch(/not interpolated/);
    expect(await w.cspViolations()).toEqual([]);
    await w.page.close();

    observe({
      testId: "C17",
      observed: `7/7 violations handled: 6 refused with rule codes (SHARE_OVERLAPPING_SEGMENTS, SHARE_DENOMINATOR_MISSING, QUOTE_TIME_AXIS, PERIOD_UNIQUE_SUM_REFUSED -> suggests near.period_unique_signers, LOG_AXIS_NONPOSITIVE, GAP_INTERPOLATION_REFUSED), undisclosed dual axis compiled only with explicit dual_axis_disclosure label; 7/7 valid counterparts compile; rendered gap day 2026-10-15 is null with connectNulls=false and a shaded missing area (not a connected line)`,
      fixtureHash: hashCanonical({ CASES, CATALOG }),
      evidence: {
        table,
        gapRender: gap,
        screenshot: "apps/web/test-results/C17-gap.png (local, not committed)",
      },
    });
  }, 180_000);
});
