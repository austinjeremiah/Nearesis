import { createHash } from "node:crypto";
import { canonicalJson } from "@nearesis/analytics";
import {
  MetricProposal,
  type MetricAggregation,
  type MetricColumnRef,
  type MetricExpr,
  type MetricFilter,
  type MetricIssue,
} from "@nearesis/contracts";
import type { CatalogueColumn, CatalogueTable, SourceCatalogue } from "./catalogue.ts";
import { formatUnit, mulUnit, normalizeUnit, parseUnit, unitsEqual, type Unit } from "./units.ts";

/** Namespaces owned by the static registry or the platform: authored metrics cannot use them. */
export const RESERVED_NAMESPACES = new Set([
  "live",
  "fixture",
  "certified",
  "registry",
  "system",
  "semantic",
  "kernel",
]);

/** Keys that signal an attempt to smuggle SQL or an expression string into a proposal (S03). */
const SQL_KEYS =
  /^(sql|raw_?sql|query|select|where|having|expr|expression|statement|clause|join_on|on|group_?by|order_?by|from)$/i;
const SQL_SHAPE = /[\s;()'"`\\]|--|\/\*|\*\/|=|<|>/;
const IDENT_FIELDS = new Set(["table", "column", "id", "name", "namespace", "left", "right"]);

export interface CompiledTable {
  table: string;
  database: string;
  timeColumn: string;
  timeIsDate: boolean;
  final: boolean;
  aggs: MetricAggregation[];
  filters: MetricFilter[];
  dims: string[];
  columns: Record<string, CatalogueColumn>;
  provider: string | null;
  coverageDataset: string | null;
}

export interface CompiledPlan {
  proposal: MetricProposal;
  base: string;
  /** Per-table aggregation blocks; the first is the base table. */
  tables: CompiledTable[];
  formula: MetricExpr;
  derivedUnit: string;
  fingerprint: string;
}

export type CompileResult =
  { ok: true; plan: CompiledPlan; issues: [] } | { ok: false; issues: MetricIssue[] };

export interface CompileContext {
  tenantId: string;
}

const issue = (reason: MetricIssue["reason"], path: string, message: string): MetricIssue => ({
  reason,
  path,
  message,
});

const pathOf = (p: PropertyKey[]) =>
  p.map((s, i) => (typeof s === "number" ? `[${s}]` : i ? `.${String(s)}` : String(s))).join("");

function valueAt(root: unknown, path: PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const p of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[p];
  }
  return cur;
}

/** Maps zod issues to authoring reasons: unknown keys and SQL-shaped identifiers are RAW_SQL_REFUSED or UNKNOWN_FIELD. */
function schemaIssues(input: unknown, err: { issues: Array<Record<string, unknown>> }): MetricIssue[] {
  const out: MetricIssue[] = [];
  for (const raw of err.issues) {
    const path = (raw.path as PropertyKey[]) ?? [];
    const code = raw.code as string;
    if (code === "unrecognized_keys") {
      for (const k of (raw.keys as string[]) ?? []) {
        const p = pathOf([...path, k]);
        out.push(
          SQL_KEYS.test(k)
            ? issue(
                "RAW_SQL_REFUSED",
                p,
                `Proposals carry no SQL or expression strings: "${k}" is not a field.`,
              )
            : issue("UNKNOWN_FIELD", p, `Unknown field "${k}".`),
        );
      }
      continue;
    }
    const last = path[path.length - 1];
    const v = valueAt(input, path);
    if (typeof v === "string" && typeof last === "string" && IDENT_FIELDS.has(last) && SQL_SHAPE.test(v))
      out.push(
        issue(
          "RAW_SQL_REFUSED",
          pathOf(path),
          "An identifier field contains SQL syntax. Only catalogue names are accepted.",
        ),
      );
    else out.push(issue("INVALID_PROPOSAL", pathOf(path), String(raw.message ?? "invalid")));
  }
  return out;
}

const key = (r: MetricColumnRef) => `${r.table}.${r.column}`;

