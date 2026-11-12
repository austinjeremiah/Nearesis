/**
 * Reference natural-language canvas composer (ch.09 "Prompt -> canvas -> verified query contract").
 * The model only proposes a typed plan (certified member ids, grain, window, mark). Everything executable is derived
 * here: the SemanticQuery AST, the preview via `canvas.preview@1` (which runs the guarded gateway and the chart
 * compiler) and the resulting CanvasPatch. The model never emits SQL, JSX or a panel spec directly.
 * It is provider-agnostic (contracts `InferenceProvider`) and tool-agnostic (`invoke` = kernel ToolGateway call).
 */
import { z } from "zod";
import {
  ANALYSES_BY_CAPABILITY,
  AnalyticsCapabilityId,
  AnalyticsOutcome,
  INPUT_BY_CAPABILITY,
  type AnalyticsOkResult,
  type CanvasPatch,
  type InferenceProvider,
} from "@nearesis/contracts";
import { compileAnalyticsPanel, hashCanonical } from "@nearesis/canvas-schema";

/**
 * A request for an analytics-capability panel. The model names the capability, the analysis and flat typed parameters; the
 * composer validates them against the capability's own input schema, calls the tool through the kernel gateway and compiles the
 * returned typed table into a panel. The model never chooses encoding, SQL or data.
 */
export const AnalyticsAsk = z.strictObject({
  title: z.string().min(1).max(180),
  capability: AnalyticsCapabilityId,
  /**
   * The capability input as one JSON object string, e.g. {"analysis":"status","from":"2026-08-01","to":"2026-11-10","grain":"week"}.
   * A string keeps the schema the model must satisfy small (a wide object with many optional fields made the provider's
   * constrained decoding time out); the composer parses it and validates it against the capability's typed input.
   */
  input: z.string().min(2).max(600),
});
export type AnalyticsAsk = z.infer<typeof AnalyticsAsk>;

export const ComposerPlan = z.strictObject({
  panels: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(180),
        mark: z.enum(["line", "area", "bar"]),
        measures: z.array(z.string()).min(1).max(2),
        grain: z.enum(["day", "week"]),
        from: z.iso.datetime({ offset: true }),
        to: z.iso.datetime({ offset: true }),
        unitStrategy: z.enum(["single", "index_100", "dual_axis_disclosed"]).optional(),
      }),
    )
    .max(8), // zero panels in both lists = explicit abstention ("cannot compute"), ch.27
  /** Panels backed by the analytics capabilities (intents, entities, accounts), for requests the certified catalog cannot answer. */
  analyticsPanels: z.array(AnalyticsAsk).max(6).default([]),
  rationale: z.string().max(2000),
});
export type ComposerPlan = z.infer<typeof ComposerPlan>;

export type Invoke = (capability: string, input: unknown) => Promise<unknown>;

export interface ComposeResult {
  status: "ok" | "cannot_compute" | "rejected";
  plan: ComposerPlan | null;
  patch: CanvasPatch | null;
  issues: Array<{ code: string; message: string; index?: number }>;
  modelRequestId: string | null;
  /** Outcome of every analytics-capability call (panel built, typed CANNOT_COMPUTE, refused input), for the proposal's provenance. */
  analytics?: AnalyticsCall[];
}
export interface AnalyticsCall {
  title: string;
  capability: string;
  analysis: string;
  outcome: "OK" | "CANNOT_COMPUTE" | "REFUSED" | "FAILED";
  callHash: string | null;
  panelId: string | null;
  coverage: string | null;
  /** CANNOT_COMPUTE: the fields or sources that are absent; REFUSED/FAILED: the reason. */
  missing: string[];
}

const SYSTEM = [
  "You compose research dashboards for NEAR Intents from a certified metric catalog.",
  "Return only the JSON plan. Use only metric ids listed in the catalog data. Never invent metrics, SQL or UI code.",
  "Choose each panel's from/to inside that metric's dataWindow (ISO 8601 UTC instants; to is exclusive, so use the day after the last day); never plan a window outside it or for a metric whose dataWindow is null.",
  "A panel's measures must all come from ONE view (the catalog's `view` field); a semantic query cannot span views. To compare metrics of different views, plan one panel per view.",
  "Plan exactly four panels for an investigation request when the catalog allows it, each with a distinct measure.",
  "Analytics tools: when the certified catalog has no metric for the request (for example refunds or swap status, chain flows, concentration, unusual flows, entity or account activity), plan analyticsPanels instead of abstaining. These are analytics results computed from source tables, not certified metrics. Use only the capabilities and analyses listed in <analytics_tools>, give dates as YYYY-MM-DD inside the analytics data window, and never plan an analysis marked CANNOT_COMPUTE.",
  "Plan at most six analyticsPanels, each with a distinct analysis or parameter set. For a question about change over weeks, use grain week or granularity week.",
  "If neither the certified catalog nor the analytics tools can answer the request, return zero panels in both lists and explain in rationale.",
].join(" ");

