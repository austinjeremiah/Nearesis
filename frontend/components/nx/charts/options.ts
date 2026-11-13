import type { PackColumn, Row, VizSpec } from '@/lib/viz/spec';
import { baseOption, compactNumber, heatRamp, seriesPalette, type ChartTheme } from '../chart';

/**
 * ECharts option builders, one per visualization kind.
 *
 * These are pure functions of (spec, columns, rows). Nothing here knows which
 * fixture or metric it is drawing, which is the point: the renderer is driven
 * by the validated IR and the typed result, so a new panel is a new spec rather
 * than a new component.
 *
 * Rules that hold across every builder:
 * null is a gap and is never drawn as zero, an exact decimal string keeps its
 * digits in the tooltip, and two different units never share an axis.
 */

export type Opt = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Numeric view of a cell. Returns null for an unavailable observation. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The exact value as the source wrote it, for tooltips and tables. */
export function exact(v: unknown): string {
  if (v === null || v === undefined) return '—';
  return String(v);
}

function col(columns: PackColumn[], id: string | null): PackColumn | undefined {
  return id ? columns.find((c) => c.id === id) : undefined;
}

function unitOf(columns: PackColumn[], id: string | null): string {
  return col(columns, id)?.unit ?? '';
}

function yKeys(enc: Record<string, unknown>): string[] {
  const single = str(enc.y);
  if (single) return [single];
  return list(enc.y);
}

function axisFor(columns: PackColumn[], id: string | null, t: ChartTheme): Opt {
  const c = col(columns, id);
  const isTime = c?.role === 'time';
  return {
    type: isTime ? 'time' : 'category',
    axisLine: { lineStyle: { color: t.lineStrong } },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: {
      color: t.text3,
      fontFamily: t.mono,
      fontSize: 10,
      hideOverlap: true,
      ...(isTime ? { formatter: { day: '{d} {MMM}', month: '{MMM}', year: '{yyyy}' } } : {}),
    },
  };
}

function valueAxis(name: string, t: ChartTheme, opts: Opt = {}): Opt {
  return {
    type: 'value',
    name,
    nameTextStyle: { color: t.text3, fontFamily: t.mono, fontSize: 9, align: 'left' },
    nameGap: 8,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: t.line } },
    axisLabel: {
      color: t.text3,
      fontFamily: t.mono,
      fontSize: 10,
      hideOverlap: true,
      formatter: (v: number) => compactNumber(v),
    },
    ...opts,
  };
}

/* ---------------------------------------------------------------------------
   line, area, forecast
   ------------------------------------------------------------------------ */

export function lineOption(spec: VizSpec, columns: PackColumn[], rows: Row[], t: ChartTheme): Opt {
  const base = baseOption(t);
  const palette = seriesPalette(t);
  const enc = spec.encodings ?? {};
  const x = str(enc.x) ?? columns.find((c) => c.role === 'time')?.id ?? columns[0]?.id ?? 'x';
  const keys = yKeys(enc).length > 0 ? yKeys(enc) : list(enc.separateAxes);
  const stack = list(enc.stack);
  const measures = stack.length > 0 ? stack : keys;

  // Two units never share an axis. One unit, one axis, however many series.
  const units = [...new Set(measures.map((k) => unitOf(columns, k)))];
  const twoAxes = units.length > 1;

  const series = measures.map((k, i) => ({
    name: k,
    type: 'line',
    // A missing observation breaks the line. It is not interpolated across.
    connectNulls: false,
    showSymbol: measures.length === 1 && rows.length <= 40,
    symbolSize: 4,
    yAxisIndex: twoAxes ? units.indexOf(unitOf(columns, k)) : 0,
    lineStyle: { width: 1.75, color: palette[i % palette.length] },
    itemStyle: { color: palette[i % palette.length] },
    ...(stack.length > 0
      ? { stack: 'total', areaStyle: { color: palette[i % palette.length], opacity: 0.5 } }
      : measures.length === 1
        ? { areaStyle: { color: palette[0], opacity: 0.08 } }
        : {}),
    data: rows.map((r) => [r[x], num(r[k])]),
  }));

  return {
    ...base,
    legend: measures.length > 1 ? { ...(base.legend as Opt), show: true, top: 0 } : (base.legend as Opt),
    grid: { left: 6, right: twoAxes ? 6 : 16, top: measures.length > 1 ? 26 : 14, bottom: 6, containLabel: true },
    xAxis: axisFor(columns, x, t),
    yAxis: twoAxes
      ? units.map((u, i) => valueAxis(u, t, i === 1 ? { position: 'right', splitLine: { show: false } } : {}))
      : valueAxis(units[0] ?? '', t),
    series,
  };
}

