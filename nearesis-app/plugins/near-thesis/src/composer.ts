/**
 * Reference natural-language canvas composer (ch.09 "Prompt -> canvas -> verified query contract").
 * The model only proposes a typed plan (certified member ids, grain, window, mark). Everything executable is derived
 * here: the SemanticQuery AST, the preview via `canvas.preview@1` (which runs the guarded gateway and the chart
 * compiler) and the resulting CanvasPatch. The model never emits SQL, JSX or a panel spec directly.
 * It is provider-agnostic (contracts `InferenceProvider`) and tool-agnostic (`invoke` = kernel ToolGateway call).
 */
import { z } from "zod";
import type { CanvasPatch, InferenceProvider } from "@nearesis/contracts";
import { hashCanonical } from "@nearesis/canvas-schema";

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
    .max(8), // zero panels = explicit abstention ("cannot compute"), ch.27
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
}

const SYSTEM = [
  "You compose research dashboards for NEAR Intents from a certified metric catalog.",
  "Return only the JSON plan. Use only metric ids listed in the catalog data. Never invent metrics, SQL or UI code.",
  "Choose each panel's from/to inside that metric's dataWindow (ISO 8601 UTC instants; to is exclusive, so use the day after the last day); never plan a window outside it or for a metric whose dataWindow is null.",
  "Plan exactly four panels for an investigation request when the catalog allows it, each with a distinct measure.",
  "If the catalog cannot answer the request, return zero panels and explain in rationale.",
].join(" ");

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
  const catalog = disc.metrics.map((m) => ({ id: m.id, unit: m.unit, dataWindow: windowOf(m) }));
  // The user request and catalog are data for the model, never instructions with authority (ch.12).
  const prompt = `<request instruction_authority="user">\n${args.prompt}\n</request>\n<catalog instruction_authority="none">\n${JSON.stringify(catalog)}\n</catalog>`;
  const gen = await args.provider.generateStructured({
    model: args.model,
    system: SYSTEM,
    prompt,
    schema: ComposerPlan,
    idempotencyKey: args.idempotencyKey,
    maxTokens: 2000,
  });
  const plan = ComposerPlan.parse(gen.output);
  if (!plan.panels.length)
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
  const requests = plan.panels.map((p, i) => {
    for (const m of p.measures)
      if (!byRef.has(m))
        issues.push({ code: "UNKNOWN_METRIC", message: `${m} is not in the certified catalog`, index: i });
    const measures = p.measures.map((m) => byRef.get(m)?.id ?? m);
    const cube = (byRef.get(p.measures[0]!)?.cubeMember ?? p.measures[0]!).split(".")[0]!;
    const timeField = `${cube}.day`;
    if (!dims.has(timeField))
      issues.push({ code: "NO_TIME_DIMENSION", message: `${timeField} not in catalog`, index: i });
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
  const prev = (await args.invoke("canvas.preview@1", {
    expectedRevision: args.expectedRevision,
    requests,
  })) as {
    ok: boolean;
    patch: CanvasPatch | null;
    issues: Array<{ index: number; code: string; message: string }>;
  };
  return prev.ok && prev.patch
    ? { status: "ok", plan, patch: prev.patch, issues: [], modelRequestId: gen.requestId }
    : { status: "rejected", plan, patch: null, issues: prev.issues, modelRequestId: gen.requestId };
}

/** Deterministic UUIDv4-shaped id from a seed, so a retried composition proposes the same panel ids. */
export function uuidFrom(seed: string): string {
  const h = hashCanonical(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
