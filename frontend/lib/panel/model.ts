import type { CanvasMarker, CanvasPanel, PanelChart, PanelData } from './types';

/**
 * Pure view-model code for panels: no React, no DOM. Everything here is unit
 * tested. The rules it enforces (spec 4.4): a null is a gap and never a zero, a
 * missing period is a gap and never interpolated, a number is never invented.
 */

export type Viz = 'line' | 'area' | 'bar' | 'stacked' | 'pie' | 'scatter' | 'candlestick' | 'heatmap' | 'table' | 'note' | 'unsupported';

const DAY = 86_400_000;

/** Numbers arrive as numbers or as decimal strings (large sums). Anything else is "no value". */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function toTime(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v === '') return null;
  // "2026-07-27" and full ISO strings are both UTC.
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isFinite(t) ? t : null;
}

export function fmtValue(v: unknown, unit?: string | null): string {
  const n = toNum(v);
  if (n === null) return typeof v === 'string' && v !== '' ? v : '—';
  const u = (unit ?? '').toLowerCase();
  if (u === 'ratio') return `${(n * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  if (u === 'usd') return `$${Math.abs(n) >= 10_000 ? n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 }) : n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const s = Math.abs(n) >= 1e6 ? n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 }) : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return u && u !== 'usd' ? `${s} ${unit}` : s;
}

export function fmtTime(ms: number, withTime = false): string {
  const d = new Date(ms);
  const day = d.toISOString().slice(0, 10);
  return withTime ? `${day} ${d.toISOString().slice(11, 16)}Z` : day;
}

/** Short column label: the member part of "cube.member". */
export function colLabel(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1) : name;
}

type Cols = { idx: Map<string, number>; unit: (name: string) => string | null };
function cols(chart: PanelChart): Cols {
  const idx = new Map(chart.columns.map((c, i) => [c.name, i] as const));
  const units = new Map(chart.columns.map((c) => [c.name, c.unit] as const));
  return { idx, unit: (n) => units.get(n) ?? null };
}

function fieldRole(data: PanelData, name: string): 'time' | 'measure' | 'dimension' | undefined {
  return data.shape?.fields.find((f) => f.name === name)?.role;
}

/** Resolved column bindings for a panel: encoding first, then the shape's roles. */
export type Binding = { x: string | null; ys: string[]; series: string | null };
export function bind(panel: Pick<CanvasPanel, 'encoding'>, data: PanelData): Binding {
  const chart = data.chart;
  if (!chart) return { x: null, ys: [], series: null };
  const names = chart.columns.map((c) => c.name);
  const enc = panel.encoding ?? {};
  const has = (n?: string) => (n && names.includes(n) ? n : null);
  const x = has(enc.x) ?? names.find((n) => fieldRole(data, n) === 'time') ?? names.find((n) => fieldRole(data, n) === 'dimension') ?? names[0] ?? null;
  const ys = (enc.y ?? []).filter((n) => names.includes(n));
  const measures = ys.length ? ys : names.filter((n) => n !== x && fieldRole(data, n) === 'measure');
  const series = has(enc.series);
  return { x, ys: measures.filter((n) => n !== series), series };
}

/** Which visualisations make sense for this panel and data. The first is the default. */
export function availableViz(panel: CanvasPanel, data: PanelData | undefined): Viz[] {
  switch (panel.kind) {
    case 'timeSeries':
      return ['line', 'area', 'table'];
    case 'bar': {
      const out: Viz[] = ['bar'];
      if (panel.encoding?.series || (panel.encoding?.y?.length ?? 0) > 1) out.push('stacked');
      const b = data ? bind(panel, data) : null;
      if (b && b.ys.length === 1 && !b.series && data?.chart && data.chart.rows.length <= 12) out.push('pie');
      out.push('table');
      return out;
    }
    case 'scatter':
      return ['scatter', 'table'];
    case 'candlestick':
      return ['candlestick', 'table'];
    case 'heatmap':
    case 'cohort':
      return ['heatmap', 'table'];
    case 'table':
      return ['table'];
    case 'note':
      return ['note'];
    case 'waterfall':
      return ['table'];
    default:
      return ['unsupported'];
  }
}

/** Evenly spaced period length when the data is a regular daily/weekly/hourly series. */
export function stepMs(grain: string | undefined, sortedTimes: number[]): number | null {
  const g = grain?.toLowerCase();
  if (g === 'day') return DAY;
  if (g === 'week') return 7 * DAY;
  if (g === 'hour') return 3_600_000;
  let min = Infinity;
  for (let i = 1; i < sortedTimes.length; i++) {
    const d = sortedTimes[i] - sortedTimes[i - 1];
    if (d > 0 && d < min) min = d;
  }
  return [3_600_000, DAY, 7 * DAY].includes(min) ? min : null;
}

