"use client";
import {
  type Edge,
  type Node,
  type NodeProps,
  ReactFlow,
  Background,
  Handle,
  Position,
  applyNodeChanges,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelNotice } from "@nearesis/ui";
import type { GraphProjection } from "../lib/types.ts";
import { hooks } from "../lib/test-hooks.ts";

/** ch.26 typed research graph; ch.10 evidence relations. Anything else is reported, never rendered as valid (C16). */
export const NODE_TYPES = [
  "hypothesis",
  "observation",
  "query",
  "model",
  "source",
  "marker",
  "agent",
] as const;
export const EDGE_RELATIONS = [
  "supports",
  "contradicts",
  "derived_from",
  "monitors",
  "references",
  "reproduces",
  "supersedes",
] as const;

export interface ProjectionCheck {
  nodes: GraphProjection["nodes"];
  edges: GraphProjection["edges"];
  unresolved: Array<{ id: string; reason: string }>;
}

export function checkProjection(g: GraphProjection): ProjectionCheck {
  const unresolved: ProjectionCheck["unresolved"] = [];
  const nodes = g.nodes.filter((n) => {
    if ((NODE_TYPES as readonly string[]).includes(n.type)) return true;
    unresolved.push({ id: n.id, reason: `unregistered node type "${n.type}"` });
    return false;
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = g.edges.filter((e) => {
    if (!(EDGE_RELATIONS as readonly string[]).includes(e.relation)) {
      unresolved.push({ id: e.id, reason: `invalid relation "${e.relation}"` });
      return false;
    }
    if (!ids.has(e.source) || !ids.has(e.target)) {
      unresolved.push({ id: e.id, reason: "edge references a missing node" });
      return false;
    }
    return true;
  });
  return { nodes, edges, unresolved };
}

type GData = { label: string; kind: string };

const KIND_TONE: Record<string, string> = {
  hypothesis: "var(--s1)",
  observation: "var(--s3)",
  query: "var(--s6)",
  model: "var(--s5)",
  source: "var(--s6)",
  marker: "var(--marker)",
  agent: "var(--s4)",
};
/** Contradicts is the one relation that gets a hue; the rest differ by dash so the graph reads in greyscale. */
const REL_STYLE: Record<string, { stroke: string; dash?: string }> = {
  supports: { stroke: "var(--fg-subtle)" },
  contradicts: { stroke: "var(--bad)", dash: "5 3" },
  derived_from: { stroke: "var(--fg-subtle)", dash: "2 3" },
  monitors: { stroke: "var(--fg-subtle)", dash: "8 3" },
  references: { stroke: "var(--border-strong)" },
  reproduces: { stroke: "var(--ok)" },
  supersedes: { stroke: "var(--warn)", dash: "5 3" },
};

function TypedNode({ data, selected }: NodeProps<Node<GData>>) {
  return (
    <div
      className="nz-gnode"
      data-selected={selected ? "true" : undefined}
      style={{ ["--kind" as string]: KIND_TONE[data.kind] ?? "var(--fg-subtle)" }}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="nz-gnode-kind">{data.kind}</div>
      <div className="nz-gnode-label">{data.label}</div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}

const nodeTypes = Object.fromEntries(NODE_TYPES.map((t) => [t, TypedNode]));

export function EvidenceGraph({
  projection,
  onLayout,
}: {
  projection: GraphProjection;
  onLayout: (positions: Record<string, { x: number; y: number }>) => void;
}) {
  const checked = useMemo(() => {
    const c = checkProjection(projection);
    // References the server already omitted from the projection are reported alongside the client's own findings.
    const known = new Set(c.unresolved.map((u) => u.id));
    for (const u of projection.unresolved ?? [])
      if (!known.has(u.id)) c.unresolved.push({ id: u.id, reason: u.reason });
    return c;
  }, [projection]);
  const [nodes, setNodes] = useState<Node<GData>[]>([]);
  useEffect(() => {
    setNodes(
      checked.nodes.map((n, i) => ({
        id: n.id,
        type: n.type,
        position: n.position ?? { x: (i % 4) * 200, y: Math.floor(i / 4) * 120 },
        data: { label: n.label, kind: n.type },
        ariaLabel: `${n.type}: ${n.label}`,
        focusable: true,
        connectable: false,
      })),
    );
    for (const n of checked.nodes) hooks().instantiated.push(`graph:${n.type}`);
    hooks().graph = {
      rendered: checked.nodes.map((n) => n.id),
      edges: checked.edges.map((e) => e.id),
      unresolved: checked.unresolved,
    };
  }, [checked]);
  const edges: Edge[] = useMemo(
    () =>
      checked.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.relation,
        ariaLabel: `${e.relation} edge`,
        style: {
          stroke: (REL_STYLE[e.relation] ?? { stroke: "var(--fg-subtle)" }).stroke,
          strokeWidth: 1.25,
          strokeDasharray: REL_STYLE[e.relation]?.dash,
        },
        labelStyle: { fill: "var(--fg-muted)", fontSize: 10 },
        labelBgStyle: { fill: "var(--surface)" },
      })),
    [checked],
  );
  const onNodesChange = useCallback(
    (c: NodeChange<Node<GData>>[]) => setNodes((ns) => applyNodeChanges(c, ns)),
    [],
  );
  const onDragStop = useCallback(
    (_: unknown, _n: Node, dragged: Node[]) => {
      const pos: Record<string, { x: number; y: number }> = {};
      for (const n of dragged) pos[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      onLayout(pos);
    },
    [onLayout],
  );
  return (
    <>
      {checked.unresolved.length > 0 && (
        <PanelNotice tone="warn" role="status" data-testid="unresolved-references">
          {checked.unresolved.length} unresolved reference(s) not drawn:{" "}
          {checked.unresolved.map((u) => `${u.id} (${u.reason})`).join("; ")}
        </PanelNotice>
      )}
      <div className="nz-chart" style={{ top: checked.unresolved.length ? 40 : 0 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onDragStop}
          nodesConnectable={false}
          edgesReconnectable={false}
          elementsSelectable
          nodesFocusable
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} color="var(--grid)" />
        </ReactFlow>
      </div>
    </>
  );
}
