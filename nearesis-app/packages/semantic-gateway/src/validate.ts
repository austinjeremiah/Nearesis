import { SemanticQuery } from "@nearesis/contracts";
import type { MetricMetadata } from "@nearesis/contracts";
import type { Registry, RegistryDimension } from "@nearesis/analytics";
import { fail, type ReasonCode } from "./errors.ts";
import type { Policy, QueryErr } from "./types.ts";

/** Letters, digits, space and `_ . : @ / + -` (asset ids, chain names, addresses, symbols). */
const SAFE_FILTER_VALUE = /^[\p{L}\p{N} _.:@/+-]{1,200}$/u;

export const INDEX_UNIT = "index_100";

/** Unit compatibility: only identical units share an axis; mixing needs the explicit indexed transform. */
export function unitsCompatible(units: string[]): boolean {
  return new Set(units).size <= 1;
}

export interface Plan {
  ast: SemanticQuery;
  view: string;
  metrics: MetricMetadata[];
  dimensions: RegistryDimension[];
  time: RegistryDimension;
  filterDims: RegistryDimension[];
  indexed: boolean;
}

type ZodIssueLike = { code: string; path: PropertyKey[]; message: string; keys?: string[]; origin?: string };

function reasonFor(i: ZodIssueLike): ReasonCode {
  switch (i.code) {
    case "unrecognized_keys":
      return "UNKNOWN_FIELD";
    case "too_big":
    case "too_small":
      return "LIMIT_EXCEEDED";
    case "invalid_format":
      return "INVALID_FORMAT";
    case "invalid_value":
      return "INVALID_VALUE";
    case "custom":
      return "TIME_RANGE_INVALID";
    default:
      return "INVALID_TYPE";
  }
}

const pathStr = (p: PropertyKey[]) =>
  p.map((s, i) => (typeof s === "number" ? `[${s}]` : i ? `.${String(s)}` : String(s))).join("");

/** Step 1: strict schema. 422 with a specific reasonCode and the offending path; nothing reaches Cube. */
export function parseAst(input: unknown): { ok: true; ast: SemanticQuery } | QueryErr {
  const r = SemanticQuery.safeParse(input);
  if (r.success) return { ok: true, ast: r.data };
  const details: Array<{ path: string; issue: string }> = [];
  let first: ReasonCode | null = null;
  for (const raw of r.error.issues) {
    const i = raw as unknown as ZodIssueLike;
    const reason =
      i.code === "invalid_type" && (i as { received?: string }).received === "undefined"
        ? "REQUIRED_FIELD_MISSING"
        : reasonFor(i);
    const isMissing =
      i.code === "invalid_type" &&
      /received undefined|expected .* received undefined|Invalid input: expected .*, received undefined/.test(
        i.message,
      );
    const rc: ReasonCode = isMissing ? "REQUIRED_FIELD_MISSING" : reason;
    first ??= rc;
    if (i.code === "unrecognized_keys" && i.keys)
      for (const k of i.keys) details.push({ path: pathStr([...i.path, k]), issue: `${rc}: unknown field` });
    else details.push({ path: pathStr(i.path), issue: `${rc}: ${i.message}`.slice(0, 200) });
  }
  return fail(
    "VALIDATION_FAILED",
    first ?? "INVALID_TYPE",
    `Query rejected: ${details[0]?.issue ?? "invalid"}`,
    {
      details,
      nextAction: "Send a query that matches the SemanticQuery schema (no extra fields).",
    },
  );
}

/**
 * Pure validation for the gateway and the canvas compiler: strict schema, member existence + visibility,
 * single-view compatibility, aggregation law, unit compatibility, window size. Cost is estimated separately (needs coverage).
 */