/**
 * A point per period, with null where the source has no row. The renderer draws a
 * null as a break in the line (connectNulls is off), so a missing day is a visible
 * gap and not an interpolated or zero value.
 */
export function fillGaps(points: [number, number | null][], step: number | null, cap = 20_000): { points: [number, number | null][]; inserted: number } {
  if (!step || points.length < 2) return { points, inserted: 0 };
  const out: [number, number | null][] = [];
  let inserted = 0;
  for (let i = 0; i < points.length; i++) {
    out.push(points[i]);
    const next = points[i + 1];
    if (!next) break;
    const missing = Math.round((next[0] - points[i][0]) / step) - 1;
    if (missing > 0 && out.length + missing < cap) {
      for (let k = 1; k <= missing; k++) out.push([points[i][0] + k * step, null]);
      inserted += missing;
    }
  }
  return { points: out, inserted };
}

export type CoverageInfo = {
  /** Periods with no coverage record: unknown, never zero. */
  missing: string[];
  /** Periods whose counts are lower bounds. */
  incomplete: string[];
  state: 'complete' | 'partial' | 'unavailable' | 'unknown';
  note: string | null;
  daysRequested: number | null;
  daysWithData: number | null;
};

/** Normalises the two coverage shapes (analytics: days lists; semantic: per-row flags). */
export function coverageInfo(data: PanelData): CoverageInfo {
  const c = (data.coverage ?? {}) as Record<string, unknown>;
  const chart = data.chart;
  if (Array.isArray(c.rowCoverage)) {
    const b = chart ? chart.columns[0]?.name : undefined;
    const idx = b ? 0 : -1;
    const incomplete: string[] = [];
    (c.rowCoverage as string[]).forEach((s, i) => {
      if (s !== 'complete' && chart && idx >= 0) {
        const t = toTime(chart.rows[i]?.[idx]);
        incomplete.push(t !== null ? fmtTime(t) : String(chart.rows[i]?.[idx] ?? `row ${i + 1}`));
      }
    });
    const nulls = toNum(c.nullCount) ?? 0;
    return {
      missing: [],
      incomplete,
      state: incomplete.length || nulls ? 'partial' : 'complete',
      note: nulls ? `${nulls} null value${nulls === 1 ? '' : 's'} in the result (shown as gaps, never zero).` : null,
      daysRequested: null,
      daysWithData: null,
    };
  }
  const arr = (k: string) => (Array.isArray(c[k]) ? (c[k] as unknown[]).map(String) : []);
  const st = c.state;
  return {
    missing: arr('missingDays'),
    incomplete: arr('incompleteDays'),
    state: st === 'complete' || st === 'partial' || st === 'unavailable' ? st : 'unknown',
    note: typeof c.note === 'string' ? c.note : null,
    daysRequested: toNum(c.daysRequested),
    daysWithData: toNum(c.daysWithData),
  };
}

/** Merge consecutive ISO dates into [from, to] runs, for compact listing and shading. */
export function dateRuns(days: string[]): [string, string][] {
  const t = days.map((d) => [d, toTime(d)] as const).filter((x): x is readonly [string, number] => x[1] !== null).sort((a, b) => a[1] - b[1]);
  const runs: [string, string][] = [];
  let start: (typeof t)[number] | null = null;
  let prev: (typeof t)[number] | null = null;
  for (const cur of t) {
    if (start && prev && cur[1] - prev[1] === DAY) {
      prev = cur;
      continue;
    }
    if (start && prev) runs.push([start[0], prev[0]]);
    start = prev = cur;
  }
  if (start && prev) runs.push([start[0], prev[0]]);
  return runs;
}

export type Truncation = { truncated: boolean; method: string | null; requested: number | null; returned: number; max: number | null; lowerBound: boolean };
export function truncationInfo(data: PanelData): Truncation | null {
  const chart = data.chart;
  if (!chart) return null;
  const t = chart.truncation;
  if (t) {
    return { truncated: true, method: t.method, requested: t.requestedRows, returned: t.returnedRows, max: t.maxRows, lowerBound: !!t.requestedRowsIsLowerBound };
  }
  if (data.state === 'truncated') {
    return { truncated: true, method: 'truncate', requested: null, returned: chart.rows.length, max: chart.rows.length, lowerBound: true };
  }
  if (chart.downsampling.method !== 'none' && chart.downsampling.originalPoints > chart.rows.length) {
    return { truncated: true, method: chart.downsampling.method, requested: chart.downsampling.originalPoints, returned: chart.rows.length, max: null, lowerBound: false };
  }
  return null;
}

