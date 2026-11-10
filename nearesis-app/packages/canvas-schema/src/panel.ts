import { type MetricMetadata, PanelKind, PanelSpec } from "@nearesis/contracts";
import { type Issue, type Result, zodIssues } from "./issues.ts";

/** The safe component registry: exactly the contract's PanelKind enum. Nothing else is ever instantiated (C09c). */
export const REGISTERED_PANEL_KINDS: readonly PanelKind[] = PanelKind.options;

export type TimeSemantics = "event_time" | "fetched_at" | "settlement_time" | "bucket";

/** Shape of a semantic query result, as returned in a DataFrameEnvelope (columns + units). */
export interface FieldInfo {
  name: string;
  unit: string | null;
  role: "time" | "measure" | "dimension";
  timeSemantics?: TimeSemantics;
  metricId?: string;
}
export interface QueryResultShape {
  queryHash: string;
  grain?: "hour" | "day" | "week" | "month";
  fields: FieldInfo[];
}
export interface DataStats {
  min: Record<string, number | null>;
  hasGaps: boolean;
}
export interface ValidationContext {
  /** Resolves a panel's queryRef.hash to its result shape. Without it, result-dependent checks are skipped. */
  resolveQuery?: (queryHash: string) => QueryResultShape | undefined;
  metrics?: readonly MetricMetadata[];
  stats?: (queryHash: string) => DataStats | undefined;
}

/** Keys that indicate executable or markup content. They are never valid anywhere in a spec (C02, C10d). */
const EXECUTABLE_KEY =
  /^(render|renderer|component|components|jsx|tsx|html|innerhtml|dangerouslysetinnerhtml|formatter|valueformatter|labelformatter|script|eval|code|template|on[a-z]+|style|href|src)$/i;
const JSX_TEXT = /^\s*<\s*[A-Za-z][\w.:-]*[\s/>]/;

