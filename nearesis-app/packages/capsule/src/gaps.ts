import { sha256Hex } from "./canonical.ts";

/**
 * Publication of gaps (V14). Gaps are DETECTED from the data, never declared by the caller:
 *  - missing_day: a calendar day inside the window with no row in a series
 *  - missing_price: a day on which a price is needed but absent
 *  - private_settlement: activity after the date a series stopped being publicly observable
 *  - uncomputable_metric: a metric that cannot be computed (undefined, e.g. a constant series)
 * Each gap needs an entry in LIMITATIONS.md and a status on its panel. A gap is never zero-filled or interpolated.
 */
export type GapType = "missing_day" | "missing_price" | "private_settlement" | "uncomputable_metric";
export type PanelStatus = "ok" | "partial" | "not_observable" | "not_computable";

export interface GapFixture {
  schema: "nearesis.publish-gaps-fixture.v1";
  snapshotId: string;
  label: string;
  window: { from: string; to: string };
  series: Record<
    string,
    {
      unit: string;
      source: string;
      points: Array<[string, string | null]>;
      privateSettlementSince?: string;
      privateCounts?: Array<[string, string | null]>;
    }
  >;
  metrics: Array<{
    id: string;
    panel: string;
    kind: string;
    series?: string;
    price?: string;
    x?: string;
    y?: string;
  }>;
}

export interface Gap {
  type: GapType;
  /** Stable tag that LIMITATIONS.md must contain. */
  tag: string;
  subject: string;
  dates: string[];
  effect: string;
}
export interface PanelState {
  panelId: string;
  metricId: string;
  status: PanelStatus;
  value: string | null;
  note: string;
  gapTags: string[];
}
export interface GapAnalysis {
  gaps: Gap[];
  panels: PanelState[];
  /** Output series: missing days stay absent (never zero), values are copied unchanged. */
  series: Record<string, Array<[string, string]>>;
  publicCounts: { intentsPublicTotal: string };
}

const addDays = (d: string, n: number): string => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const daysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};
const mean = (xs: bigint[]): string => {
  if (xs.length === 0) return "";
  const sum = xs.reduce((a, b) => a + b, 0n);
  const n = BigInt(xs.length);
  const q = (sum * 100n) / n; // two decimals, truncation toward zero for non-negative integers
  return `${q / 100n}.${String(q % 100n).padStart(2, "0")}`;
};

