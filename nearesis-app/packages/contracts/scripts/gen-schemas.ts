import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import * as C from "../src/index.ts";

/** Emits JSON Schema (draft 2020-12) for non-TS consumers (Python workers, monitor validation). */
export const EXPORTED = {
  ErrorResponse: C.ErrorResponse,
  PluginManifest: C.PluginManifest,
  ExecutionRequest: C.ExecutionRequest,
  ExecutionResponse: C.ExecutionResponse,
  RawObservation: C.RawObservation,
  AssetAlias: C.AssetAlias,
  ContractRegistryEntry: C.ContractRegistryEntry,
  QuoteAttempt: C.QuoteAttempt,
  SourceWatermark: C.SourceWatermark,
  SemanticQuery: C.SemanticQuery,
  MetricMetadata: C.MetricMetadata,
  MetricProposal: C.MetricProposal,
  DataFrameEnvelope: C.DataFrameEnvelope,
  ResearchFinding: C.ResearchFinding,
  AgentTask: C.AgentTask,
  RunFailure: C.RunFailure,
  DomainEvent: C.DomainEvent,
  PanelSpec: C.PanelSpec,
  CanvasDocument: C.CanvasDocument,
  CanvasPatch: C.CanvasPatch,
  Selection: C.Selection,
  ChartData: C.ChartData,
  WorkspaceCommand: C.WorkspaceCommand,
  AgentRecord: C.AgentRecord,
  EngineStatus: C.EngineStatus,
  TaskBoard: C.TaskBoard,
  CoordinationEvent: C.CoordinationEvent,
  TestResult: C.TestResult,
  GraphProjection: C.GraphProjection,
  SaveGraphLayoutPayload: C.SaveGraphLayoutPayload,
} as const;

export function toSchemas(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(EXPORTED).map(([k, v]) => [
      k,
      z.toJSONSchema(v as z.ZodType, { io: "input", unrepresentable: "any" }),
    ]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "generated");
  mkdirSync(out, { recursive: true });
  for (const [name, schema] of Object.entries(toSchemas()))
    writeFileSync(join(out, `${name}.schema.json`), JSON.stringify(schema, null, 2) + "\n");
  console.log(`wrote ${Object.keys(EXPORTED).length} schemas to ${out}`);
}