/** Sequential blue ramp for heatmaps. The low end follows the theme: a quiet cell sits near the surface. */
function heatColors(ink: string): string[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(ink.trim());
  const inkIsLight = m ? parseInt(m[1].slice(0, 2), 16) > 160 : false;
  return inkIsLight
    ? ['#15243b', '#1d3a63', '#2b5a99', '#4a86c9', '#8fb4e8']
    : ['#eef4fc', '#c3daf2', '#86b3e2', '#4a86c9', '#22508f'];
}

export function truncationLabel(t: Truncation): string {
  const m = t.method === 'lttb' ? 'downsampled (LTTB)' : t.method === 'min_max_bucket' ? 'downsampled (min/max buckets)' : 'cut at the row limit';
  const of = t.requested !== null ? ` of ${t.lowerBound ? 'at least ' : ''}${t.requested.toLocaleString('en-US')}` : '';
  return `Truncated: showing ${t.returned.toLocaleString('en-US')} rows${of}, ${m}.`;
}

export type Certification = 'certified' | 'analytics' | 'exploratory' | 'unknown';
/** The label a panel must carry. Analytics results are never "certified". */
export function certificationOf(panel: Pick<CanvasPanel, 'analytics' | 'queryRef'>, data?: PanelData): Certification {
  if (data?.kind === 'analytics' || panel.analytics || panel.queryRef?.resultKind === 'analytics_result') return 'analytics';
  if (!data?.provenance) return 'unknown';
  // `partial` and `stale` describe the data, not the metric: a certified metric read over partial or
  // stale data is still a certified metric. Only an experimental certification or an uncertified
  // metric status (draft, validated) makes it exploratory.
  if (data.provenance.certification === 'experimental' || data.metricStatus || data.exploratory) return 'exploratory';
  return 'certified';
}

export const CERT_LABEL: Record<Certification, string> = {
  certified: 'Certified metric',
  analytics: 'Analytics result, not a certified metric',
  exploratory: 'Exploratory: metric not certified',
  unknown: 'Provenance unavailable',
};

/** Freshness text for the footer; stale and late data is never presented as current. */
export function freshnessInfo(data: PanelData): { label: string; tone: 'ok' | 'warn' | 'bad'; stale: boolean; detail: string | null } {
  const f = data.freshness;
  const rf = data.rollupFreshness;
  const w = data.chart?.sourceWatermark ?? f.sourceWatermark;
  const lag = rf && rf.state === 'stale' ? `Rollup is ${rf.lagSeconds ?? '?'}s behind the source.` : rf && rf.state === 'unbuilt' ? 'Rollup not built; read from the source.' : null;
  if (data.state === 'stale' || f.state === 'unavailable') return { label: 'Stale', tone: 'warn', stale: true, detail: lag };
  if (f.state === 'late') return { label: 'Late', tone: 'warn', stale: true, detail: lag };
  if (f.state === 'partial') return { label: w ? 'Partial source' : 'Partial', tone: 'warn', stale: false, detail: lag };
  return { label: 'Fresh', tone: 'ok', stale: false, detail: lag };
}

/* -----------------------------------------------------------------------------
   text alternative
   -------------------------------------------------------------------------- */

