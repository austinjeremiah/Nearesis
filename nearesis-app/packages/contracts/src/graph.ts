import { z } from "zod";
import { Uuid } from "./common.ts";
import { EvidenceRelation } from "./research.ts";

/** Evidence/agent graph projection (ch.10, 16a C16). Served by `GET /v1/workspaces/:id/graph`. */
export const GraphNodeType = z.enum([
  "hypothesis",
  "observation",
  "query",
  "model",
  "source",
  "marker",
  "agent",
  "statistical_result",
  "claim",
  "verification_artifact",
]);
export type GraphNodeType = z.infer<typeof GraphNodeType>;

export const GraphNode = z.strictObject({
  id: z.string().min(1),
  type: GraphNodeType,
  label: z.string().max(500),
  position: z.strictObject({ x: z.number(), y: z.number() }).optional(),
  /** Query nodes (canvas panels) carry the query hash the panel renders. */
  queryRef: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  /** v1.5.0 (additive). Claims: whether a supporting evidence path exists. Absent on other node kinds. */
  support: z.enum(["supported", "unsupported", "contradicted"]).optional(),
  /** v1.5.0 (additive). A semantic-version change flagged this node for revalidation. */
  recheckRequired: z.boolean().optional(),
  /** v1.5.0 (additive). Explicit tombstone for a removed/unresolvable endpoint. */
  tombstone: z.boolean().optional(),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.strictObject({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  relation: EvidenceRelation,
  origin: z.enum(["stored", "derived"]),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const GraphUnresolved = z.strictObject({
  id: z.string(),
  reason: z.string(),
  source: z.string(),
  target: z.string(),
  relation: z.string(),
  missing: z.array(z.enum(["source", "target"])),
});

export const GraphProjection = z.strictObject({
  workspaceId: Uuid,
  version: z.number().int().nonnegative(),
  nodes: z.array(GraphNode).max(20000),
  edges: z.array(GraphEdge).max(50000),
  /** Edges whose endpoint is not a persisted node; omitted from `edges`. */
  unresolved: z.array(GraphUnresolved),
});
export type GraphProjection = z.infer<typeof GraphProjection>;

/** Payload of the `graph.save_layout` workspace command. */
export const SaveGraphLayoutPayload = z.strictObject({
  positions: z.record(z.string().min(1), z.strictObject({ x: z.number(), y: z.number() })),
});