function aggUnit(a: MetricAggregation, col: CatalogueColumn | undefined): string | null {
  switch (a.fn) {
    case "count":
      return "row";
    case "count_distinct":
      return `distinct_${a.column?.column ?? "row"}`;
    default:
      return col?.unit ?? null;
  }
}

/**
 * Typed unit evaluation of the formula. add/sub need identical units; mul/div combine exponents; a constant is
 * dimensionless unless it declares a unit. Returns the unit or records an issue.
 */
function evalUnit(
  e: MetricExpr,
  units: Map<string, Unit>,
  used: Set<string>,
  issues: MetricIssue[],
  path: string,
): Unit | null {
  switch (e.kind) {
    case "agg": {
      const u = units.get(e.id);
      if (!u) {
        issues.push(issue("AGGREGATION_INVALID", path, `Formula references unknown aggregation "${e.id}".`));
        return null;
      }
      used.add(e.id);
      return u;
    }
    case "const": {
      if (e.unit === undefined) return new Map();
      const u = parseUnit(e.unit);
      if (!u) issues.push(issue("UNIT_UNKNOWN", path, `Unparseable unit "${e.unit}".`));
      return u;
    }
    case "op": {
      const l = evalUnit(e.left, units, used, issues, `${path}.left`);
      const r = evalUnit(e.right, units, used, issues, `${path}.right`);
      if (!l || !r) return null;
      if (e.op === "add" || e.op === "sub") {
        if (!unitsEqual(l, r)) {
          issues.push(
            issue(
              "UNIT_MISMATCH",
              path,
              `Cannot ${e.op} ${formatUnit(l)} and ${formatUnit(r)}: units differ.`,
            ),
          );
          return null;
        }
        return l;
      }
      if (e.op === "div" && e.right.kind === "const" && e.right.value === 0) {
        issues.push(issue("AGGREGATION_INVALID", path, "Division by a zero constant."));
        return null;
      }
      return mulUnit(l, r, e.op === "mul" ? 1 : -1);
    }
  }
}

const dayOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/**
 * The allowlisted typed compiler front half: schema, tenant scope, catalogue membership, declared joins, unit algebra,
 * dedup obligations. It produces a CompiledPlan (structured, no SQL); `sql.ts` renders statements from the plan using only
 * catalogue identifiers and bound parameters.
 */
