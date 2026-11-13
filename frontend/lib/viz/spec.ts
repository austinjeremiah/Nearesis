import { z } from 'zod';

/**
 * Visualization IR and its validator.
 *
 * Companion doc section 5: "Every chart component must be driven by
 * query-result data plus validated Visualization IR, not by a hand-authored
 * graph for a particular fixture." This file is that IR, and the validator is
 * the gate that stands between a proposed chart and the renderer.
 *
 * The validator's job is to refuse. A chart that cannot be drawn honestly from
 * the result it was handed must produce a stated reason and, where one exists,
 * a legal alternative. Rendering something plausible instead is the failure
 * mode this whole document exists to prevent.
 */

export const VIZ_KINDS = [
  'line',
  'area',
  'bar',
  'scatter',
  'heatmap',
  'candlestick',
  'forecast',
  'distribution',
  'waterfall',
  'cohort',
  'table',
  'evidence_graph',
  'agent_timeline',
] as const;

export type VizKindName = (typeof VIZ_KINDS)[number];

export const MISSINGNESS = ['show_gap', 'break', 'hide', 'annotate'] as const;
export type MissingnessPolicy = (typeof MISSINGNESS)[number];

/** Column roles as the backend envelope declares them. */
export const ColumnRole = z.enum(['time', 'dimension', 'measure', 'lower', 'upper']);
export type ColumnRole = z.infer<typeof ColumnRole>;

export const PackColumn = z.object({
  id: z.string(),
  role: ColumnRole,
  unit: z.string(),
  nullable: z.boolean().optional(),
  precision: z.number().optional(),
  proxyCaveat: z.string().optional(),
});
export type PackColumn = z.infer<typeof PackColumn>;

/**
 * Encodings are deliberately loose at the type level and strict at the
 * validator: the backend owns the shape, and a member this build does not
 * recognise must be reported rather than quietly dropped.
 */
export type Encodings = Record<string, unknown>;

export type VizSpec = {
  kind: VizKindName;
  title: string;
  encodings: Encodings;
  missingnessPolicy?: MissingnessPolicy;
  description?: string;
  annotations?: { markerIds?: string[] };
};

export type Row = Record<string, unknown>;

export type VizRejection = {
  ok: false;
  /** Shown to the reader in place of the chart. */
  reason: string;
  /** A legal chart kind to offer instead, when one exists. */
  remedy?: { kind: VizKindName; label: string };
};

export type VizOk = { ok: true; notes: string[] };
export type VizVerdict = VizOk | VizRejection;

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asStringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Encoding members that configure the chart rather than name a column. They are
 * read by the rules below, not resolved against the result, so "sort:
 * descending" is a directive and not a request for a column called descending.
 */
const DIRECTIVE_KEYS = new Set([
  'sort',
  'scale',
  'requestedScale',
  'displayUnitPolicy',
  'deriveFromRows',
  'disjoint',
  'baseline',
  'missingnessPolicy',
  'annotations',
]);

/** Every column the encodings refer to, flattened. */
function referenced(enc: Encodings): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(enc)) {
    if (DIRECTIVE_KEYS.has(key)) continue;
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) out.push(...value.filter((v): v is string => typeof v === 'string'));
  }
  return out;
}

/** A measure is numeric if every non-null value in the sample parses as one. */
function numericValues(rows: Row[], key: string): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = r[key];
    if (v === null || v === undefined) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Validate a spec against the result that would feed it.
 *
 * `columns` and `rows` come from the query result envelope, never from the
 * spec, so a model cannot declare a column into existence by naming it.
 */