/** What the model may ask of each analytics capability (kept in step with the capability input schemas by a test). */
export const ANALYTICS_TOOLS = `intents.analyze@1: NEAR Intents swaps from the Explorer. analyses: status{grain:none|day|week}; trend{granularity:day|week|month, emphasis:swaps|refunds|refund_rate|volume}; refund_rates{by:chain_pair|asset_pair, top}; refund_causes{by:reason|week|day|chain_pair}; chain_flows{view:matrix|net}; concentration{dimension:origin_asset|destination_asset|origin_chain|destination_chain|chain_pair, measure:volume|count, top}; unusual_flows{baselineDays, recentDays}; summary; coverage. window: from,to (YYYY-MM-DD) or days (1 to 366). settlement_duration and solver_metrics are always CANNOT_COMPUTE (do not plan them).
entities.analyze@1: ecosystem entities. analyses: changes{days, limit, type} ranked period-over-period interactions with unique signer change; metrics{entityId, from, to}; coverage{from,to|days}; unique_signers{entityId, from,to|days}; search{q, type, limit}.
accounts.analyze@1: accounts (not people). analyses: daily{from,to|days} active, new, returning; growth{days, to}; retention; concentration{from,to|days}; coverage.
Each analytics panel is {title, capability, input} where input is ONE JSON object string with "analysis" plus the parameters above, for example {"analysis":"status","from":"2026-08-01","to":"2026-11-10","grain":"week"}. Use no other keys.`;

interface CatalogMetric {
  id: string;
  cubeMember: string;
  unit: string;
  visibility: string;
  sources?: string[];
}

/** Marker set by the kernel's `guardInference` (kept as a registry symbol so the plugin needs no kernel import). */
const GUARDED = Symbol.for("nearesis.guardedInference");

