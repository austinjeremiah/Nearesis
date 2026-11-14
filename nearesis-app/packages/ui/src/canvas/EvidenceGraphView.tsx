import {
  Background,
  Handle,
  type Edge,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  applyNodeChanges,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useMemo, useState } from "react";

export interface GraphViewNode {
  id: string;
  type: string;
  label: string;
  position?: { x: number; y: number };
}
export interface GraphViewEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
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
const nodeTypes = { typed: TypedNode };

/** Columns by kind when the server has no stored position: sources and queries left, claims centre, agents right. */
const COLUMN: Record<string, number> = {
  source: 0,
  query: 1,
  model: 1,
  observation: 2,
  hypothesis: 3,
  marker: 3,
  agent: 4,
};

export function EvidenceGraphView({
  nodes,
  edges,
  onLayout,
}: {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  onLayout?: (p: Record<string, { x: number; y: number }>) => void;
}) {
  const initial = useMemo<Node<GData>[]>(() => {
    const rowByCol = new Map<number, number>();
    return nodes.map((n) => {
      const col = COLUMN[n.type] ?? 2;
      const row = rowByCol.get(col) ?? 0;
      rowByCol.set(col, row + 1);
      return {
        id: n.id,
        type: "typed",
        position: n.position ?? { x: col * 200, y: row * 90 },
        data: { label: n.label, kind: n.type },
      };
    });
  }, [nodes]);
  const [rf, setRf] = useState(initial);
  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => {
        const s = REL_STYLE[e.relation] ?? { stroke: "var(--fg-subtle)" };
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.relation.replace("_", " "),
          style: { stroke: s.stroke, strokeWidth: 1.25, strokeDasharray: s.dash },
          labelStyle: { fill: "var(--fg-muted)", fontSize: 10 },
          labelBgStyle: { fill: "var(--surface)" },
        };
      }),
    [edges],
  );
  const onChange = useCallback(
    (c: NodeChange[]) => setRf((cur) => applyNodeChanges(c, cur) as Node<GData>[]),
    [],
  );
  return (
    <div className="nz-chart" data-testid="evidence-graph">
      <ReactFlow
        nodes={rf}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onChange}
        onNodeDragStop={() =>
          onLayout?.(Object.fromEntries(rf.map((n) => [n.id, { x: n.position.x, y: n.position.y }])))
        }
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesConnectable={false}
        minZoom={0.3}
      >
        <Background gap={20} color="var(--grid)" />
      </ReactFlow>
    </div>
  );
}