export function compileProposal(input: unknown, cat: SourceCatalogue, ctx: CompileContext): CompileResult {
  const parsed = MetricProposal.safeParse(input);
  if (!parsed.success) return { ok: false, issues: schemaIssues(input, parsed.error as never) };
  const p = parsed.data;
  const issues: MetricIssue[] = [];

  if (RESERVED_NAMESPACES.has(p.namespace))
    issues.push(
      issue(
        "NAMESPACE_RESERVED",
        "namespace",
        `Namespace "${p.namespace}" is reserved for the static registry.`,
      ),
    );
  if (p.author.tenantId !== ctx.tenantId)
    issues.push(
      issue("CROSS_TENANT_SOURCE", "author.tenantId", "The proposal's tenant is not the caller's tenant."),
    );

  const tableOf = (t: string, path: string): CatalogueTable | null => {
    const tab = cat.tables[t];
    if (!tab) {
      issues.push(issue("UNKNOWN_SOURCE", path, `Table "${t}" is not in the source catalogue.`));
      return null;
    }
    if (tab.tenantId !== null && tab.tenantId !== ctx.tenantId) {
      issues.push(issue("CROSS_TENANT_SOURCE", path, `Table "${t}" belongs to another tenant.`));
      return null;
    }
    return tab;
  };
  const colOf = (r: MetricColumnRef, path: string): CatalogueColumn | null => {
    if (!p.sources.includes(r.table)) {
      issues.push(issue("UNKNOWN_SOURCE", path, `Table "${r.table}" is used but not listed in sources.`));
      return null;
    }
    const tab = tableOf(r.table, path);
    if (!tab) return null;
    const c = tab.columns[r.column];
    if (!c) {
      issues.push(
        tab.denied.includes(r.column)
          ? issue("COLUMN_NOT_ALLOWED", path, `Column "${key(r)}" is not available for authoring.`)
          : issue("UNKNOWN_COLUMN", path, `Column "${key(r)}" does not exist in the catalogue.`),
      );
      return null;
    }
    return c;
  };

  p.sources.forEach((s, i) => tableOf(s, `sources[${i}]`));

  // time grain
  const tg = colOf(p.timeGrain.column, "timeGrain.column");
  if (tg && tg.kind !== "time")
    issues.push(
      issue(
        "TIME_COLUMN_INVALID",
        "timeGrain.column",
        `"${key(p.timeGrain.column)}" is not a date or time column.`,
      ),
    );
  const base = p.timeGrain.column.table;

  // entity grain
  if (p.entityGrain.kind === "column") {
    if (!p.entityGrain.column)
      issues.push(issue("INVALID_PROPOSAL", "entityGrain.column", "entityGrain.column is required."));
    else {
      const c = colOf(p.entityGrain.column, "entityGrain.column");
      if (c && c.kind === "measure")
        issues.push(
          issue(
            "INVALID_PROPOSAL",
            "entityGrain.column",
            "An entity grain must be an identifier or time column.",
          ),
        );
    }
  } else if (p.entityGrain.column)
    issues.push(issue("INVALID_PROPOSAL", "entityGrain.column", "A global grain takes no column."));

  // aggregations: columns, arity, units
  const units = new Map<string, Unit>();
  const seen = new Set<string>();
  const aggTables = new Set<string>([base]);
  p.aggregations.forEach((a, i) => {
    const path = `aggregations[${i}]`;
    if (seen.has(a.id))
      issues.push(issue("AGGREGATION_INVALID", `${path}.id`, `Duplicate aggregation id "${a.id}".`));
    seen.add(a.id);
    let col: CatalogueColumn | null | undefined;
    if (a.fn === "count") {
      if (a.column !== null)
        issues.push(issue("AGGREGATION_INVALID", `${path}.column`, "count takes no column."));
      if (!a.table)
        issues.push(
          issue("AGGREGATION_INVALID", `${path}.table`, "count needs the table whose rows it counts."),
        );
      else if (!p.sources.includes(a.table))
        issues.push(
          issue("UNKNOWN_SOURCE", `${path}.table`, `Table "${a.table}" is used but not listed in sources.`),
        );
      else if (tableOf(a.table, `${path}.table`)) aggTables.add(a.table);
    } else if (a.table) {
      issues.push(issue("AGGREGATION_INVALID", `${path}.table`, "table is only for count."));
    } else if (a.column === null) {
      issues.push(issue("AGGREGATION_INVALID", `${path}.column`, `${a.fn} needs a column.`));
    } else {
      col = colOf(a.column, `${path}.column`);
      if (col && a.fn !== "count_distinct" && col.kind !== "measure")
        issues.push(
          issue("AGGREGATION_INVALID", `${path}.column`, `${a.fn} needs a numeric measure column.`),
        );
      if (col && a.fn !== "count_distinct" && col.kind === "measure" && col.unit === null)
        issues.push(
          issue(
            "UNIT_UNKNOWN",
            `${path}.column`,
            `Column "${key(a.column)}" has no declared unit; it cannot be ${a.fn}-aggregated.`,
          ),
        );
      aggTables.add(a.column.table);
    }
    const u = aggUnit(a, col ?? undefined);
    const parsedU = u ? parseUnit(u) : null;
    if (parsedU) units.set(a.id, parsedU);
  });

  // dimensions
  p.dimensions.forEach((d, i) => {
    const c = colOf(d, `dimensions[${i}]`);
    if (c && c.kind === "measure")
      issues.push(issue("DIMENSIONS_UNSUPPORTED", `dimensions[${i}]`, "A measure cannot be a dimension."));
    if (d.table !== base)
      issues.push(
        issue("DIMENSIONS_UNSUPPORTED", `dimensions[${i}]`, "Dimensions must come from the base table."),
      );
  });
  if (aggTables.size > 1 && p.dimensions.length)
    issues.push(
      issue(
        "DIMENSIONS_UNSUPPORTED",
        "dimensions",
        "Dimensions are supported only for single-table metrics.",
      ),
    );

  // filters
  p.filters.forEach((f, i) => {
    const path = `filters[${i}]`;
    const c = colOf(f.column, `${path}.column`);
    if (!c) return;
    if ((f.op === "is_null" || f.op === "not_null") && f.values.length)
      issues.push(issue("INVALID_PROPOSAL", `${path}.values`, `${f.op} takes no values.`));
    if (f.op !== "is_null" && f.op !== "not_null") {
      if (!f.values.length)
        issues.push(issue("INVALID_PROPOSAL", `${path}.values`, "At least one value is required."));
      if (f.op !== "in" && f.values.length > 1)
        issues.push(issue("INVALID_PROPOSAL", `${path}.values`, `${f.op} takes one value.`));
      const wantNum = c.kind === "measure";
      for (const v of f.values) {
        if (wantNum !== (typeof v === "number"))
          issues.push(
            issue(
              "INVALID_PROPOSAL",
              `${path}.values`,
              `${key(f.column)} needs ${wantNum ? "numeric" : "string"} values.`,
            ),
          );
        else if (c.kind === "time" && typeof v === "string" && !dayOk(v))
          issues.push(issue("INVALID_PROPOSAL", `${path}.values`, "Time filter values are YYYY-MM-DD days."));
      }
      if (f.op === "in" && c.decimalScale !== null)
        issues.push(issue("INVALID_PROPOSAL", `${path}.op`, "IN is not supported on decimal columns."));
      if (f.op !== "eq" && f.op !== "neq" && f.op !== "in" && c.kind === "dimension")
        issues.push(
          issue("INVALID_PROPOSAL", `${path}.op`, "Range operators need a numeric or time column."),
        );
    }
  });

  // joins: declared keys only, and they must connect every aggregated table to the base
  const adj = new Map<string, Set<string>>();
  p.joins.forEach((j, i) => {
    const path = `joins[${i}]`;
    colOf(j.left, `${path}.left`);
    colOf(j.right, `${path}.right`);
    const declared = cat.joins.some(
      (d) =>
        (key(d.left) === key(j.left) && key(d.right) === key(j.right)) ||
        (key(d.left) === key(j.right) && key(d.right) === key(j.left)),
    );
    if (!declared)
      issues.push(
        issue("JOIN_NOT_DECLARED", path, `Join ${key(j.left)} = ${key(j.right)} is not a declared key.`),
      );
    for (const [a, b] of [
      [j.left.table, j.right.table],
      [j.right.table, j.left.table],
    ] as const) {
      if (!adj.has(a)) adj.set(a, new Set());
      adj.get(a)?.add(b);
    }
  });
  const reach = new Set<string>([base]);
  for (const q = [base]; q.length;) {
    const t = q.pop() as string;
    for (const n of adj.get(t) ?? [])
      if (!reach.has(n)) {
        reach.add(n);
        q.push(n);
      }
  }
  for (const t of aggTables)
    if (!reach.has(t))
      issues.push(
        issue(
          "JOIN_NOT_DECLARED",
          "joins",
          `Table "${t}" is aggregated but no declared join connects it to "${base}".`,
        ),
      );
  const referenced = new Set<string>([
    base,
    ...aggTables,
    ...p.filters.map((f) => f.column.table),
    ...p.joins.flatMap((j) => [j.left.table, j.right.table]),
  ]);
  p.sources.forEach((s, i) => {
    if (!referenced.has(s))
      issues.push(issue("UNUSED_SOURCE", `sources[${i}]`, `Source "${s}" is listed but never used.`));
  });

  // dedup obligation per table
  for (const t of p.sources) {
    const tab = cat.tables[t];
    if (!tab) continue;
    if (tab.dedup === "final" && p.dedup.strategy !== "final")
      issues.push(
        issue(
          "DEDUP_REQUIRED",
          "dedup.strategy",
          `Table "${t}" is a ReplacingMergeTree: read it with strategy "final".`,
        ),
      );
    if (tab.dedup === "none" && p.dedup.strategy === "final")
      issues.push(
        issue(
          "DEDUP_REQUIRED",
          "dedup.strategy",
          `Table "${t}" has no versioned rows: declare "none_declared_unique".`,
        ),
      );
  }

  if (p.historicalValidity.validTo !== null && p.historicalValidity.validTo < p.historicalValidity.validFrom)
    issues.push(issue("INVALID_PROPOSAL", "historicalValidity", "validTo precedes validFrom."));
  if (!dayOk(p.historicalValidity.validFrom))
    issues.push(issue("INVALID_PROPOSAL", "historicalValidity.validFrom", "Not a valid day."));

  // formula and unit algebra
  let formula: MetricExpr | undefined = p.formula;
  if (!formula) {
    if (p.aggregations.length === 1)
      formula = { kind: "agg", id: (p.aggregations[0] as MetricAggregation).id };
    else
      issues.push(
        issue(
          "AGGREGATION_INVALID",
          "formula",
          "A formula is required when more than one aggregation is declared.",
        ),
      );
  }
  let derivedUnit: string | null = null;
  if (formula) {
    const used = new Set<string>();
    const u = evalUnit(formula, units, used, issues, "formula");
    if (u) {
      derivedUnit = formatUnit(u);
      const declared = normalizeUnit(p.unit);
      if (declared === null) issues.push(issue("UNIT_UNKNOWN", "unit", `Unparseable unit "${p.unit}".`));
      else if (declared !== derivedUnit)
        issues.push(
          issue(
            "UNIT_MISMATCH",
            "unit",
            `Declared unit "${p.unit}" does not match the derived unit "${derivedUnit}".`,
          ),
        );
    }
    for (const a of p.aggregations)
      if (!used.has(a.id))
        issues.push(
          issue("AGGREGATION_INVALID", "aggregations", `Aggregation "${a.id}" is never used by the formula.`),
        );
  }

  if (issues.length || !formula || derivedUnit === null) return { ok: false, issues };

  // build per-table blocks (base first); every table's time column is the join column that links it to base
  const timeColOf = (t: string): string | null => {
    if (t === base) return p.timeGrain.column.column;
    for (const j of p.joins) {
      if (j.left.table === t) return j.left.column;
      if (j.right.table === t) return j.right.column;
    }
    return null;
  };
  const blocks: CompiledTable[] = [];
  for (const t of [base, ...[...aggTables].filter((x) => x !== base)]) {
    const tab = cat.tables[t] as CatalogueTable;
    const tc = timeColOf(t);
    if (!tc || tab.columns[tc]?.kind !== "time") {
      issues.push(issue("TIME_COLUMN_INVALID", "joins", `No time-bucket key for table "${t}".`));
      continue;
    }
    blocks.push({
      table: t,
      database: tab.database,
      timeColumn: tc,
      timeIsDate: /^(Nullable\()?Date(\)|$)/.test(tab.columns[tc]?.chType ?? ""),
      final: tab.dedup === "final",
      aggs: p.aggregations.filter((a) => (a.column?.table ?? a.table ?? base) === t),
      filters: p.filters.filter((f) => f.column.table === t),
      dims: t === base ? p.dimensions.map((d) => d.column) : [],
      columns: tab.columns,
      provider: tab.provider,
      coverageDataset: tab.coverageDataset,
    });
  }
  if (issues.length) return { ok: false, issues };
  const fingerprint = createHash("sha256")
    .update(
      canonicalJson({
        tables: blocks.map((b) => ({
          t: b.table,
          tc: b.timeColumn,
          a: b.aggs,
          f: b.filters,
          d: b.dims,
          fin: b.final,
        })),
        grain: p.timeGrain.grain,
        formula,
        precision: p.precision,
        nullSemantics: p.nullSemantics,
        catalogue: cat.hash,
      }),
    )
    .digest("hex");
  return {
    ok: true,
    plan: { proposal: p, base, tables: blocks, formula, derivedUnit, fingerprint },
    issues: [],
  };
}