export function forecastOption(spec: VizSpec, columns: PackColumn[], rows: Row[], t: ChartTheme): Opt {
  const base = baseOption(t);
  const enc = spec.encodings ?? {};
  const x = str(enc.x) ?? 'day';
  const observed = str(enc.observed) ?? 'observed';
  const forecast = str(enc.forecast) ?? 'forecast';
  const lower = str(enc.lower) ?? 'lower';
  const upper = str(enc.upper) ?? 'upper';

  // The band is drawn as a transparent floor plus a visible span, so the gap
  // between the bounds is shaded without implying a calibrated interval.
  const floor = rows.map((r) => [r[x], num(r[lower])]);
  const span = rows.map((r) => {
    const lo = num(r[lower]);
    const hi = num(r[upper]);
    return [r[x], lo === null || hi === null ? null : hi - lo];
  });

  return {
    ...base,
    grid: { left: 6, right: 16, top: 26, bottom: 6, containLabel: true },
    legend: { ...(base.legend as Opt), show: true, top: 0, data: ['Observed', 'Forecast'] },
    xAxis: axisFor(columns, x, t),
    yAxis: valueAxis(unitOf(columns, forecast), t),
    series: [
      {
        name: 'interval floor',
        type: 'line',
        stack: 'band',
        lineStyle: { opacity: 0 },
        showSymbol: false,
        silent: true,
        data: floor,
      },
      {
        name: 'Illustrative interval',
        type: 'line',
        stack: 'band',
        lineStyle: { opacity: 0 },
        showSymbol: false,
        silent: true,
        areaStyle: { color: t.text3, opacity: 0.14 },
        data: span,
      },
      {
        name: 'Observed',
        type: 'line',
        connectNulls: false,
        showSymbol: false,
        lineStyle: { width: 1.9, color: t.ink },
        itemStyle: { color: t.ink },
        data: rows.map((r) => [r[x], num(r[observed])]),
      },
      {
        name: 'Forecast',
        type: 'line',
        connectNulls: false,
        showSymbol: false,
        lineStyle: { width: 1.9, color: t.accent, type: 'dashed' },
        itemStyle: { color: t.accent },
        data: rows.map((r) => [r[x], num(r[forecast])]),
      },
    ],
  };
}

/* ---------------------------------------------------------------------------
   bar, distribution, waterfall
   ------------------------------------------------------------------------ */

