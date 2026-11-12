import { z } from "zod";
import type { InterpretedFinding } from "@nearesis/contracts";

export type Cell = string | number | boolean | null;

/** What the analyst reads: one panel's executed result (through the gateway), with the envelope facts a reader must see. */
export interface PanelResult {
  panelId: string;
  title: string;
  queryHash: string;
  semanticVersion: string;
  columns: Array<{
    name: string;
    type: "time" | "string" | "number" | "decimal" | "boolean";
    unit: string | null;
  }>;
  rows: Cell[][];
  certification: "certified" | "experimental" | "partial" | "stale";
  nullCount: number;
  partialCount: number;
  gaps: Array<{ from: string; to: string; reason: string }>;
  sourceWatermarks: Record<string, string | null>;
  truncated: boolean;
  /** Panel completeness as the composer recorded it. */
  completeness: "complete" | "partial" | "unavailable";
}

const Ref = z.strictObject({
  panelId: z.string().min(1).max(80),
  column: z.string().min(1).max(80),
  /** zero-based index into that panel's rows, as shown in the digest */
  row: z.number().int().min(0).max(1_000_000),
});
export type CellRef = z.infer<typeof Ref>;

export const DraftFact = z.strictObject({
  /** The number exactly as written in the statement (e.g. "1,234", "12.5%", "0.31"). */
  value: z.string().min(1).max(40),
  unit: z.string().max(40),
  /** A cell read as-is, or a deterministic derivation over cells; the runtime recomputes derived values. */
  op: z.enum(["cell", "pct_change", "difference", "ratio", "mean", "max", "min", "sum"]),
  /** cell: one ref. pct_change/difference/ratio: [from, to] (ratio = first / second). mean/max/min/sum: 2..60 refs. */
  of: z.array(Ref).min(1).max(60),
});
export type DraftFact = z.infer<typeof DraftFact>;

export const DraftFinding = z.strictObject({
  kind: z.enum(["trend", "change", "comparison", "spike", "coverage", "other"]),
  basis: z.enum(["observation", "inference"]),
  status: z.enum(["supported", "mixed", "insufficient_data", "cannot_compute"]),
  statement: z.string().min(1).max(1500),
  facts: z.array(DraftFact).max(24),
  limitations: z.array(z.string().min(1).max(400)).max(8),
});
export type DraftFinding = z.infer<typeof DraftFinding>;

export const AnalystDraft = z.strictObject({ findings: z.array(DraftFinding).max(6) });
export type AnalystDraft = z.infer<typeof AnalystDraft>;

export const SkepticNote = z.strictObject({
  findingIndex: z.number().int().min(0).max(20),
  alternativeExplanations: z.array(z.string().min(1).max(400)).max(4),
  selectionEffects: z.array(z.string().min(1).max(400)).max(3),
  coverageCaveats: z.array(z.string().min(1).max(400)).max(3),
  verdict: z.enum(["holds", "weakened", "unsupported"]),
});
export type SkepticNote = z.infer<typeof SkepticNote>;
export const SkepticDraft = z.strictObject({ notes: z.array(SkepticNote).max(20) });
export type SkepticDraft = z.infer<typeof SkepticDraft>;

/** The one thing the stage needs from the model layer; `LedgerInference` satisfies it. */
export interface InterpretationModel {
  generate<T>(a: {
    key: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    maxTokens?: number;
  }): Promise<T>;
}

export interface RejectedFinding {
  statement: string;
  reasonCode: "UNGROUNDED_NUMBER" | "GUARD_VIOLATION" | "BAD_REFERENCE" | "NO_FACTS";
  detail: string;
}

export type InterpretationOutcome =
  | { state: "ready"; reason: null; findings: InterpretedFinding[]; rejected: RejectedFinding[] }
  | { state: "unavailable"; reason: string; findings: []; rejected: RejectedFinding[] }
  | { state: "none"; reason: string; findings: []; rejected: [] };