export function describeChart(panel: CanvasPanel, data: PanelData, viz: Viz): string {
  const chart = data.chart;
  if (!chart) return `${panel.title}. No data: ${data.cannotCompute?.explanation ?? 'unavailable'}.`;
  const b = bind(panel, data);
  const n = chart.rows.length;
  if (n === 0) return `${panel.title}. The query returned no rows.`;
  const parts = [`${panel.title}. ${viz} chart, ${n} row${n === 1 ? '' : 's'}.`];
  const xi = b.x ? chart.columns.findIndex((c) => c.name === b.x) : -1;
  if (xi >= 0 && (viz === 'line' || viz === 'area' || viz === 'bar' || viz === 'stacked')) {
    const xs = chart.rows.map((r) => r[xi]).filter((v) => v !== null && v !== '');
    if (xs.length) parts.push(`From ${String(xs[0]).slice(0, 10)} to ${String(xs[xs.length - 1]).slice(0, 10)}.`);
  }
  for (const y of b.ys.slice(0, 3)) {
    const yi = chart.columns.findIndex((c) => c.name === y);
    const vals = chart.rows.map((r) => toNum(r[yi])).filter((v): v is number => v !== null);
    const nulls = n - vals.length;
    if (vals.length) {
      const unit = chart.columns[yi].unit;
      parts.push(`${colLabel(y)}: minimum ${fmtValue(Math.min(...vals), unit)}, maximum ${fmtValue(Math.max(...vals), unit)}, last ${fmtValue(vals[vals.length - 1], unit)}${nulls ? `, ${nulls} missing` : ''}.`);
    }
  }
  const cov = coverageInfo(data);
  if (cov.missing.length) parts.push(`${cov.missing.length} periods have no coverage record and are unknown.`);
  return parts.join(' ');
}

/* -----------------------------------------------------------------------------
   ECharts options
   -------------------------------------------------------------------------- */

export type ThemeLike = { accent: string; ink: string; text2: string; text3: string; line: string; lineStrong: string; surface: string; warn: string; bad: string; info: string; mono: string; font: string };

type Opt = Record<string, unknown>;

/** 4_532_826 -> "4.53M"; 21000 -> "21k". Short axis labels, as the upstream charts draw them. */
function compact(v: number): string {
  const a = Math.abs(v);
  const f = (n: number, u: string) => `${Number(n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2))}${u}`;
  if (a >= 1e9) return f(v / 1e9, 'B');
  if (a >= 1e6) return f(v / 1e6, 'M');
  if (a >= 1e4) return f(v / 1e3, 'k');
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
}

function timeOf(row: (string | number | null)[], xi: number): number | null {
  return xi >= 0 ? toTime(row[xi]) : null;
}

function markersFor(markers: CanvasMarker[], panelId: string, ys: string[]) {
  const lines: unknown[] = [];
  const areas: unknown[] = [];
  for (const m of markers) {
    if (m.panelId !== panelId) continue;
    const a = m.anchor;
    const name = `marker ${m.markerId.slice(0, 6)} (${m.status.toLowerCase()})`;
    if (a.kind === 'time_point' || a.kind === 'source_event') {
      const t = toTime(a.at);
      if (t !== null) lines.push({ xAxis: t, name, label: { show: false } });
    } else if (a.kind === 'time_range') {
      const s = toTime(a.start);
      const e = toTime(a.end);
      if (s !== null && e !== null) areas.push([{ xAxis: s, name }, { xAxis: e }]);
    } else if (a.kind === 'threshold' && ys.some((y) => y === a.metricId || y.endsWith(`.${a.metricId}`) || a.metricId.endsWith(colLabel(y)))) {
      lines.push({ yAxis: a.value, name: `${a.op === 'gt' ? '>' : '<'} ${a.value}`, label: { show: false } });
    }
  }
  return { lines, areas };
}

export type OptionInput = {
  panel: CanvasPanel;
  data: PanelData;
  viz: Viz;
  theme: ThemeLike;
  markers?: CanvasMarker[];
  /** Restrict the time axis (lens or range selection). ISO strings. */
  window?: { start: string; end: string } | null;
  palette: string[];
  /** Dim the series, e.g. for a panel a lens does not apply to. */
  brush?: boolean;
  /** Draws the range slider under the plot. Off in a canvas card, on in the full panel view. */
  slider?: boolean;
};

export type BuiltChart = { option: Opt; gaps: number; supported: boolean; reason?: string };