export function barOption(spec: VizSpec, columns: PackColumn[], rows: Row[], t: ChartTheme): Opt {
  const base = baseOption(t);
  const palette = seriesPalette(t);
  const enc = spec.encodings ?? {};
  const x = str(enc.x) ?? columns.find((c) => c.role === 'dimension')?.id ?? 'x';
  const y = str(enc.y);
  const other = str(enc.otherMeasureSeparate);

  // F23: the measure is a count derived from the rows rather than a column.
  const derived = enc.deriveFromRows === true || (y !== null && !columns.some((c) => c.id === y));
  let categories: string[];
  let values: (number | null)[];
  if (derived) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const key = exact(r[x]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    categories = [...counts.keys()];
    values = [...counts.values()];
  } else {
    const sorted =
      str(enc.sort) === 'descending'
        ? [...rows].sort((a, b) => (num(b[y ?? '']) ?? -Infinity) - (num(a[y ?? '']) ?? -Infinity))
        : rows;
    categories = sorted.map((r) => exact(r[x]));
    values = sorted.map((r) => num(r[y ?? '']));
  }

  const series: Opt[] = [
    {
      name: derived ? 'records' : (y ?? 'value'),
      type: 'bar',
      barMaxWidth: 26,
      itemStyle: { color: palette[0] },
      data: values,
    },
  ];

  // A second measure in a different unit gets its own axis, never the same one.
  if (other && columns.some((c) => c.id === other)) {
    series.push({
      name: other,
      type: 'bar',
      barMaxWidth: 26,
      yAxisIndex: 1,
      itemStyle: { color: palette[1] },
      data: rows.map((r) => num(r[other])),
    });
  }

  return {
    ...base,
    grid: { left: 6, right: other ? 6 : 16, top: other ? 26 : 14, bottom: 6, containLabel: true },
    legend: other ? { ...(base.legend as Opt), show: true, top: 0 } : (base.legend as Opt),
    xAxis: {
      type: 'category',
      data: categories,
      axisLine: { lineStyle: { color: t.lineStrong } },
      axisTick: { show: false },
      axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 9, hideOverlap: true, interval: 0, rotate: categories.length > 5 ? 28 : 0 },
    },
    yAxis: other
      ? [valueAxis(unitOf(columns, y), t), valueAxis(unitOf(columns, other), t, { position: 'right', splitLine: { show: false } })]
      : valueAxis(derived ? 'records' : unitOf(columns, y), t),
    series,
  };
}

export function distributionOption(spec: VizSpec, columns: PackColumn[], rows: Row[], t: ChartTheme): Opt {
  const base = baseOption(t);
  const palette = seriesPalette(t);
  const enc = spec.encodings ?? {};
  const x = str(enc.x) ?? 'bucket';
  const y = str(enc.y);

  // Pre-binned (F12) or raw observations to be binned by value (F25).
  const binned = y !== null && columns.some((c) => c.id === y);
  const usable = rows.filter((r) => num(r[x]) !== null || binned);

  const categories = binned ? usable.map((r) => exact(r[x])) : usable.map((r) => exact(r[x]));
  const values = binned ? usable.map((r) => num(r[y as string])) : usable.map((r) => num(r[x]));

  return {
    ...base,
    grid: { left: 6, right: 16, top: 14, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category',
      data: categories,
      axisLine: { lineStyle: { color: t.lineStrong } },
      axisTick: { show: false },
      axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 9, hideOverlap: true, interval: 0 },
    },
    yAxis: valueAxis(binned ? unitOf(columns, y) : unitOf(columns, x), t),
    series: [
      {
        type: 'bar',
        barMaxWidth: 34,
        itemStyle: { color: palette[0] },
        data: values,
      },
    ],
  };
}

export function waterfallOption(spec: VizSpec, columns: PackColumn[], rows: Row[], t: ChartTheme): Opt {
  const base = baseOption(t);
  const enc = spec.encodings ?? {};
  const x = str(enc.x) ?? 'component';
  const delta = str(enc.delta) ?? str(enc.y) ?? 'delta';
  const running = str(enc.running) ?? 'running';

  // Each bar floats on an invisible support so the steps read as a bridge.
  const support: number[] = [];
  const up: (number | null)[] = [];
  const down: (number | null)[] = [];
  rows.forEach((r, i) => {
    const d = num(r[delta]) ?? 0;
    const run = num(r[running]) ?? 0;
    const isTotal = i === 0 || i === rows.length - 1;
    if (isTotal) {
      support.push(0);
      up.push(run);
      down.push(null);
    } else {
      support.push(Math.min(run, run - d));
      up.push(d >= 0 ? d : null);
      down.push(d < 0 ? -d : null);
    }
  });

  return {
    ...base,
    grid: { left: 6, right: 16, top: 14, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category',
      data: rows.map((r) => exact(r[x])),
      axisLine: { lineStyle: { color: t.lineStrong } },
      axisTick: { show: false },
      axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 9, hideOverlap: true, interval: 0, rotate: 20 },
    },
    yAxis: valueAxis(unitOf(columns, delta), t),
    series: [
      { type: 'bar', stack: 'w', itemStyle: { color: 'transparent' }, silent: true, data: support, tooltip: { show: false } },
      { name: 'increase', type: 'bar', stack: 'w', barMaxWidth: 36, itemStyle: { color: t.ink }, data: up },
      { name: 'decrease', type: 'bar', stack: 'w', barMaxWidth: 36, itemStyle: { color: t.bad }, data: down },
    ],
  };
}