/** Recursively finds functions, symbols, executable keys and prototype-pollution keys in untrusted input. */
export function findExecutableContent(value: unknown, path = ""): Issue[] {
  const out: Issue[] = [];
  const walk = (v: unknown, p: string, depth: number) => {
    if (depth > 32) {
      out.push({ code: "SCHEMA_INVALID", path: p, message: "nesting too deep" });
      return;
    }
    if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
      out.push({ code: "EXECUTABLE_CONTENT", path: p, message: `${typeof v} values are not allowed` });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`, depth + 1));
      return;
    }
    if (v && typeof v === "object") {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        out.push({ code: "EXECUTABLE_CONTENT", path: p, message: "only plain JSON objects are allowed" });
        return;
      }
      for (const k of Object.keys(v)) {
        const kp = p ? `${p}.${k}` : k;
        const d = Object.getOwnPropertyDescriptor(v, k);
        // Accessors would run code when read; reject them without invoking.
        if (d && (d.get || d.set)) {
          out.push({ code: "EXECUTABLE_CONTENT", path: kp, message: "accessor properties are not allowed" });
          continue;
        }
        if (k === "__proto__" || k === "constructor" || k === "prototype" || EXECUTABLE_KEY.test(k))
          out.push({
            code: "EXECUTABLE_CONTENT",
            path: kp,
            message: `property "${k}" is executable or markup`,
          });
        walk(d?.value, kp, depth + 1);
      }
    }
  };
  walk(value, path, 0);
  return out;
}

/** Structural validation of one untrusted panel spec, plus semantic binding rules. Pure; never instantiates anything. */
export function validatePanelSpec(
  raw: unknown,
  ctx: ValidationContext = {},
  prefix = "panel",
): Result<PanelSpec> {
  if (typeof raw === "string") {
    return {
      ok: false,
      issues: [
        JSX_TEXT.test(raw)
          ? { code: "EXECUTABLE_CONTENT", path: prefix, message: "JSX/HTML markup is not a panel spec" }
          : { code: "NOT_AN_OBJECT", path: prefix, message: "panel spec must be a JSON object" },
      ],
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return {
      ok: false,
      issues: [{ code: "NOT_AN_OBJECT", path: prefix, message: "panel spec must be a JSON object" }],
    };
  // Executable content is rejected before any parser touches the value, so nothing in it can run.
  const exec = findExecutableContent(raw, prefix);
  if (exec.length) return { ok: false, issues: exec };
  const parsed = PanelSpec.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error, prefix) };
  const issues = panelSemanticIssues(parsed.data, ctx, prefix);
  return issues.length ? { ok: false, issues } : { ok: true, value: parsed.data };
}

function encodingFields(p: PanelSpec): Array<[string, string]> {
  const e = p.encoding;
  const out: Array<[string, string]> = [];
  if (e.x) out.push(["encoding.x", e.x]);
  (e.y ?? []).forEach((f, i) => out.push([`encoding.y[${i}]`, f]));
  if (e.series) out.push(["encoding.series", e.series]);
  (e.tooltip ?? []).forEach((f, i) => out.push([`encoding.tooltip[${i}]`, f]));
  return out;
}

const NEEDS_XY = new Set<PanelKind>(["timeSeries", "candlestick", "bar", "scatter", "heatmap", "waterfall"]);
const NON_ADDITIVE = new Set(["count_distinct", "non_additive", "ratio"]);
const GRAIN_ORDER = { hour: 0, day: 1, week: 2, month: 3 } as const;

/** Rules that hold for a validated PanelSpec. Shared by validatePanelSpec, the patch validator and the compiler. */
export function panelSemanticIssues(p: PanelSpec, ctx: ValidationContext, prefix = "panel"): Issue[] {
  const issues: Issue[] = [];
  const at = (s: string) => `${prefix}.${s}`;
  const bound = new Set(p.dataBinding.fields);
  for (const [path, f] of encodingFields(p))
    if (!bound.has(f))
      issues.push({
        code: "ENCODING_FIELD_UNKNOWN",
        path: at(path),
        message: `field "${f}" is not in dataBinding.fields`,
      });
  for (const k of Object.keys(p.dataBinding.units))
    if (!bound.has(k))
      issues.push({
        code: "ENCODING_FIELD_UNKNOWN",
        path: at(`dataBinding.units.${k}`),
        message: `unit for unbound field "${k}"`,
      });
  if (NEEDS_XY.has(p.kind) && (!p.encoding.x || !p.encoding.y?.length))
    issues.push({
      code: "KIND_ENCODING_INVALID",
      path: at("encoding"),
      message: `${p.kind} requires encoding.x and encoding.y`,
    });

  const y = p.encoding.y ?? [];
  for (const [i, f] of y.entries())
    if (!p.dataBinding.units[f])
      issues.push({
        code: "UNIT_MISSING",
        path: at(`dataBinding.units.${f}`),
        message: `y[${i}] "${f}" has no declared unit`,
      });

  // C03: incompatible units need an explicit index transform, or at most two disclosed axes.
  const units = [...new Set(y.map((f) => p.dataBinding.units[f]).filter(Boolean))];
  if (units.length > 2 && p.encoding.scale !== "index_100")
    issues.push({
      code: "UNIT_MISMATCH",
      path: at("encoding.y"),
      message: `${units.length} incompatible units (${units.join(", ")}); use scale "index_100" or split panels`,
    });
  if (units.length === 2 && p.encoding.scale === "log")
    issues.push({
      code: "UNIT_MISMATCH",
      path: at("encoding.scale"),
      message: "log scale with two units is ambiguous",
    });

  // C17: no interpolation across missing source days unless a declared transform exists (none is declarable in v1).
  if (p.encoding.interpolateGaps)
    issues.push({
      code: "GAP_INTERPOLATION_REFUSED",
      path: at("encoding.interpolateGaps"),
      message: "interpolating across missing days is disallowed; gaps render as breaks",
    });

  const shape = ctx.resolveQuery?.(p.queryRef.hash);
  if (ctx.resolveQuery && !shape)
    issues.push({
      code: "QUERY_UNRESOLVED",
      path: at("queryRef.hash"),
      message: "query hash does not resolve to a result",
    });
  if (shape) {
    const byName = new Map(shape.fields.map((f) => [f.name, f]));
    for (const [i, f] of p.dataBinding.fields.entries()) {
      const info = byName.get(f);
      if (!info) {
        issues.push({
          code: "FIELD_NOT_IN_RESULT",
          path: at(`dataBinding.fields[${i}]`),
          message: `field "${f}" is not in the query result`,
        });
        continue;
      }
      const declared = p.dataBinding.units[f];
      if (
        info.role === "measure" &&
        info.unit &&
        declared &&
        declared !== info.unit &&
        p.encoding.scale !== "index_100"
      )
        issues.push({
          code: "UNIT_MISMATCH",
          path: at(`dataBinding.units.${f}`),
          message: `declared unit "${declared}" differs from result unit "${info.unit}"`,
        });
    }
    const x = p.encoding.x ? byName.get(p.encoding.x) : undefined;
    if (p.kind === "timeSeries" && x && x.role !== "time")
      issues.push({
        code: "KIND_ENCODING_INVALID",
        path: at("encoding.x"),
        message: "timeSeries x must be a UTC time field",
      });
    if (ctx.metrics) {
      const metrics = new Map(ctx.metrics.map((m) => [m.cubeMember, m]));
      for (const f of y) {
        const m = metrics.get(byName.get(f)?.metricId ?? f);
        if (!m) continue;
        // C17: quote series use sample time (fetchedAt), never settlement time.
        if (isQuoteMetric(m) && x && x.timeSemantics !== "fetched_at")
          issues.push({
            code: "QUOTE_TIME_AXIS",
            path: at("encoding.x"),
            message: `quote metric ${m.id} must be plotted on fetchedAt sample time, not ${x.timeSemantics ?? "unknown"} time`,
          });
        // C17/S02: never sum a non-additive daily measure (e.g. daily distinct signers) into a coarser period.
        const coarser = shape.grain !== undefined && GRAIN_ORDER[shape.grain] > GRAIN_ORDER[m.grain];
        if (
          NON_ADDITIVE.has(m.aggregationLaw) &&
          (p.encoding.aggregation === "sum" || p.encoding.aggregation === "avg" || coarser)
        )
          issues.push(periodUniqueIssue(m, at("encoding.aggregation")));
      }
    }
  }
  const stats = ctx.stats?.(p.queryRef.hash);
  if (stats && p.encoding.scale === "log")
    for (const f of y) {
      const min = stats.min[f];
      if (min !== null && min !== undefined && min <= 0)
        issues.push({
          code: "LOG_AXIS_NONPOSITIVE",
          path: at("encoding.scale"),
          message: `log axis rejects non-positive values (min of ${f} is ${min})`,
        });
    }
  return issues;
}

export function isQuoteMetric(m: MetricMetadata): boolean {
  // Sources are "provider" or "provider:dataset" (registry form).
  return (
    m.sources.some((x) => x.split(":")[0] === "intents-1click") || m.id.startsWith("intents.route_quote")
  );
}

export function periodUniqueIssue(m: MetricMetadata, path: string): Issue {
  return {
    code: "PERIOD_UNIQUE_SUM_REFUSED",
    path,
    message: `${m.id} is ${m.aggregationLaw} at ${m.grain} grain; summing it across a period does not give period uniques`,
    suggestion: m.id.includes("signer") ? "near.period_unique_signers" : "use a period-level distinct metric",
  };
}
