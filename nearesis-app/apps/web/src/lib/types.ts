import type { ChartData, DomainEvent } from "@nearesis/contracts";
import type { PatchOp } from "@nearesis/contracts";
import type { PatchReport, QueryResultShape } from "@nearesis/canvas-schema";

export type SourceLabel = "SYNTHETIC" | "RECORDED" | "LIVE";

/** What the provenance inspector shows (C14b). Every field resolves to an exact query and snapshot. */
export interface PanelProvenance {
  queryHash: string;
  semanticVersion: string;
  semanticModelHash: string;
  sourceSnapshotId: string | null;
  rawManifestHash: string | null;
  certification: "certified" | "experimental" | "partial" | "stale";
  ast: unknown;
  sourceLabel: SourceLabel;
  /** sha256 of the canonical result rows; re-executing `ast` must reproduce it. */
  resultHash: string;
  sources: string[];
}

export interface PanelData {
  chart: ChartData;
  shape: QueryResultShape;
  provenance: PanelProvenance;
  gaps: Array<{ from: string; to: string; reason: string }>;
}

export type ApplyOutcome =
  | { ok: true; document: unknown; inverse: PatchOp[] }
  | { ok: false; status: number; report: PatchReport | null; message: string };

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  position?: { x: number; y: number };
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
}
export interface GraphProjection {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Edges the server could not resolve to persisted nodes (omitted from `edges`); shown, never drawn. */
  unresolved?: Array<{ id: string; reason: string; source?: string; target?: string; relation?: string }>;
}

/** Backend boundary: the kernel (HTTP, owned by Engine A) or the in-browser fixture backend. */
export interface CanvasBackend {
  readonly mode: "kernel" | "fixture";
  readonly sourceLabel: SourceLabel;
  /** Raw stored document. Untrusted: the client validates every panel before rendering (C09b). */
  load(): Promise<unknown>;
  apply(ops: PatchOp[], expectedRevision: number, kind: "patch" | "undo" | "redo"): Promise<ApplyOutcome>;
  fetchData(queryHash: string): Promise<PanelData | null>;
  graph(): Promise<GraphProjection | null>;
  saveGraphLayout(positions: Record<string, { x: number; y: number }>): Promise<void>;
  subscribe(onEvent: (e: DomainEvent) => void): () => void;
}