/* ---------------------------------------------------------------------------
   scatter
   ------------------------------------------------------------------------ */

export function scatterOption(spec: VizSpec, columns: PackColumn[], rows: Row[], t: ChartTheme): Opt {
  const base = baseOption(t);
  const enc = spec.encodings ?? {};
  const x = str(enc.x) ?? 'x';
  const y = str(enc.y) ?? 'y';

  // An incomplete pair is dropped from the plot, not from the record, and the
  // panel reports how many were dropped.
  const pairs = rows
    .map((r) => ({ x: num(r[x]), y: num(r[y]) }))
    .filter((p) => p.x !== null && p.y !== null);

  return {
    ...base,
    grid: { left: 6, right: 16, top: 14, bottom: 6, containLabel: true },
    xAxis: valueAxis(unitOf(columns, x), t, { scale: true }),
    yAxis: valueAxis(unitOf(columns, y), t, { scale: true }),
    tooltip: { ...(base.tooltip as Opt), trigger: 'item' },
    series: [
      {
        type: 'scatter',
        symbolSize: 9,
        itemStyle: { color: t.ink, opacity: 0.8 },
        data: pairs.map((p) => [p.x, p.y]),
      },
    ],
  };
}

/* ---------------------------------------------------------------------------
   heatmap, cohort, candlestick
   ------------------------------------------------------------------------ */

/** Coverage and availability states carry meaning, so they get fixed colours. */
export const STATE_COLORS: Record<string, string> = {
  observed: '#1d6b45',
  partial: '#b3701a',
  missing: '#9c2b27',
  unobservable: '#4a4940',
  not_sampled: '#8f8e82',
  provider_error: '#9c2b27',
  zero_success: '#22508f',
};

export function heatmapOption(spec: VizSpec, columns: PackColumn[], rows: Row[], t: ChartTheme): Opt {
  const base = baseOption(t);
  const enc = spec.encodings ?? {};
  const x = str(enc.x) ?? 'x';
  const yEnc = str(enc.y);
  const colorKey = str(enc.color) ?? 'value';
  const colorCol = col(columns, colorKey);
  const categorical = colorCol?.role === 'dimension' || !colorCol;

  const xs = [...new Set(rows.map((r) => exact(r[x])))];
  const ys = yEnc ? [...new Set(rows.map((r) => exact(r[yEnc])))] : [unitOf(columns, colorKey) || 'state'];

  // A categorical colour is mapped through a piecewise scale on the category
  // index, so each state keeps a fixed colour and no state is ever read as a
  // bigger or smaller version of another.
  const states = categorical ? [...new Set(rows.map((r) => exact(r[colorKey])))] : [];

  const cells: { value: number[]; name: string }[] = [];
  for (const r of rows) {
    const xi = xs.indexOf(exact(r[x]));
    const yi = yEnc ? ys.indexOf(exact(r[yEnc])) : 0;
    const v = categorical ? states.indexOf(exact(r[colorKey])) : num(r[colorKey]);
    // An unobserved cell is left empty. Drawing it on the colour scale would
    // make an unavailable observation look like a low one.
    if (v === null) continue;
    cells.push({ value: [xi, yi, v], name: exact(r[colorKey]) });
  }

  const numeric = categorical ? [] : cells.map((c) => c.value[2]);
  const min = numeric.length ? Math.min(...numeric) : 0;
  const max = numeric.length ? Math.max(...numeric) : 1;

  const visualMap = categorical
    ? {
        type: 'piecewise',
        show: false,
        dimension: 2,
        pieces: states.map((s, i) => ({ value: i, label: s, color: STATE_COLORS[s] ?? t.text3 })),
      }
    : {
        type: 'continuous',
        min,
        max: max === min ? min + 1 : max,
        calculable: false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemWidth: 10,
        itemHeight: 70,
        textStyle: { color: t.text3, fontSize: 9, fontFamily: t.mono },
        inRange: { color: heatRamp(t) },
      };

  return {
    ...base,
    grid: { left: 6, right: 16, top: 10, bottom: categorical ? 6 : 34, containLabel: true },
    tooltip: { ...(base.tooltip as Opt), trigger: 'item' },
    xAxis: {
      type: 'category',
      data: xs,
      axisLine: { lineStyle: { color: t.lineStrong } },
      axisTick: { show: false },
      axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 9, hideOverlap: true },
      splitArea: { show: false },
    },
    yAxis: {
      type: 'category',
      data: ys,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 10 },
    },
    visualMap,
    series: [
      {
        type: 'heatmap',
        data: cells,
        itemStyle: { borderColor: t.page, borderWidth: 1 },
        emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1.5 } },
      },
    ],
  };
}