/** Build the ECharts option for a panel. Returns supported:false with a reason when the data cannot draw this viz. */
export function buildOption(inp: OptionInput): BuiltChart {
  const { panel, data, viz, theme: t, palette } = inp;
  const chart = data.chart;
  if (!chart) return { option: {}, gaps: 0, supported: false, reason: 'No data was returned.' };
  const c = cols(chart);
  const b = bind(panel, data);
  const xi = b.x ? (c.idx.get(b.x) ?? -1) : -1;
  const si = b.series ? (c.idx.get(b.series) ?? -1) : -1;
  const grain = data.shape?.grain;
  const timeX = !!b.x && (fieldRole(data, b.x) === 'time' || (xi >= 0 && chart.rows.length > 0 && chart.rows.every((r) => r[xi] === null || (typeof r[xi] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r[xi] as string)))));
  const winS = inp.window ? toTime(inp.window.start) : null;
  const winE = inp.window ? toTime(inp.window.end) : null;
  const inWindow = (ms: number | null) => ms === null || ((winS === null || ms >= winS) && (winE === null || ms <= winE));
  const unitFor = (n: string) => c.unit(n);
  const yUnit = b.ys.length ? unitFor(b.ys[0]) : null;

  const base: Opt = {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: t.font, color: t.text2, fontSize: 11 },
    grid: { left: 6, right: 16, top: 24, bottom: timeX && inp.slider ? 50 : 8, containLabel: true },
    tooltip: {
      trigger: viz === 'scatter' || viz === 'heatmap' || viz === 'pie' ? 'item' : 'axis',
      backgroundColor: '#2a2a2a',
      borderWidth: 0,
      confine: true,
      padding: [6, 9],
      textStyle: { color: '#f1efe2', fontFamily: t.font, fontSize: 12 },
    },
    color: palette,
  };
  const axisText = { color: t.text3, fontFamily: t.mono, fontSize: 10, hideOverlap: true };
  const yAxis = (name?: string | null) => ({
    type: panel.encoding?.scale === 'log' ? 'log' : 'value',
    name: name ?? undefined,
    nameTextStyle: { color: t.text3, fontFamily: t.mono, fontSize: 9, align: 'left' },
    nameGap: 8,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: t.line } },
    axisLabel: { ...axisText, hideOverlap: true, formatter: (v: number) => (yUnit === 'ratio' ? fmtValue(v, 'ratio') : compact(v)) },
    scale: false,
  });
  const tipFormatter = (units: Record<string, string | null>) => (params: unknown) => {
    const arr = (Array.isArray(params) ? params : [params]) as { axisValue?: number | string; seriesName?: string; value?: unknown; marker?: string; data?: unknown }[];
    if (!arr.length) return '';
    const head = arr[0].axisValue;
    const label = typeof head === 'number' && timeX ? fmtTime(head, grain === 'hour') : String(head ?? '');
    const lines = arr.map((p) => {
      const raw = Array.isArray(p.value) ? p.value[1] : p.value;
      const u = units[p.seriesName ?? ''] ?? yUnit;
      const v = raw === null || raw === undefined ? 'no data (gap)' : fmtValue(raw, u);
      return `${p.marker ?? ''}${p.seriesName ?? ''}: <b>${v}</b>`;
    });
    return `${label}<br/>${lines.join('<br/>')}`;
  };

  /* ---- time / category series ---------------------------------------- */
  if (viz === 'line' || viz === 'area' || viz === 'bar' || viz === 'stacked') {
    if (xi < 0 || !b.ys.length) return { option: {}, gaps: 0, supported: false, reason: 'The panel binds no x column or no y column that the result contains.' };
    const kindBar = viz === 'bar' || viz === 'stacked';
    const stack = viz === 'stacked';
    const units: Record<string, string | null> = {};
    let totalGaps = 0;
    type Row = (string | number | null)[];
    const groups = new Map<string, Row[]>();
    if (si >= 0) {
      for (const r of chart.rows) {
        const k = String(r[si] ?? '(none)');
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
      }
    } else groups.set('', chart.rows);
    const rowCov = Array.isArray((data.coverage as { rowCoverage?: unknown } | null)?.rowCoverage) ? ((data.coverage as { rowCoverage: string[] }).rowCoverage) : null;
    const partialRows = new Set<Row>();
    if (rowCov) chart.rows.forEach((r, i) => rowCov[i] && rowCov[i] !== 'complete' && partialRows.add(r));
    const { lines, areas } = markersFor(inp.markers ?? [], panel.panelId, b.ys);
    const series: Opt[] = [];
    let categories: string[] | null = null;
    if (timeX) {
      for (const [gk, rows] of groups) {
        for (const y of b.ys) {
          const yi = c.idx.get(y)!;
          const name = gk ? (b.ys.length > 1 ? `${gk} · ${colLabel(y)}` : gk) : colLabel(y);
          units[name] = unitFor(y);
          let pts: [number, number | null][] = rows
            .map((r) => [timeOf(r, xi), toNum(r[yi])] as [number | null, number | null])
            .filter((p): p is [number, number | null] => p[0] !== null && inWindow(p[0]))
            .sort((a, z) => a[0] - z[0]);
          const filled = fillGaps(pts, stepMs(grain, pts.map((p) => p[0])));
          pts = filled.points;
          totalGaps += pts.filter((p) => p[1] === null).length;
          const partialTimes = new Set(rows.filter((r) => partialRows.has(r)).map((r) => timeOf(r, xi)));
          const data_ = pts.map((p) => (partialTimes.has(p[0]) && p[1] !== null ? { value: p, symbol: 'emptyCircle', symbolSize: 8 } : p));
          series.push({
            name,
            type: kindBar ? 'bar' : 'line',
            stack: stack ? 'total' : undefined,
            data: data_,
            showSymbol: !kindBar && groups.size * b.ys.length === 1 && pts.length <= 40,
            symbolSize: 4,
            connectNulls: false,
            areaStyle: viz === 'area' ? { opacity: 0.16 } : !kindBar && groups.size * b.ys.length === 1 ? { opacity: 0.08 } : undefined,
            lineStyle: kindBar ? undefined : { width: 1.75 },
            barMaxWidth: 28,
            emphasis: { focus: 'series' },
          });
        }
      }
      // gaps, incomplete days and markers on the first series
      const cov = coverageInfo(data);
      const gapAreas: unknown[] = [];
      const addRuns = (days: string[], color: string, label: string) => {
        for (const [a, z] of dateRuns(days).slice(0, 80)) {
          const s = toTime(a)!;
          const e = toTime(z)! + (grain === 'week' ? 7 * DAY : DAY);
          if (inWindow(s) || inWindow(e)) gapAreas.push([{ xAxis: s, name: label, itemStyle: { color, borderWidth: 0 } }, { xAxis: e }]);
        }
      };
      addRuns(cov.missing, 'rgba(120,120,110,0.18)', 'no coverage (unknown)');
      addRuns(cov.incomplete, 'rgba(125,82,9,0.14)', 'incomplete (lower bound)');
      for (const g of data.gaps.slice(0, 80)) {
        const s = toTime(g.from);
        const e = toTime(g.to);
        if (s !== null && e !== null && cov.missing.length === 0 && !/NO_COVERAGE/.test(g.reason) && inWindow(s)) gapAreas.push([{ xAxis: s, name: g.reason, itemStyle: { color: 'rgba(156,43,39,0.16)' } }, { xAxis: e === s ? s + DAY / 2 : e }]);
      }
      if (series[0]) {
        const allAreas = [...gapAreas, ...areas];
        series[0].markArea = allAreas.length ? { silent: true, label: { show: false }, emphasis: { disabled: true }, itemStyle: { color: 'rgba(0,236,151,0.12)', borderWidth: 0 }, data: allAreas } : undefined;
        series[0].markLine = lines.length ? { silent: true, symbol: 'none', lineStyle: { color: t.info, type: 'dashed' }, data: lines } : undefined;
      }
    } else {
      // category x: one point per category; series pivot
      const cats: string[] = [];
      const seen = new Set<string>();
      for (const r of chart.rows) {
        const k = String(r[xi] ?? '(none)');
        if (!seen.has(k)) (seen.add(k), cats.push(k));
      }
      categories = cats;
      for (const [gk, rows] of groups) {
        for (const y of b.ys) {
          const yi = c.idx.get(y)!;
          const name = gk ? (b.ys.length > 1 ? `${gk} · ${colLabel(y)}` : gk) : colLabel(y);
          units[name] = unitFor(y);
          const byCat = new Map(rows.map((r) => [String(r[xi] ?? '(none)'), toNum(r[yi])] as const));
          const arr = cats.map((k) => (byCat.has(k) ? byCat.get(k)! : null));
          totalGaps += arr.filter((v) => v === null).length;
          series.push({ name, type: kindBar ? 'bar' : 'line', stack: stack ? 'total' : undefined, data: arr, barMaxWidth: 36, connectNulls: false, emphasis: { focus: 'series' } });
        }
      }
    }
    const multi = series.length > 1;
    return {
      gaps: totalGaps,
      supported: true,
      option: {
        ...base,
        legend: { show: multi && series.length <= 12, top: 0, type: 'scroll', textStyle: { color: t.text2, fontSize: 11 }, icon: 'rect', itemWidth: 9, itemHeight: 9 },
        grid: { ...(base.grid as Opt), top: multi ? 32 : 24 },
        tooltip: { ...(base.tooltip as Opt), formatter: tipFormatter(units), axisPointer: { type: kindBar ? 'shadow' : 'line', lineStyle: { color: t.lineStrong, type: 'dashed' } } },
        xAxis: timeX
          ? { type: 'time', splitNumber: 5, axisLine: { lineStyle: { color: t.lineStrong } }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { ...axisText, formatter: { day: '{d} {MMM}', month: '{MMM}', year: '{yyyy}' } }, min: winS ?? undefined, max: winE ?? undefined }
          : { type: 'category', data: categories, axisLine: { lineStyle: { color: t.lineStrong } }, axisTick: { show: false }, axisLabel: { ...axisText, interval: 'auto', hideOverlap: true, formatter: (v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v) } },
        yAxis: yAxis(yUnit),
        series,
        dataZoom: timeX ? [{ type: 'inside', filterMode: 'none', moveOnMouseMove: !inp.brush, zoomOnMouseWheel: 'ctrl' }, ...(inp.slider ? [{ type: 'slider', height: 14, bottom: 6, filterMode: 'none', borderColor: t.line, textStyle: { color: t.text3, fontSize: 9 } }] : [])] : undefined,
      },
    };
  }

  /* ---- scatter ---------------------------------------------------------- */
  if (viz === 'scatter') {
    const yName = b.ys[0];
    const yi = yName ? (c.idx.get(yName) ?? -1) : -1;
    if (xi < 0 || yi < 0) return { option: {}, gaps: 0, supported: false, reason: 'A scatter needs an x and a y column.' };
    const groups = new Map<string, [number, number][]>();
    for (const r of chart.rows) {
      const x = toNum(r[xi]) ?? timeOf(r, xi);
      const y = toNum(r[yi]);
      if (x === null || y === null) continue; // a missing value is not plotted as zero
      const k = si >= 0 ? String(r[si]) : colLabel(yName);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push([x, y]);
    }
    const isTime = timeX;
    return {
      gaps: chart.rows.length - [...groups.values()].reduce((a, v) => a + v.length, 0),
      supported: true,
      option: {
        ...base,
        legend: { show: groups.size > 1, top: 0, type: 'scroll', textStyle: { color: t.text2, fontSize: 11 } },
        tooltip: { ...(base.tooltip as Opt), formatter: (p: { value: [number, number]; seriesName: string }) => `${p.seriesName}<br/>${colLabel(b.x ?? 'x')}: <b>${isTime ? fmtTime(p.value[0]) : fmtValue(p.value[0], unitFor(b.x ?? ''))}</b><br/>${colLabel(yName)}: <b>${fmtValue(p.value[1], unitFor(yName))}</b>` },
        xAxis: { type: isTime ? 'time' : 'value', name: colLabel(b.x ?? ''), nameLocation: 'middle', nameGap: 26, axisLine: { lineStyle: { color: t.lineStrong } }, splitLine: { show: false }, axisLabel: axisText },
        yAxis: yAxis(unitFor(yName)),
        series: [...groups].map(([name, d]) => ({ name, type: 'scatter', data: d, symbolSize: 7 })),
      },
    };
  }

  /* ---- candlestick ------------------------------------------------------ */
  if (viz === 'candlestick') {
    const find = (re: RegExp, fallback: number) => b.ys.find((n) => re.test(colLabel(n))) ?? b.ys[fallback];
    const o = find(/open/i, 0);
    const cl = find(/close/i, 1);
    const lo = find(/low/i, 2);
    const hi = find(/high/i, 3);
    if (xi < 0 || [o, cl, lo, hi].some((n) => !n || !c.idx.has(n))) return { option: {}, gaps: 0, supported: false, reason: 'A candlestick needs open, close, low and high columns.' };
    const d: [number, number, number, number, number][] = [];
    for (const r of chart.rows) {
      const tm = timeOf(r, xi);
      const vals = [o, cl, lo, hi].map((n) => toNum(r[c.idx.get(n!)!]));
      if (tm === null || vals.some((v) => v === null) || !inWindow(tm)) continue;
      d.push([tm, ...(vals as [number, number, number, number])]);
    }
    return {
      gaps: chart.rows.length - d.length,
      supported: true,
      option: {
        ...base,
        tooltip: { ...(base.tooltip as Opt), trigger: 'axis' },
        xAxis: { type: 'time', axisLine: { lineStyle: { color: t.lineStrong } }, axisLabel: axisText, splitLine: { show: false } },
        yAxis: { ...yAxis(unitFor(cl!)), scale: true },
        series: [{ type: 'candlestick', data: d.map((p) => ({ value: p })), itemStyle: { color: t.accent, color0: t.ink, borderColor: t.accent, borderColor0: t.ink } }],
        dataZoom: [{ type: 'inside', filterMode: 'none' }],
      },
    };
  }

  /* ---- heatmap / cohort -------------------------------------------------- */
  if (viz === 'heatmap') {
    const vName = b.ys[0];
    const vi = vName ? (c.idx.get(vName) ?? -1) : -1;
    const ri = si >= 0 ? si : chart.columns.findIndex((col, i) => i !== xi && fieldRole(data, col.name) === 'dimension');
    if (xi < 0 || ri < 0 || vi < 0) return { option: {}, gaps: 0, supported: false, reason: 'A heatmap needs an x column, a row column and a value column.' };
    const xs: string[] = [];
    const ys: string[] = [];
    const xSeen = new Set<string>();
    const ySeen = new Set<string>();
    for (const r of chart.rows) {
      const xk = String(r[xi]);
      const yk = String(r[ri]);
      if (!xSeen.has(xk)) (xSeen.add(xk), xs.push(xk));
      if (!ySeen.has(yk)) (ySeen.add(yk), ys.push(yk));
    }
    const cells: [number, number, number][] = [];
    let max = 0;
    for (const r of chart.rows) {
      const v = toNum(r[vi]);
      if (v === null) continue; // empty cell stays empty, never 0
      cells.push([xs.indexOf(String(r[xi])), ys.indexOf(String(r[ri])), v]);
      max = Math.max(max, v);
    }
    const unit = unitFor(vName);
    return {
      gaps: chart.rows.length - cells.length,
      supported: true,
      option: {
        ...base,
        grid: { left: 80, right: 24, top: 12, bottom: 56, containLabel: true },
        tooltip: { ...(base.tooltip as Opt), formatter: (p: { value: [number, number, number] }) => `${colLabel(chart.columns[ri].name)} ${ys[p.value[1]]}<br/>${colLabel(chart.columns[xi].name)} ${xs[p.value[0]]}<br/><b>${fmtValue(p.value[2], unit)}</b>` },
        xAxis: { type: 'category', data: xs, splitArea: { show: false }, axisLabel: { ...axisText, hideOverlap: true }, name: colLabel(chart.columns[xi].name), nameLocation: 'middle', nameGap: 26 },
        yAxis: { type: 'category', data: ys, inverse: true, axisLabel: { ...axisText, hideOverlap: true } },
        visualMap: { min: 0, max: unit === 'ratio' ? 1 : max || 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 90, textStyle: { color: t.text3, fontSize: 10 }, inRange: { color: heatColors(t.ink) }, formatter: (v: number) => fmtValue(v, unit) },
        series: [{ type: 'heatmap', data: cells, emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } } }],
      },
    };
  }

  /* ---- pie --------------------------------------------------------------- */
  if (viz === 'pie') {
    const yi = b.ys[0] ? (c.idx.get(b.ys[0]) ?? -1) : -1;
    if (xi < 0 || yi < 0) return { option: {}, gaps: 0, supported: false, reason: 'A pie needs one category column and one value column.' };
    const d: { name: string; value: number }[] = [];
    for (const r of chart.rows) {
      const v = toNum(r[yi]);
      if (v !== null && v > 0) d.push({ name: String(r[xi]), value: v });
    }
    return {
      gaps: chart.rows.length - d.length,
      supported: true,
      option: {
        ...base,
        tooltip: { ...(base.tooltip as Opt), formatter: (p: { name: string; value: number; percent: number }) => `${p.name}<br/><b>${fmtValue(p.value, unitFor(b.ys[0]))}</b> (${p.percent}%)` },
        legend: { show: true, type: 'scroll', bottom: 0, textStyle: { color: t.text2, fontSize: 11 } },
        series: [{ type: 'pie', radius: ['38%', '68%'], center: ['50%', '46%'], data: d, label: { show: false }, itemStyle: { borderColor: t.surface, borderWidth: 2 } }],
      },
    };
  }

  return { option: {}, gaps: 0, supported: false, reason: `No chart renderer for ${viz}.` };
}

/** The x-range of a result as ISO strings, for the range-selection form. */
export function timeExtent(panel: CanvasPanel, data: PanelData): { start: number; end: number } | null {
  const chart = data.chart;
  if (!chart) return null;
  const b = bind(panel, data);
  const xi = b.x ? chart.columns.findIndex((c) => c.name === b.x) : -1;
  if (xi < 0) return null;
  const ts = chart.rows.map((r) => toTime(r[xi])).filter((v): v is number => v !== null);
  if (!ts.length) return null;
  return { start: Math.min(...ts), end: Math.max(...ts) };
}
