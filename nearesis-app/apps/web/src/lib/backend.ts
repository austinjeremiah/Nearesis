import { CanvasDocument, type DomainEvent, type PatchOp } from "@nearesis/contracts";
import { applyOps, hashCanonical } from "@nearesis/canvas-schema";
import { loadScenario, type Scenario } from "../fixtures/scenarios.ts";
import type { ApplyOutcome, CanvasBackend, GraphProjection, PanelData } from "./types.ts";

/**
 * In-browser fixture backend. SYNTHETIC data only; it exists so the canvas can be developed and its renderer-level
 * behaviour tested without the kernel. Persistence-dependent acceptance tests (C04, C05, C06, C11, C12, C13, C15,
 * C16 layout) are NOT recorded against it; they need the kernel backend.
 */
export class FixtureBackend implements CanvasBackend {
  readonly mode = "fixture" as const;
  readonly sourceLabel = "SYNTHETIC" as const;
  private scenario: Scenario;
  private doc: unknown;
  private listeners = new Set<(e: DomainEvent) => void>();
  private seq = 0;
  private positions: Record<string, { x: number; y: number }> = {};

  constructor(scenarioId: string) {
    this.scenario = loadScenario(scenarioId);
    this.doc = structuredClone(this.scenario.document);
  }

  async load(): Promise<unknown> {
    return structuredClone(this.doc);
  }

  async apply(ops: PatchOp[], expectedRevision: number): Promise<ApplyOutcome> {
    const parsed = CanvasDocument.safeParse(this.doc);
    if (!parsed.success)
      return { ok: false, status: 409, report: null, message: "stored document is corrupted; reload" };
    const r = applyOps(parsed.data, ops, { now: new Date().toISOString(), expectedRevision });
    if (!r.ok) {
      const stale = r.issues.some((i) => i.code === "STALE_REVISION");
      return {
        ok: false,
        status: stale ? 409 : 422,
        report: r,
        message: stale ? "stale revision" : "invalid patch",
      };
    }
    this.doc = r.document;
    this.emit({
      type: "canvas.patched",
      sourceRevision: r.document.documentRevision,
      data: { opCount: ops.length },
    });
    return { ok: true, document: structuredClone(r.document), inverse: r.inverse };
  }

  private failing = new Set<string>();
  private refreshCount = 0;

  async fetchData(queryHash: string): Promise<PanelData | null> {
    if (this.failing.has(queryHash))
      throw Object.assign(new Error("query failed (injected)"), { code: "QUERY_FAILED" });
    const d = this.scenario.data[queryHash];
    if (!d) return null;
    const out = structuredClone(d);
    // A refresh is a new data vintage: same query, revised data revision (fixture: watermark advances).
    if (this.refreshCount) out.chart.dataRevision = d.chart.dataRevision + this.refreshCount;
    return out;
  }

  /** Test hooks (fixture mode only): make a query fail, or advance the data vintage. */
  failQuery(queryHash: string, fail: boolean): void {
    if (fail) this.failing.add(queryHash);
    else this.failing.delete(queryHash);
  }
  advanceVintage(): void {
    this.refreshCount += 1;
  }

  async graph(): Promise<GraphProjection | null> {
    const g = this.scenario.graph;
    if (!g) return null;
    return {
      nodes: g.nodes.map((n) => ({ ...n, position: this.positions[n.id] ?? n.position })),
      edges: g.edges.map((e) => ({ ...e })),
    };
  }

  async saveGraphLayout(positions: Record<string, { x: number; y: number }>): Promise<void> {
    this.positions = { ...this.positions, ...positions };
  }

  subscribe(onEvent: (e: DomainEvent) => void): () => void {
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }

  /** Test hook: simulate a source watermark transition or data refresh (fixture mode only). */
  injectEvent(type: DomainEvent["type"], data: Record<string, unknown>): void {
    this.emit({ type, sourceRevision: null, data });
  }

  private emit(e: {
    type: DomainEvent["type"];
    sourceRevision: number | null;
    data: Record<string, unknown>;
  }) {
    this.seq += 1;
    const ev: DomainEvent = {
      eventId: `00000000-0000-4000-8000-${this.seq.toString(16).padStart(12, "0")}`,
      orgId: "00000000-0000-4000-8000-00000000aaaa",
      workspaceId: "00000000-0000-4000-8000-000000002332",
      seq: this.seq,
      type: e.type,
      causationId: null,
      correlationId: null,
      actorId: null,
      emittedAt: new Date().toISOString(),
      schemaVersion: 1,
      payloadHash: hashCanonical(e.data),
      sourceRevision: e.sourceRevision,
      data: e.data,
    };
    for (const l of this.listeners) l(ev);
  }
}

export function createBackend(search: URLSearchParams): CanvasBackend {
  // The kernel backend is wired once Engine A's canvas.apply_patch / SSE endpoints are integration-ready.
  return new FixtureBackend(search.get("scenario") ?? "baseline");
}