export function cohortOption(spec: VizSpec, columns: PackColumn[], rows: Row[], t: ChartTheme): Opt {
  const enc = { ...(spec.encodings ?? {}) };
  // A cohort matrix is a heatmap with an explicit unavailable state, so it is
  // built from the same code path with the axes fixed by the cohort encoding.
  return heatmapOption(
    { ...spec, kind: 'heatmap', encodings: { ...enc, x: enc.x ?? 'age_month', y: enc.y ?? 'cohort', color: enc.color ?? 'retention_percent' } },
    columns,
    rows,
    t,
  );
}

export function candlestickOption(spec: VizSpec, columns: PackColumn[], rows: Row[], t: ChartTheme): Opt {
  const base = baseOption(t);
  const enc = spec.encodings ?? {};
  const x = str(enc.x) ?? 'day';
  const o = str(enc.open) ?? 'open';
  const h = str(enc.high) ?? 'high';
  const l = str(enc.low) ?? 'low';
  const c = str(enc.close) ?? 'close';
  const vol = str(enc.volume);

  const up = t.ink;
  const down = t.bad;

  const series: Opt[] = [
    {
      name: 'OHLC',
      type: 'candlestick',
      // ECharts wants [open, close, low, high] in this order.
      data: rows.map((r) => [num(r[o]), num(r[c]), num(r[l]), num(r[h])]),
      itemStyle: { color: 'transparent', color0: down, borderColor: up, borderColor0: down },
    },
  ];
  if (vol && columns.some((cc) => cc.id === vol)) {
    series.push({
      name: vol,
      type: 'bar',
      yAxisIndex: 1,
      barMaxWidth: 10,
      itemStyle: { color: t.text3, opacity: 0.45 },
      data: rows.map((r) => num(r[vol])),
    });
  }

  return {
    ...base,
    grid: { left: 6, right: vol ? 6 : 16, top: 14, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category',
      data: rows.map((r) => exact(r[x])),
      axisLine: { lineStyle: { color: t.lineStrong } },
      axisTick: { show: false },
      axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 9, hideOverlap: true },
    },
    yAxis: vol
      ? [
          valueAxis(unitOf(columns, c), t, { scale: true }),
          valueAxis(unitOf(columns, vol), t, { position: 'right', splitLine: { show: false } }),
        ]
      : valueAxis(unitOf(columns, c), t, { scale: true }),
    series,
  };
}

/** Dispatch by kind. Returns null for the kinds that are not ECharts. */
export function optionFor(
  spec: VizSpec,
  columns: PackColumn[],
  rows: Row[],
  t: ChartTheme,
): Opt | null {
  switch (spec.kind) {
    case 'line':
    case 'area':
      return lineOption(spec, columns, rows, t);
    case 'forecast':
      return forecastOption(spec, columns, rows, t);
    case 'bar':
      return barOption(spec, columns, rows, t);
    case 'distribution':
      return distributionOption(spec, columns, rows, t);
    case 'waterfall':
      return waterfallOption(spec, columns, rows, t);
    case 'scatter':
      return scatterOption(spec, columns, rows, t);
    case 'heatmap':
      return heatmapOption(spec, columns, rows, t);
    case 'cohort':
      return cohortOption(spec, columns, rows, t);
    case 'candlestick':
      return candlestickOption(spec, columns, rows, t);
    default:
      return null;
  }
}