export function analyzeGaps(fx: GapFixture): GapAnalysis {
  const all = daysBetween(fx.window.from, fx.window.to);
  const gaps: Gap[] = [];
  const series: GapAnalysis["series"] = {};
  const present = new Map<string, Map<string, string>>();
  for (const [name, s] of Object.entries(fx.series)) {
    const m = new Map<string, string>();
    for (const [d, v] of s.points) if (v !== null) m.set(d, v);
    present.set(name, m);
    series[name] = [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
    const missing = all.filter(
      (d) => !m.has(d) && !(s.privateSettlementSince && d >= s.privateSettlementSince),
    );
    if (missing.length > 0 && name !== "priceUsd")
      gaps.push({
        type: "missing_day",
        tag: `[gap:missing_day:${name}]`,
        subject: name,
        dates: missing,
        effect: `${s.source} has no row for ${missing.join(", ")}; those days are absent from the series (not zero, not interpolated), so statistics use ${m.size} of ${all.length} days`,
      });
    if (name === "priceUsd" && missing.length > 0)
      gaps.push({
        type: "missing_price",
        tag: `[gap:missing_price:${name}]`,
        subject: name,
        dates: missing,
        effect: `no price for ${missing.join(", ")}; USD-denominated values for those days are not computed (not zero, not carried forward)`,
      });
    if (s.privateSettlementSince) {
      const dates = all.filter((d) => d >= s.privateSettlementSince!);
      gaps.push({
        type: "private_settlement",
        tag: `[gap:private_settlement:${name}]`,
        subject: name,
        dates,
        effect: `settlement activity from ${s.privateSettlementSince} is private and not observable: it is labelled not_observable and is not included in any public-observable count`,
      });
    }
  }

  const panels: PanelState[] = [];
  const price = present.get("priceUsd") ?? new Map<string, string>();
  for (const mt of fx.metrics) {
    const tagsFor = (subject: string, types: GapType[]) =>
      gaps.filter((g) => g.subject === subject && types.includes(g.type)).map((g) => g.tag);
    if (mt.kind === "mean" && mt.series) {
      const m = present.get(mt.series)!;
      const tags = tagsFor(mt.series, ["missing_day"]);
      panels.push({
        panelId: mt.panel,
        metricId: mt.id,
        status: tags.length ? "partial" : "ok",
        value: mean([...m.values()].map(BigInt)),
        note: tags.length ? `computed over ${m.size} of ${all.length} days` : `computed over ${m.size} days`,
        gapTags: tags,
      });
    } else if (mt.kind === "mean_with_price" && mt.series) {
      const m = present.get(mt.series)!;
      const usable = [...m.entries()].filter(([d]) => price.has(d));
      const tags = [
        ...tagsFor(mt.series, ["missing_day"]),
        ...tagsFor(mt.price ?? "priceUsd", ["missing_price"]),
      ];
      panels.push({
        panelId: mt.panel,
        metricId: mt.id,
        status: tags.length ? "partial" : "ok",
        value: mean(usable.map(([d, v]) => BigInt(v) * BigInt(price.get(d)!))),
        note: `USD value computed over ${usable.length} of ${all.length} days that have both a count and a price`,
        gapTags: tags,
      });
    } else if (mt.kind === "private_share" && mt.series) {
      const tags = tagsFor(mt.series, ["private_settlement"]);
      panels.push({
        panelId: mt.panel,
        metricId: mt.id,
        status: "not_observable",
        value: null,
        note: "private settlement activity after the cutoff is not observable on public data",
        gapTags: tags,
      });
    } else if (mt.kind === "pearson" && mt.x && mt.y) {
      const xs = present.get(mt.x)!;
      const ys = present.get(mt.y)!;
      const common = [...xs.keys()].filter((d) => ys.has(d));
      const yVals = new Set(common.map((d) => ys.get(d)));
      const xVals = new Set(common.map((d) => xs.get(d)));
      const uncomputable = common.length < 3 || yVals.size < 2 || xVals.size < 2;
      if (uncomputable) {
        const reason =
          yVals.size < 2
            ? `${mt.y} is constant`
            : xVals.size < 2
              ? `${mt.x} is constant`
              : "fewer than 3 common days";
        const gap: Gap = {
          type: "uncomputable_metric",
          tag: `[gap:uncomputable_metric:${mt.id}]`,
          subject: mt.id,
          dates: [],
          effect: `${mt.id} cannot be computed (${reason}); the panel shows its status and no number`,
        };
        gaps.push(gap);
        panels.push({
          panelId: mt.panel,
          metricId: mt.id,
          status: "not_computable",
          value: null,
          note: reason,
          gapTags: [gap.tag],
        });
      } else
        panels.push({
          panelId: mt.panel,
          metricId: mt.id,
          status: "ok",
          value: "computed",
          note: "",
          gapTags: [],
        });
    }
  }

  const pub =
    fx.series.intentsDaily?.points.filter(([, v]) => v !== null).reduce((a, [, v]) => a + BigInt(v!), 0n) ??
    0n;
  return { gaps, panels, series, publicCounts: { intentsPublicTotal: pub.toString() } };
}

/** One entry per gap, each carrying its tag, the dates or metric, and the effect. */
export function renderLimitations(a: GapAnalysis, opts: { omit?: GapType[] } = {}): string {
  const lines = a.gaps
    .filter((g) => !(opts.omit ?? []).includes(g.type))
    .map(
      (g) =>
        `- ${g.tag} ${g.type.replace(/_/g, " ")}: ${g.dates.length ? `dates ${g.dates[0]}${g.dates.length > 1 ? ` to ${g.dates[g.dates.length - 1]}` : ""}; ` : ""}${g.effect}.`,
    );
  return `# Limitations\n\n${lines.join("\n")}\n`;
}

export class GapPublicationBlockedError extends Error {
  constructor(readonly missing: string[]) {
    super(`publication blocked: LIMITATIONS.md has no entry for ${missing.join(", ")}`);
  }
}

/** Publication check: every detected gap must have its entry in the limitations text and its status on its panel. */
export function checkGapPublication(
  a: GapAnalysis,
  limitationsMd: string,
): { ok: boolean; missing: string[] } {
  const missing = a.gaps.filter((g) => !limitationsMd.includes(g.tag)).map((g) => g.tag);
  const panelMissing = a.panels
    .filter((p) => p.gapTags.length > 0 && p.status === "ok")
    .map((p) => `panel:${p.panelId}`);
  return { ok: missing.length === 0 && panelMissing.length === 0, missing: [...missing, ...panelMissing] };
}

export function publishWithGaps(
  fx: GapFixture,
  limitationsMd?: string,
): { analysis: GapAnalysis; limitationsMd: string; hash: string } {
  const analysis = analyzeGaps(fx);
  const text = limitationsMd ?? renderLimitations(analysis);
  const c = checkGapPublication(analysis, text);
  if (!c.ok) throw new GapPublicationBlockedError(c.missing);
  return { analysis, limitationsMd: text, hash: sha256Hex(text) };
}