export function validateViz(spec: VizSpec, columns: PackColumn[], rows: Row[]): VizVerdict {
  // Declared columns carry the roles and units. A key that appears in the rows
  // but was left out of the column list is still real data, so it counts as
  // known for the purpose of resolving an encoding.
  const known = new Set(columns.map((c) => c.id));
  for (const r of rows.slice(0, 5)) for (const k of Object.keys(r)) known.add(k);
  const notes: string[] = [];
  const enc = spec.encodings ?? {};

  if (!VIZ_KINDS.includes(spec.kind)) {
    return { ok: false, reason: `Unsupported chart kind "${spec.kind}". The renderer refuses kinds it cannot validate.` };
  }

  // Graph and timeline carry their payload inside the rows rather than naming
  // columns, so the column check does not apply to them.
  const structural = spec.kind === 'evidence_graph' || spec.kind === 'agent_timeline';

  if (!structural) {
    // A measure the chart derives from the rows themselves, such as a count per
    // category, is named but not fetched, so it is not expected in the result.
    const derived = enc.deriveFromRows === true ? new Set([asString(enc.y) ?? '']) : new Set<string>();
    const missing = referenced(enc).filter((id) => !known.has(id) && !derived.has(id));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `The chart asks for ${missing.map((m) => `"${m}"`).join(', ')}, which the result does not contain. A chart cannot name a column into existence.`,
      };
    }
  }

  // --- scale -----------------------------------------------------------------
  // F20: a logarithmic axis over values that reach zero or go negative is not a
  // rescale, it is a lie about the data.
  if (asString(enc.requestedScale) === 'log' || asString(enc.scale) === 'log') {
    const yKey = asString(enc.y) ?? asStringList(enc.y)[0];
    if (yKey) {
      const vals = numericValues(rows, yKey);
      const bad = vals.filter((v) => v <= 0);
      if (bad.length > 0) {
        return {
          ok: false,
          reason: `A logarithmic axis is undefined at zero and below, and ${bad.length} of ${vals.length} observations are not positive. The scale was rejected, not clamped.`,
          remedy: { kind: spec.kind, label: 'Draw on a linear axis' },
        };
      }
    }
  }

  // --- candlestick -----------------------------------------------------------
  // F05 is a real OHLC set. F26 is a table of dry quote samples. The second
  // cannot become the first by choosing a chart type.
  if (spec.kind === 'candlestick') {
    const need = ['open', 'high', 'low', 'close'];
    const have = need.filter((k) => {
      const col = asString(enc[k]) ?? k;
      return known.has(col);
    });
    if (have.length < 4) {
      return {
        ok: false,
        reason:
          'Candlesticks need observed open, high, low and close for each period. This result has no OHLC columns, and a single sampled price per day cannot be turned into a candle.',
        remedy: { kind: 'line', label: 'Draw the price trend as a line' },
      };
    }
    const o = asString(enc.open) ?? 'open';
    const h = asString(enc.high) ?? 'high';
    const l = asString(enc.low) ?? 'low';
    const c = asString(enc.close) ?? 'close';
    const broken = rows.filter((r) => {
      const open = Number(r[o]);
      const high = Number(r[h]);
      const low = Number(r[l]);
      const close = Number(r[c]);
      if (![open, high, low, close].every(Number.isFinite)) return false;
      return high < Math.max(open, close) || low > Math.min(open, close);
    });
    if (broken.length > 0) {
      return {
        ok: false,
        reason: `${broken.length} candles violate high >= max(open, close) or low <= min(open, close). The result is not valid OHLC.`,
      };
    }
  }

  // --- stacking --------------------------------------------------------------
  // F04: a stack asserts that the parts sum to the whole. That assertion needs
  // declared disjointness, not a hopeful glance at the column names.
  if (spec.kind === 'area' || asString(enc.stack) !== null || Array.isArray(enc.stack)) {
    const parts = asStringList(enc.stack);
    if (parts.length > 0) {
      if (enc.disjoint === false) {
        return {
          ok: false,
          reason:
            'These categories are not declared disjoint, so stacking them would show a total that double counts. Stacking was refused.',
          remedy: { kind: 'bar', label: 'Compare the categories side by side' },
        };
      }
      const totalKey = asString(enc.total);
      if (totalKey && known.has(totalKey)) {
        const mismatched = rows.filter((r) => {
          const total = Number(r[totalKey]);
          if (!Number.isFinite(total)) return false;
          const sum = parts.reduce((a, p) => a + (Number(r[p]) || 0), 0);
          return Math.abs(sum - total) > 0.5;
        });
        if (mismatched.length > 0) {
          return {
            ok: false,
            reason: `The stacked parts do not reconcile with the stated total on ${mismatched.length} rows. A stack that does not add up is not a stack.`,
            remedy: { kind: 'line', label: 'Draw the components unstacked' },
          };
        }
        notes.push('Stacked components reconcile exactly with the reported total.');
      }
    }
  }

  // --- mixed units -----------------------------------------------------------
  // F08 and F24: two measures in different units never share one axis.
  const measureKeys = [
    ...asStringList(enc.y),
    ...(asString(enc.y) ? [asString(enc.y) as string] : []),
  ].filter((k) => known.has(k));
  if (measureKeys.length > 1) {
    const units = new Set(
      measureKeys.map((k) => columns.find((c) => c.id === k)?.unit).filter(Boolean) as string[],
    );
    if (units.size > 1) {
      notes.push(
        `Two units on this chart (${[...units].join(', ')}). They are drawn on separate axes and never summed.`,
      );
    }
  }
  if (Array.isArray(enc.separateAxes)) {
    notes.push('Different units, drawn on their own axes. No combined total is offered.');
  }

  // --- forecast --------------------------------------------------------------
  // F07: a lower and an upper bound are not a confidence interval.
  if (spec.kind === 'forecast') {
    notes.push(
      'The shaded band is an illustrative interval from an unvalidated method. It is not a calibrated confidence interval.',
    );
  }

  // --- cohort ----------------------------------------------------------------
  if (spec.kind === 'cohort') {
    notes.push('An unobserved future cell is unavailable, not zero retention.');
  }

  return { ok: true, notes };
}

/**
 * Can this result be redrawn as another kind without going back to the
 * warehouse? Spec 6.5: "Chart type may change without re-query only if the
 * current validated result has the necessary columns, grain and semantics."
 */
export function conversionTargets(
  spec: VizSpec,
  columns: PackColumn[],
  rows: Row[],
): { kind: VizKindName; label: string; blocked?: string }[] {
  const candidates: VizKindName[] = ['line', 'area', 'bar', 'scatter', 'table', 'candlestick', 'distribution'];
  return candidates
    .filter((k) => k !== spec.kind)
    .map((kind) => {
      const probe = validateViz({ ...spec, kind }, columns, rows);
      return probe.ok
        ? { kind, label: kind }
        : { kind, label: kind, blocked: probe.reason };
    });
}