export async function composeCanvas(args: {
  prompt: string;
  provider: InferenceProvider;
  model: string;
  invoke: Invoke;
  expectedRevision: number;
  idempotencyKey: string;
}): Promise<ComposeResult> {
  // FND-073: the composer never calls a model through a provider that has not passed the classification guard.
  if ((args.provider as unknown as Record<symbol, unknown>)[GUARDED] !== true)
    throw new Error("UNGUARDED_INFERENCE_PROVIDER: wrap the provider with guardInference before composing");
  const disc = (await args.invoke("semantic.discover@1", {})) as {
    ok: boolean;
    semanticVersion: string;
    metrics: CatalogMetric[];
    dimensions: Array<{ id?: string; member?: string }>;
    /** Observed first/last day per dataset (null = no rows); absent from older plugin versions. */
    dataWindows?: Record<string, { from: string; to: string } | null>;
    /** Observed windows of the analytics warehouse (null = nothing loaded); absent from older plugin versions. */
    analyticsWindows?: Record<string, { from: string; to: string } | null>;
  };
  if (!disc.ok)
    return {
      status: "cannot_compute",
      plan: null,
      patch: null,
      issues: [{ code: "CATALOG_UNAVAILABLE", message: "semantic catalog unavailable" }],
      modelRequestId: null,
    };
  const windowOf = (m: CatalogMetric) => {
    const ws = (m.sources ?? []).map((s) => disc.dataWindows?.[s.split(":")[1] ?? s] ?? null);
    const have = ws.filter((w): w is { from: string; to: string } => !!w);
    if (!disc.dataWindows) return undefined;
    return have.length
      ? {
          from: have.map((w) => w.from).sort()[0]!,
          to: have
            .map((w) => w.to)
            .sort()
            .at(-1)!,
        }
      : null;
  };
  // `dataWindow` is the observed first/last UTC day with data (null = no data); plan windows must lie inside it.
  const catalog = disc.metrics.map((m) => ({
    id: m.id,
    view: m.cubeMember.split(".")[0],
    unit: m.unit,
    dataWindow: windowOf(m),
  }));
  // The user request and catalog are data for the model, never instructions with authority (ch.12).
  const prompt = `<request instruction_authority="user">\n${args.prompt}\n</request>\n<catalog instruction_authority="none">\n${JSON.stringify(catalog)}\n</catalog>\n<analytics_tools instruction_authority="none">\n${ANALYTICS_TOOLS}\nanalytics data windows (UTC days): ${JSON.stringify(disc.analyticsWindows ?? null)}\n</analytics_tools>`;
  const gen = await args.provider.generateStructured({
    model: args.model,
    system: SYSTEM,
    prompt,
    schema: ComposerPlan,
    idempotencyKey: args.idempotencyKey,
    maxTokens: 2500,
  });
  const plan = ComposerPlan.parse(gen.output);
  if (!plan.panels.length && !plan.analyticsPanels.length)
    return {
      status: "cannot_compute",
      plan,
      patch: null,
      issues: [{ code: "CANNOT_COMPUTE", message: plan.rationale }],
      modelRequestId: gen.requestId,
    };

  // The semantic gateway addresses measures by metric id; a cube member is accepted and normalised to its id.
  const byRef = new Map<string, CatalogMetric>();
  for (const m of disc.metrics) {
    byRef.set(m.cubeMember, m);
    byRef.set(m.id, m);
  }
  const dims = new Set(disc.dimensions.map((d) => d.id ?? d.member ?? ""));
  const issues: ComposeResult["issues"] = [];
  // A semantic query is limited to ONE view. A plan panel whose measures come from several views is split into one panel
  // per view (validation is unchanged: the gateway still rejects any query that spans views).
  const viewOf = (ref: string) => (byRef.get(ref)?.cubeMember ?? ref).split(".")[0]!;
  const expanded = plan.panels.flatMap((p, planIdx) => {
    const views = [...new Set(p.measures.map(viewOf))];
    if (views.length <= 1) return [{ p, planIdx }];
    return views.map((v) => ({
      p: {
        ...p,
        title: `${p.title} (${v.replace(/_live$/, "").replace(/_/g, " ")})`.slice(0, 180),
        measures: p.measures.filter((m) => viewOf(m) === v),
      },
      planIdx,
    }));
  });
  const requests = expanded.map(({ p, planIdx }, i) => {
    for (const m of p.measures)
      if (!byRef.has(m))
        issues.push({
          code: "UNKNOWN_METRIC",
          message: `${m} is not in the certified catalog`,
          index: planIdx,
        });
    const measures = p.measures.map((m) => byRef.get(m)?.id ?? m);
    const cube = viewOf(p.measures[0]!);
    const timeField = `${cube}.day`;
    if (!dims.has(timeField))
      issues.push({ code: "NO_TIME_DIMENSION", message: `${timeField} not in catalog`, index: planIdx });
    const panelId = uuidFrom(`${args.idempotencyKey}:${i}`);
    return {
      panelId,
      title: p.title,
      mark: p.mark,
      query: {
        semanticVersion: disc.semanticVersion,
        measures,
        dimensions: [],
        time: { field: timeField, from: p.from, to: p.to, grain: p.grain },
        filters: [],
        order: [],
        limit: 10000,
      },
      x: timeField,
      y: measures,
      ...(p.unitStrategy ? { unitStrategy: p.unitStrategy } : {}),
      layout: { x: (i % 2) * 6, y: Math.floor(i / 2) * 6, w: 6, h: 6 },
    };
  });
  if (issues.length) return { status: "rejected", plan, patch: null, issues, modelRequestId: gen.requestId };

  // Analytics asks: validated against each capability's own typed input, then all tool calls (and the Cube preview) run
  // concurrently; nothing here depends on the order they finish in.
  const cubeCount = requests.length;
  const asks = plan.analyticsPanels.map((ask, j) => ({ ask, j, input: analyticsInput(ask) }));
  const [prev, analytics] = await Promise.all([
    requests.length
      ? (args.invoke("canvas.preview@1", { expectedRevision: args.expectedRevision, requests }) as Promise<{
          ok: boolean;
          patch: CanvasPatch | null;
          issues: Array<{ index: number; code: string; message: string }>;
        }>)
      : Promise.resolve(null),
    Promise.all(
      asks.map(async ({ ask, j, input }): Promise<{ call: AnalyticsCall; ok: AnalyticsOkResult | null }> => {
        const call: AnalyticsCall = {
          title: ask.title,
          capability: ask.capability,
          analysis: input.ok ? String(input.value.analysis) : "unknown",
          outcome: "REFUSED",
          callHash: null,
          panelId: null,
          coverage: null,
          missing: [],
        };
        if (!input.ok) return { call: { ...call, missing: [input.message] }, ok: null };
        let payload: unknown;
        try {
          payload = await args.invoke(ask.capability, input.value);
        } catch (e) {
          // a missing grant is a configuration fault that must stay visible, never a silent abstention
          if (/TOOL_NOT_GRANTED/.test(String((e as Error).message))) throw e;
          return {
            call: { ...call, outcome: "FAILED", missing: [String((e as Error).message).slice(0, 200)] },
            ok: null,
          };
        }
        const { ok: transport, ...rest } = (payload ?? {}) as Record<string, unknown>;
        if (transport !== true) {
          const err = (rest as { error?: { reasonCode?: string; message?: string } }).error;
          return {
            call: {
              ...call,
              outcome: "REFUSED",
              missing: [`${err?.reasonCode ?? "REFUSED"}: ${err?.message ?? "refused"}`.slice(0, 300)],
            },
            ok: null,
          };
        }
        const out = AnalyticsOutcome.safeParse(rest);
        if (!out.success)
          return {
            call: {
              ...call,
              outcome: "FAILED",
              missing: ["result did not match the typed analytics outcome"],
            },
            ok: null,
          };
        const o = out.data;
        const base = { ...call, callHash: o.callHash, coverage: o.coverage.state };
        if (o.outcome === "CANNOT_COMPUTE")
          return { call: { ...base, outcome: "CANNOT_COMPUTE", missing: o.missing }, ok: null };
        return { call: { ...base, outcome: "OK", panelId: uuidFrom(`${args.idempotencyKey}:a${j}`) }, ok: o };
      }),
    ),
  ]);
  if (prev && !(prev.ok && prev.patch))
    return {
      status: "rejected",
      plan,
      patch: null,
      issues: prev.issues,
      modelRequestId: gen.requestId,
      analytics: analytics.map((a) => a.call),
    };

  const issues2: ComposeResult["issues"] = [];
  const analyticsOps: Array<{ op: "addPanel"; panel: unknown }> = [];
  for (const [j, a] of analytics.entries()) {
    if (!a.ok) {
      issues2.push({
        code: a.call.outcome === "CANNOT_COMPUTE" ? "CANNOT_COMPUTE" : "ANALYTICS_UNAVAILABLE",
        message: `${a.call.title}: ${a.call.missing.join("; ") || a.call.outcome}`.slice(0, 400),
        index: cubeCount + j,
      });
      continue;
    }
    const i = cubeCount + analyticsOps.length;
    const c = compileAnalyticsPanel(a.ok, {
      panelId: a.call.panelId!,
      title: asks[j]!.ask.title,
      layout: { x: (i % 2) * 6, y: Math.floor(i / 2) * 6, w: 6, h: 6 },
    });
    if (!c.ok) {
      a.call.outcome = "REFUSED";
      a.call.panelId = null;
      for (const x of c.issues)
        issues2.push({
          code: x.code,
          message: `${asks[j]!.ask.title}: ${x.message}`.slice(0, 400),
          index: cubeCount + j,
        });
      continue;
    }
    analyticsOps.push({ op: "addPanel", panel: c.value.panel });
  }
  const calls = analytics.map((a) => a.call);
  const operations = [...(prev?.patch?.operations ?? []), ...analyticsOps] as CanvasPatch["operations"];
  if (!operations.length)
    return {
      status: "cannot_compute",
      plan,
      patch: null,
      issues: issues2.length ? issues2 : [{ code: "CANNOT_COMPUTE", message: plan.rationale }],
      modelRequestId: gen.requestId,
      analytics: calls,
    };
  const patch: CanvasPatch = prev?.patch
    ? { ...prev.patch, operations }
    : {
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: uuidFrom(`${args.idempotencyKey}:patch`),
        expectedRevision: args.expectedRevision,
        operations,
      };
  // Skipped analytics asks stay visible in `issues`; the status is ok because the proposal still carries verified panels.
  return { status: "ok", plan, patch, issues: issues2, modelRequestId: gen.requestId, analytics: calls };
}

/** The model's JSON string -> the capability's typed input. Unknown keys and out-of-range values are refused, never coerced. */
function analyticsInput(
  ask: AnalyticsAsk,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(ask.input);
  } catch {
    return { ok: false, message: "input is not valid JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, message: "input must be a JSON object" };
  const obj = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null && v !== undefined));
  const analysis = String(obj.analysis ?? "");
  if (!(ANALYSES_BY_CAPABILITY[ask.capability] as readonly string[]).includes(analysis))
    return { ok: false, message: `${analysis || "(none)"} is not an analysis of ${ask.capability}` };
  const r = INPUT_BY_CAPABILITY[ask.capability].safeParse(obj);
  return r.success
    ? { ok: true, value: obj }
    : {
        ok: false,
        message: r.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
          .join("; "),
      };
}

/** Deterministic UUIDv4-shaped id from a seed, so a retried composition proposes the same panel ids. */
export function uuidFrom(seed: string): string {
  const h = hashCanonical(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