export function validateQuery(
  input: unknown,
  policy: Policy,
  registry: Registry,
): { ok: true; plan: Plan } | QueryErr {
  const parsed = parseAst(input);
  if (!parsed.ok) return parsed;
  const ast = parsed.ast;

  if (ast.semanticVersion !== registry.semanticVersion)
    return fail(
      "STALE_VERSION",
      "STALE_SEMANTIC_VERSION",
      `Query targets semantic version ${ast.semanticVersion}; active version is ${registry.semanticVersion}.`,
      {
        nextAction: `Re-issue the query with semanticVersion ${registry.semanticVersion}.`,
        details: [{ path: "semanticVersion", issue: "STALE_SEMANTIC_VERSION" }],
      },
    );

  const granted = new Set(policy.grantedMembers);
  const metricById = new Map(registry.metrics.map((m) => [m.id, m]));
  const dimById = new Map(registry.dimensions.map((d) => [d.id, d]));

  const unknown = (path: string) =>
    fail("VALIDATION_FAILED", "UNKNOWN_MEMBER", "Unknown member.", {
      details: [{ path, issue: "UNKNOWN_MEMBER" }],
      nextAction: "Call discover to list available members.",
    });
  const hidden = (path: string) =>
    fail("FORBIDDEN", "MEMBER_NOT_VISIBLE", "Member is not available to this workspace.", {
      details: [{ path, issue: "MEMBER_NOT_VISIBLE" }],
    });

  const metrics: MetricMetadata[] = [];
  for (const [i, id] of ast.measures.entries()) {
    const m = metricById.get(id);
    if (!m) return unknown(`measures[${i}]`);
    if (m.visibility === "restricted" && !granted.has(m.id)) return hidden(`measures[${i}]`);
    metrics.push(m);
  }
  const dimensions: RegistryDimension[] = [];
  for (const [i, id] of ast.dimensions.entries()) {
    const d = dimById.get(id);
    if (!d || d.kind !== "dimension") return unknown(`dimensions[${i}]`);
    if (d.visibility === "restricted" && !granted.has(d.id)) return hidden(`dimensions[${i}]`);
    dimensions.push(d);
  }
  const time = dimById.get(ast.time.field);
  if (!time || time.kind !== "time") return unknown("time.field");
  const filterDims: RegistryDimension[] = [];
  for (const [i, f] of ast.filters.entries()) {
    const d = dimById.get(f.member);
    if (!d || d.kind !== "dimension") return unknown(`filters[${i}].member`);
    if (d.visibility === "restricted" && !granted.has(d.id)) return hidden(`filters[${i}].member`);
    filterDims.push(d);
    // Cube inlines filter values into the SQL it sends to ClickHouse (escaped), so a value may not carry SQL syntax:
    // quotes, backslashes, comment markers, statement separators, brackets or control characters never reach Cube.
    for (const [j, v] of f.values.entries())
      if (typeof v === "string" && !SAFE_FILTER_VALUE.test(v))
        return fail(
          "VALIDATION_FAILED",
          "INVALID_VALUE",
          "Filter value contains characters that are not allowed.",
          {
            details: [{ path: `filters[${i}].values[${j}]`, issue: "INVALID_VALUE" }],
          },
        );
  }
  for (const [i, o] of ast.order.entries()) {
    const known =
      metricById.has(o.member) ||
      (dimById.has(o.member) && dimById.get(o.member)!.visibility !== "restricted") ||
      granted.has(o.member);
    if (!known) return unknown(`order[${i}].member`);
    if (!ast.measures.includes(o.member) && !ast.dimensions.includes(o.member) && o.member !== ast.time.field)
      return fail("VALIDATION_FAILED", "UNKNOWN_MEMBER", "Order member must be selected in the query.", {
        details: [{ path: `order[${i}].member`, issue: "UNKNOWN_MEMBER" }],
      });
  }

  // Aggregate-only metrics are never broken down below the aggregate (no dimensions), whatever the grain.
  if (metrics.some((m) => m.visibility === "aggregate_only") && dimensions.length > 0)
    return fail(
      "FORBIDDEN",
      "AGGREGATE_ONLY_BREAKDOWN_REFUSED",
      "An aggregate-only measure cannot be broken down by dimensions.",
      {
        details: [{ path: "dimensions", issue: "AGGREGATE_ONLY_BREAKDOWN_REFUSED" }],
      },
    );

  const views = new Set([
    ...metrics.map((m) => m.cubeMember.split(".")[0]!),
    ...dimensions.map((d) => d.view),
    time.view,
    ...filterDims.map((d) => d.view),
  ]);
  if (views.size !== 1)
    return fail(
      "VALIDATION_FAILED",
      "INCOMPATIBLE_VIEWS",
      `Members span several semantic views (${[...views].sort().join(", ")}); a query must use one source-limited view.`,
      {
        details: [{ path: "measures", issue: "INCOMPATIBLE_VIEWS" }],
      },
    );

  // Daily distinct values are never summed into period uniques (S02).
  if (ast.time.grain === "week" || ast.time.grain === "month") {
    const bad = metrics.findIndex((m) => m.aggregationLaw === "non_additive");
    if (bad >= 0) {
      const m = metrics[bad]!;
      return fail(
        "DOMAIN_INVARIANT",
        "PERIOD_UNIQUE_SUM_REFUSED",
        `${m.id} is a daily distinct count; summing days into a ${ast.time.grain} would overstate uniques.`,
        {
          details: [{ path: `measures[${bad}]`, issue: "PERIOD_UNIQUE_SUM_REFUSED" }],
          nextAction: m.id.startsWith("near.")
            ? "Use near.period_unique_signers for period-unique signers, or query at day grain."
            : "Query at day grain.",
        },
      );
    }
  }

  // Unit compatibility: explicit indexed transform required for mixed units (S05).
  const units = metrics.map((m) => m.unit);
  let indexed = false;
  if (ast.outputUnit !== undefined) {
    if (ast.outputUnit === INDEX_UNIT) indexed = true;
    else if (!(unitsCompatible(units) && units[0] === ast.outputUnit))
      return fail(
        "DOMAIN_INVARIANT",
        "UNIT_MISMATCH",
        `outputUnit ${ast.outputUnit} is not a declared transform of ${[...new Set(units)].join(", ")}.`,
        {
          details: [{ path: "outputUnit", issue: "UNIT_MISMATCH" }],
          nextAction: `Use outputUnit "${INDEX_UNIT}" for an indexed comparison.`,
        },
      );
  }
  if (!unitsCompatible(units) && !indexed)
    return fail(
      "DOMAIN_INVARIANT",
      "UNIT_MISMATCH",
      `Measures have different units (${[...new Set(units)].join(", ")}) and cannot share an axis.`,
      {
        details: [{ path: "measures", issue: "UNIT_MISMATCH" }],
        nextAction: `Plot separately, or set outputUnit to "${INDEX_UNIT}" for an explicit indexed transform.`,
      },
    );

  const days = (Date.parse(ast.time.to) - Date.parse(ast.time.from)) / 86_400_000;
  if (days > policy.maxWindowDays)
    return fail(
      "BUDGET_EXCEEDED",
      "WINDOW_TOO_LARGE",
      `Window of ${Math.ceil(days)} days exceeds the policy maximum of ${policy.maxWindowDays}.`,
      {
        details: [{ path: "time", issue: "WINDOW_TOO_LARGE" }],
        nextAction: "Narrow the date range.",
      },
    );

  return { ok: true, plan: { ast, view: [...views][0]!, metrics, dimensions, time, filterDims, indexed } };
}
