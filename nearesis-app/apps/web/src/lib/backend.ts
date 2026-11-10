import { CanvasDocument, type DomainEvent, type PatchOp } from "@nearesis/contracts";
import { applyCanvasPatch, applyOps, hashCanonical } from "@nearesis/canvas-schema";
import { connectSse, EventStore } from "./event-store.ts";
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

/**
 * Kernel backend: persistence, commands and events go through the kernel API (Engine A) via the same-origin BFF
 * proxy (/api/k). Panel data comes from /api/data (SYNTHETIC fixture results until the semantic route is wired).
 */
export class KernelBackend implements CanvasBackend {
  readonly mode = "kernel" as const;
  readonly sourceLabel = "SYNTHETIC" as const;
  private lastDoc: CanvasDocument | null = null;
  private positions: Record<string, { x: number; y: number }> = {};
  readonly store: EventStore;
  private listeners = new Set<(e: DomainEvent) => void>();
  onReload: (() => void) | null = null;

  constructor(readonly workspaceId: string) {
    this.store = new EventStore({
      onBatch: (evs) => evs.forEach((e) => this.listeners.forEach((l) => l(e))),
      onReloadRequired: () => this.onReload?.(),
    });
  }

  private api(path: string) {
    return `/api/k/workspaces/${this.workspaceId}${path}`;
  }

  async load(): Promise<unknown> {
    const r = await fetch(this.api("/canvas"), { cache: "no-store" });
    if (!r.ok) throw new Error(`canvas load failed: ${r.status}`);
    const raw = (await r.json()) as unknown;
    const parsed = CanvasDocument.safeParse(raw);
    this.lastDoc = parsed.success ? parsed.data : null;
    return raw;
  }

  async apply(ops: PatchOp[], expectedRevision: number): Promise<ApplyOutcome> {
    const ws = await fetch(this.api(""), { cache: "no-store" });
    if (!ws.ok) return { ok: false, status: ws.status, report: null, message: "workspace not accessible" };
    const { version } = (await ws.json()) as { version: number };
    const patch = {
      schemaVersion: 1,
      type: "workspace.patch",
      operationId: crypto.randomUUID(),
      expectedRevision,
      operations: ops,
    };
    // Inverse ops are computed with the same pure function the kernel runs inside its transaction.
    const local = this.lastDoc
      ? applyCanvasPatch(this.lastDoc, patch, { now: new Date().toISOString() })
      : null;
    const r = await fetch(this.api("/commands"), {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": String(version) },
      body: JSON.stringify({
        apiVersion: "v1",
        commandId: crypto.randomUUID(),
        commandType: "canvas.apply_patch",
        payload: patch,
        expectedVersion: version,
      }),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => ({}))) as {
        message?: string;
        reasonCode?: string;
        details?: Array<{ path: string; issue: string }>;
      };
      const report = local && !local.ok ? local : null;
      return {
        ok: false,
        status: r.status,
        report,
        message: `${body.reasonCode ?? ""} ${body.message ?? ""}`.trim(),
      };
    }
    const doc = await this.load();
    return { ok: true, document: doc, inverse: local && local.ok ? local.inverse : [] };
  }

  /** Data vintage requested from the data route (advanced by a source refresh; fixture route serves revisions). */
  vintage = 1;
  advanceVintage(): void {
    this.vintage += 1;
  }

  async fetchData(queryHash: string): Promise<PanelData | null> {
    const r = await fetch(`/api/data/${queryHash}?vintage=${this.vintage}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as PanelData) : null;
  }

  async graph(): Promise<GraphProjection | null> {
    return null; // evidence graph projection API not yet provided by the kernel (queued request)
  }

  async saveGraphLayout(positions: Record<string, { x: number; y: number }>): Promise<void> {
    this.positions = { ...this.positions, ...positions };
  }

  subscribe(onEvent: (e: DomainEvent) => void): () => void {
    this.listeners.add(onEvent);
    if (this.listeners.size === 1 && this.lastDoc) this.store.reset(0);
    const stop = connectSse(this.api("/events"), this.store);
    return () => {
      this.listeners.delete(onEvent);
      stop();
    };
  }
}

export function createBackend(search: URLSearchParams, workspaceId: string): CanvasBackend {
  if (search.get("backend") === "kernel" && /^[0-9a-f-]{36}$/.test(workspaceId))
    return new KernelBackend(workspaceId);
  return new FixtureBackend(search.get("scenario") ?? "baseline");
}
