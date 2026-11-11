"use client";
import "../../lib/zod-config.ts"; // jitless zod: no eval probe under the strict CSP
import {
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  applyNodeChanges,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode, GraphProjection } from "@nearesis/contracts";
import { Badge, EmptyState, HonestyBanner } from "@nearesis/ui";
import { ApiError, evidenceApi, getJson, historyApi, mutate, saveLayout } from "../history/client.ts";
import {
  applyFilter,
  autoLayout,
  type GraphFilter,
  missingProvenance,
  NODE_KINDS,
  type NodeState,
  nodeState,
  projectionFromObjects,
  RELATIONS,
  secondaryFlags,
  STATE_LABEL,
  upstream,
} from "./graph-model.ts";
import e from "./evidence.module.css";
import { EvidenceRecord, ImpactPanel, PublicationPanel } from "./Panels.tsx";

type Mode = { kind: "current" } | { kind: "snapshot"; id: string } | { kind: "branch"; id: string };
interface Vintage {
  label: string;
  capturedAt: string;
  stale: boolean;
  currentDocumentRevision: number;
  integrityOk: boolean;
  dataVintage: {
    documentRevision: number;
    dataRevision: number;
    eventSeq: number;
    workspaceVersion: number;
    semanticPins: Record<string, string>;
    sourceSnapshot: { manifestHash?: string; watermark?: Record<string, string> } | null;
  };
}
interface Loaded {
  graph: GraphProjection;
  layout: Record<string, { x: number; y: number }>;
  vintage: Vintage | null;
  branchName: string | null;
  rechecks: Array<{ nodeId: string }> | null;
}
type Selected = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;
type NData = { node: GraphNode; state: NodeState };

const REL_STYLE: Record<string, { stroke: string; dash?: string }> = {
  supports: { stroke: "var(--fg-muted)" },
  contradicts: { stroke: "var(--bad)", dash: "6 3" },
  derived_from: { stroke: "var(--fg-subtle)", dash: "2 3" },
  monitors: { stroke: "var(--fg-subtle)", dash: "8 3" },
  references: { stroke: "var(--border-strong)" },
  reproduces: { stroke: "var(--ok)" },
  supersedes: { stroke: "var(--warn)", dash: "5 3" },
};

function EvidenceNode({ data, selected }: NodeProps<Node<NData>>) {
  const { node, state } = data;
  return (
    <div
      className={e.node}
      data-state={state}
      data-kind={node.type}
      data-selected={selected ? "true" : undefined}
      data-testid={`ev-node-${node.id}`}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className={e.nodeKind}>{node.type.replace("_", " ")}</div>
      <div className={e.nodeLabel}>{node.label}</div>
      {state !== "ok" ? (
        <div className={e.nodeState} data-testid={`ev-state-${node.id}`}>
          {STATE_LABEL[state]}
        </div>
      ) : null}
      {secondaryFlags(node).map((f) => (
        <div key={f} className={e.nodeFlag} data-testid={`ev-flag-${node.id}`}>
          also: {STATE_LABEL[f]}
        </div>
      ))}
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  );
}
const nodeTypes = { ev: EvidenceNode };

function readMode(): Mode {
  const q = new URLSearchParams(window.location.search);
  const s = q.get("snapshot");
  const b = q.get("branch");
  return s ? { kind: "snapshot", id: s } : b ? { kind: "branch", id: b } : { kind: "current" };
}

export function EvidenceExplorer({ workspaceId }: { workspaceId: string }) {
  const [mode, setMode] = useState<Mode>(readMode);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  const [options, setOptions] = useState<{
    snapshots: Array<{ id: string; label: string; createdAt: string }>;
    branches: Array<{ id: string; name: string; isMain?: boolean }>;
  }>({ snapshots: [], branches: [] });
  const [filter, setFilter] = useState<GraphFilter>({
    kinds: new Set(NODE_KINDS),
    states: new Set(["any"]),
    text: "",
    relations: new Set(RELATIONS),
  });
  const [selected, setSelected] = useState<Selected>(null);
  const [rfNodes, setRfNodes] = useState<Node<NData>[]>([]);
  const [saveState, setSaveState] = useState<string | null>(null);
  const rf = useRef<ReactFlowInstance<Node<NData>, Edge> | null>(null);

  const load = useCallback(async () => {
    setLoaded(null);
    setFailure(null);
    setSelected(null);
    try {
      if (mode.kind === "current") {
        const graph = await getJson<GraphProjection>(`/api/k/workspaces/${workspaceId}/graph`);
        const rechecks = await getJson<{ flags?: Array<{ nodeId: string }> }>(
          `${evidenceApi(workspaceId)}/graph/rechecks`,
        ).catch(() => null);
        const layout = Object.fromEntries(
          graph.nodes.filter((n) => n.position).map((n) => [n.id, n.position!]),
        );
        setLoaded({
          graph,
          layout,
          vintage: null,
          branchName: null,
          rechecks: rechecks?.flags ?? null,
        });
      } else if (mode.kind === "snapshot") {
        const v = await getJson<
          Vintage & { graph: GraphProjection; layout: Record<string, { x: number; y: number }> }
        >(`${historyApi(workspaceId)}/snapshots/${mode.id}/graph`);
        if (!v.graph)
          throw new ApiError(422, "vintage_unavailable", "The snapshot has no reconstructable graph.");
        setLoaded({ graph: v.graph, layout: v.layout ?? {}, vintage: v, branchName: null, rechecks: null });
      } else {
        const b = await getJson<{
          name: string;
          baseSnapshotId: string | null;
          objects: Record<string, unknown>;
        }>(`${historyApi(workspaceId)}/branches/${mode.id}`);
        const layout = b.baseSnapshotId
          ? ((
              (await getJson<{ layout?: Record<string, { x: number; y: number }> }>(
                `${historyApi(workspaceId)}/snapshots/${b.baseSnapshotId}/layout`,
              ).catch(() => ({}))) as { layout?: Record<string, { x: number; y: number }> }
            ).layout ?? {})
          : {};
        setLoaded({
          graph: projectionFromObjects(workspaceId, b.objects),
          layout,
          vintage: null,
          branchName: b.name,
          rechecks: null,
        });
      }
    } catch (err) {
      const x = err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", String(err));
      setFailure({ code: mode.kind === "current" ? x.code : "vintage_unavailable", message: x.message });
    }
  }, [mode, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void Promise.all([
      getJson<{ snapshots: Array<{ id: string; label: string; createdAt: string }> }>(
        `${historyApi(workspaceId)}/snapshots`,
      ).catch(() => ({ snapshots: [] })),
      getJson<{ branches: Array<{ id: string; name: string; isMain?: boolean }> }>(
        `${historyApi(workspaceId)}/branches`,
      ).catch(() => ({ branches: [] })),
    ]).then(([s, b]) =>
      setOptions({
        snapshots: s.snapshots ?? [],
        branches: b.branches ?? [],
      }),
    );
  }, [workspaceId]);

  const view = useMemo(
    () => (loaded ? applyFilter(loaded.graph, filter) : { nodes: [], edges: [] }),
    [loaded, filter],
  );

  useEffect(() => {
    if (!loaded) return;
    const auto = autoLayout(loaded.graph.nodes);
    setRfNodes(
      view.nodes.map((n) => ({
        id: n.id,
        type: "ev",
        position: loaded.layout[n.id] ?? auto[n.id] ?? { x: 0, y: 0 },
        data: { node: n, state: nodeState(n) },
        ariaLabel: `${n.type} ${n.label}${nodeState(n) !== "ok" ? `, ${STATE_LABEL[nodeState(n)]}` : ""}`,
        focusable: true,
        connectable: false,
        draggable: mode.kind === "current",
      })),
    );
  }, [view, loaded, mode]);

  // Deep link: `?node=<id>` (e.g. a marker's linked evidence) selects and centres that node once it is laid out.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || !loaded || !rfNodes.length) return;
    const want = new URLSearchParams(window.location.search).get("node");
    if (!want) return;
    deepLinked.current = true;
    if (loaded.graph.nodes.some((n) => n.id === want)) {
      setSelected({ kind: "node", id: want });
      const n = rfNodes.find((x) => x.id === want);
      if (n)
        requestAnimationFrame(
          () => void rf.current?.setCenter(n.position.x + 90, n.position.y + 30, { zoom: 1.2, duration: 0 }),
        );
    }
  }, [loaded, rfNodes]);

  // Fit once per loaded graph, after nodes have positions (fitView on init runs before they exist).
  const fittedFor = useRef<unknown>(null);
  useEffect(() => {
    if (!loaded || !rfNodes.length || fittedFor.current === loaded) return;
    fittedFor.current = loaded;
    requestAnimationFrame(() => void rf.current?.fitView({ padding: 0.15 }));
  }, [loaded, rfNodes]);

  const rfEdges: Edge[] = useMemo(
    () =>
      view.edges.map((x) => {
        const st = REL_STYLE[x.relation] ?? { stroke: "var(--fg-subtle)" };
        return {
          id: x.id,
          source: x.source,
          target: x.target,
          label: x.relation.replace("_", " "),
          ariaLabel: `${x.relation} edge from ${x.source} to ${x.target}`,
          focusable: true,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: {
            stroke: st.stroke,
            strokeDasharray: st.dash,
            strokeWidth: selected?.kind === "edge" && selected.id === x.id ? 2.5 : 1.25,
          },
          data: { origin: x.origin },
        };
      }),
    [view, selected],
  );

  useEffect(() => {
    const w = window as unknown as { __evidence?: unknown };
    w.__evidence = loaded
      ? {
          ready: true,
          mode,
          nodes: loaded.graph.nodes.length,
          edges: loaded.graph.edges.map((x) => `${x.source}|${x.target}|${x.relation}`).sort(),
          visibleNodes: view.nodes.length,
          selected,
          saveState,
        }
      : { ready: failure !== null, mode, failure };
  }, [loaded, mode, view, selected, saveState, failure]);

  const onNodesChange = useCallback(
    (c: NodeChange<Node<NData>>[]) => setRfNodes((ns) => applyNodeChanges(c, ns)),
    [],
  );
  const onDragStop = useCallback(
    async (_: unknown, _n: Node, dragged: Node[]) => {
      if (mode.kind !== "current") return;
      const positions = Object.fromEntries(
        dragged.map((d) => [d.id, { x: Math.round(d.position.x), y: Math.round(d.position.y) }]),
      );
      setSaveState("saving");
      try {
        await saveLayout(workspaceId, positions);
        setLoaded((l) => (l ? { ...l, layout: { ...l.layout, ...positions } } : l));
        setSaveState("saved");
      } catch (err) {
        setSaveState(`failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [mode, workspaceId],
  );

  const focusNode = (id: string) => {
    setSelected({ kind: "node", id });
    const n = rfNodes.find((x) => x.id === id);
    if (n) void rf.current?.setCenter(n.position.x + 90, n.position.y + 30, { zoom: 1.2, duration: 200 });
  };

  const go = (m: Mode) => {
    const q = new URLSearchParams();
    if (m.kind === "snapshot") q.set("snapshot", m.id);
    if (m.kind === "branch") q.set("branch", m.id);
    window.history.replaceState(null, "", `${window.location.pathname}${q.size ? `?${q}` : ""}`);
    setMode(m);
  };

  const g = loaded?.graph;
  const sel =
    selected && g
      ? selected.kind === "node"
        ? g.nodes.find((n) => n.id === selected.id)
        : g.edges.find((x) => x.id === selected.id)
      : null;

  return (
    <main className={e.page} data-testid="evidence-page">
      <nav className={e.crumbs} aria-label="Breadcrumb">
        <a href={`/w/${workspaceId}`}>Workspace</a>
        <span aria-hidden="true">/</span>
        <span>Evidence graph</span>
        <span aria-hidden="true">·</span>
        <a href={`/w/${workspaceId}/history`}>Time machine</a>
      </nav>
      <header className={e.head}>
        <h1 className={e.title}>Evidence graph</h1>
        <div className={e.toolbar}>
          <label className={e.field}>
            View
            <select
              className="nz-input"
              data-testid="view-select"
              value={mode.kind === "current" ? "current" : `${mode.kind}:${mode.id}`}
              onChange={(ev) => {
                const v = ev.target.value;
                if (v === "current") go({ kind: "current" });
                else {
                  const [k, id] = v.split(":");
                  go({ kind: k as "snapshot" | "branch", id: id! });
                }
              }}
            >
              <option value="current">Current (main, live)</option>
              {options.snapshots.map((s) => (
                <option key={s.id} value={`snapshot:${s.id}`}>
                  Snapshot: {s.label} ({s.createdAt.slice(0, 16)})
                </option>
              ))}
              {options.branches
                .filter((b) => !b.isMain)
                .map((b) => (
                  <option key={b.id} value={`branch:${b.id}`}>
                    Branch: {b.name}
                  </option>
                ))}
            </select>
          </label>
          <label className={e.field}>
            Search
            <input
              className="nz-input"
              data-testid="filter-text"
              value={filter.text}
              onChange={(ev) => setFilter((f) => ({ ...f, text: ev.target.value }))}
              placeholder="label or id"
            />
          </label>
          <label className={e.field}>
            State
            <select
              className="nz-input"
              data-testid="filter-state"
              value={[...filter.states][0]}
              onChange={(ev) =>
                setFilter((f) => ({ ...f, states: new Set([ev.target.value as NodeState | "any"]) }))
              }
            >
              <option value="any">Any state</option>
              <option value="unsupported">Unsupported claims</option>
              <option value="contradicted">Contradicted claims</option>
              <option value="support_unknown">Support unknown</option>
              <option value="recheck">Recheck required</option>
              <option value="tombstone">Tombstones</option>
              <option value="ok">No issues</option>
            </select>
          </label>
          {saveState ? (
            <span className={e.muted} role="status" data-testid="layout-save-state">
              Layout {saveState} (positions only; evidence relations unchanged)
            </span>
          ) : null}
        </div>
        <fieldset className={e.kinds} aria-label="Node kinds">
          {NODE_KINDS.map((k) => (
            <label key={k}>
              <input
                type="checkbox"
                checked={filter.kinds.has(k)}
                data-testid={`kind-${k}`}
                onChange={(ev) =>
                  setFilter((f) => {
                    const kinds = new Set(f.kinds);
                    if (ev.target.checked) kinds.add(k);
                    else kinds.delete(k);
                    return { ...f, kinds };
                  })
                }
              />{" "}
              {k.replace("_", " ")}
            </label>
          ))}
        </fieldset>
      </header>

      {mode.kind === "snapshot" && loaded?.vintage ? <VintageBanner v={loaded.vintage} /> : null}
      {mode.kind === "branch" && loaded ? (
        <HonestyBanner data-testid="branch-banner">
          Branch overlay “{loaded.branchName}”: materialized from its base snapshot plus branch changes. Claim
          support is not computed for branches and is shown as unknown. Read-only.
        </HonestyBanner>
      ) : null}

      {failure ? (
        <EmptyState
          title={
            failure.code === "vintage_unavailable"
              ? "vintage_unavailable"
              : `Graph unavailable (${failure.code})`
          }
          data-testid="graph-failure"
        >
          {failure.code === "vintage_unavailable"
            ? "This historical view cannot be reconstructed. Current data is not substituted. "
            : ""}
          {failure.message}
        </EmptyState>
      ) : !loaded ? (
        <div className="nz-state" role="status" aria-busy="true">
          Loading evidence…
        </div>
      ) : (
        <div className={e.body}>
          <aside className={e.list} aria-label="Nodes (keyboard navigation)">
            <h2 className={e.h2}>
              Nodes{" "}
              <span className={e.muted}>
                ({view.nodes.length} of {loaded.graph.nodes.length})
              </span>
            </h2>
            <ul>
              {view.nodes.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={e.listBtn}
                    aria-pressed={selected?.kind === "node" && selected.id === n.id}
                    data-state={nodeState(n)}
                    onClick={() => focusNode(n.id)}
                    data-testid={`list-node-${n.id}`}
                  >
                    <span className={e.nodeKind}>{n.type.replace("_", " ")}</span> {n.label}
                    {nodeState(n) !== "ok" ? (
                      <span className={e.listState}>{STATE_LABEL[nodeState(n)]}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
            {loaded.graph.unresolved.length ? (
              <div className={e.notice} data-testid="unresolved">
                {loaded.graph.unresolved.length} unresolved edge(s) not drawn:{" "}
                {loaded.graph.unresolved
                  .map((u) => `${u.relation} ${u.source}→${u.target} (missing ${u.missing.join("+")})`)
                  .join("; ")}
              </div>
            ) : null}
            {loaded.rechecks?.length ? (
              <div className={e.notice}>
                {loaded.rechecks.length} node(s) need a recheck after a semantic-version change.
              </div>
            ) : null}
            {mode.kind === "current" ? (
              <>
                <PublicationPanel
                  workspaceId={workspaceId}
                  graphVersion={loaded.graph.version}
                  onPick={focusNode}
                />
                <ImpactPanel workspaceId={workspaceId} graph={loaded.graph} onPick={focusNode} />
              </>
            ) : null}
          </aside>
          <section className={e.canvas} aria-label="Evidence graph canvas" data-testid="graph-canvas">
            {view.nodes.length ? (
              <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onNodeDragStop={(ev, n, ns) => void onDragStop(ev, n, ns)}
                onNodeClick={(_, n) => setSelected({ kind: "node", id: n.id })}
                onEdgeClick={(_, x) => setSelected({ kind: "edge", id: x.id })}
                onInit={(i) => (rf.current = i)}
                nodesConnectable={false}
                edgesReconnectable={false}
                nodesFocusable
                edgesFocusable
                elementsSelectable
                fitView
                minZoom={0.2}
                proOptions={{ hideAttribution: true }}
              >
                <Background />
                <Controls showInteractive={false} />
                <MiniMap pannable zoomable ariaLabel="Graph overview" />
              </ReactFlow>
            ) : (
              <EmptyState title="No nodes match the filter" art={false} />
            )}
          </section>
          <aside className={e.inspector} aria-label="Inspector" data-testid="inspector">
            {!sel ? (
              <p className={e.muted}>
                Select a node or an edge to inspect it. Use the node list for keyboard navigation.
              </p>
            ) : selected?.kind === "node" ? (
              <NodeInspector
                n={sel as GraphNode}
                g={loaded.graph}
                workspaceId={workspaceId}
                live={mode.kind === "current"}
                onPick={focusNode}
              />
            ) : (
              <EdgeInspector x={sel as GraphEdge} g={loaded.graph} onPick={focusNode} />
            )}
          </aside>
        </div>
      )}
    </main>
  );
}

function VintageBanner({ v }: { v: Vintage }) {
  const d = v.dataVintage;
  return (
    <div className={e.vintage} role="note" data-testid="vintage-banner">
      <strong>Historical snapshot “{v.label}”</strong> captured {v.capturedAt} · document revision{" "}
      {d.documentRevision}, data revision {d.dataRevision}, event seq {d.eventSeq}
      {" · "}semantic pins{" "}
      {Object.keys(d.semanticPins).length
        ? Object.entries(d.semanticPins)
            .map(([m, ver]) => `${m}@${ver}`)
            .join(", ")
        : "none"}
      {" · "}source snapshot {d.sourceSnapshot?.manifestHash ?? "not pinned"}
      {v.stale ? (
        <span className={e.warn}>
          {" "}
          · Current data has moved on (now revision {v.currentDocumentRevision}); this view shows the
          snapshot, not today’s data.
        </span>
      ) : null}
      {v.integrityOk ? (
        <Badge tone="ok"> integrity ok</Badge>
      ) : (
        <Badge tone="bad">integrity check FAILED</Badge>
      )}
    </div>
  );
}

function NodeInspector({
  n,
  g,
  workspaceId,
  live,
  onPick,
}: {
  n: GraphNode;
  g: GraphProjection;
  workspaceId: string;
  /** Current graph (not a snapshot or branch view): the stored item can be dereferenced. */
  live: boolean;
  onPick: (id: string) => void;
}) {
  const st = nodeState(n);
  const up = upstream(n.id, g);
  const inEdges = g.edges.filter((x) => x.target === n.id);
  const outEdges = g.edges.filter((x) => x.source === n.id);
  // The server's provenance check (W08) is authoritative; the client-side path check covers views without it.
  const missing = n.missing?.length
    ? n.missing
    : n.type === "claim" && (st === "unsupported" || st === "support_unknown")
      ? missingProvenance(n.id, g)
      : [];
  return (
    <div className={e.inspect} data-testid="node-inspector">
      <span className={e.nodeKind}>{n.type.replace("_", " ")}</span>
      <h2 className={e.h2}>{n.label}</h2>
      <code className={e.mono}>{n.id}</code>
      {st !== "ok" ? (
        <div className={e.stateBox} data-state={st} data-testid="inspector-state">
          {STATE_LABEL[st]}
          {st === "recheck"
            ? ": a semantic-version change affects this node; results must be revalidated."
            : null}
          {st === "tombstone"
            ? ": removed (payload deleted, or an endpoint never persisted); kept visible, never silently dropped."
            : null}
        </div>
      ) : null}
      {n.evidenceUnavailable ? (
        <div className={e.stateBox} data-state="unsupported" data-testid="evidence-unavailable">
          Evidence unavailable: a payload this claim relies on was deleted under retention. Its hash is kept;
          the content cannot be re-read.
        </div>
      ) : null}
      {n.confidenceTier ? (
        <p data-testid="confidence-tier">
          Confidence tier: <strong>{n.confidenceTier}</strong>
        </p>
      ) : null}
      {live ? <EvidenceRecord workspaceId={workspaceId} nodeId={n.id} /> : null}
      {missing.length ? (
        <div data-testid="missing-provenance">
          <h3 className={e.h3}>Missing provenance</h3>
          <ul>
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <h3 className={e.h3}>Provenance (upstream)</h3>
      {up.length ? (
        <ul className={e.links} data-testid="provenance-links">
          {up.map((u) => (
            <li key={u.id}>
              <button type="button" className={e.linkBtn} onClick={() => onPick(u.id)}>
                {u.type.replace("_", " ")}: {u.label}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={e.muted}>No upstream evidence recorded.</p>
      )}
      {n.queryRef ? (
        <p>
          Query <code className={e.mono}>{n.queryRef}</code> ·{" "}
          <a href={`/w/${workspaceId}`}>open on canvas</a>
        </p>
      ) : null}
      <h3 className={e.h3}>Relations</h3>
      <ul className={e.links}>
        {[
          ...inEdges.map((x) => ({ x, other: x.source, dir: "from" })),
          ...outEdges.map((x) => ({ x, other: x.target, dir: "to" })),
        ].map(({ x, other, dir }) => (
          <li key={x.id}>
            {x.relation} {dir}{" "}
            <button type="button" className={e.linkBtn} onClick={() => onPick(other)}>
              {g.nodes.find((m) => m.id === other)?.label ?? other}
            </button>{" "}
            <span className={e.muted}>({x.origin})</span>
          </li>
        ))}
      </ul>
      <Comments nodeId={n.id} workspaceId={workspaceId} />
      {n.data && Object.keys(n.data).length ? (
        <details>
          <summary>Recorded data</summary>
          <pre className={e.pre}>{JSON.stringify(n.data, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

function EdgeInspector({ x, g, onPick }: { x: GraphEdge; g: GraphProjection; onPick: (id: string) => void }) {
  const label = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div className={e.inspect} data-testid="edge-inspector">
      <span className={e.nodeKind}>edge · {x.origin}</span>
      <h2 className={e.h2}>{x.relation.replace("_", " ")}</h2>
      <p>
        From{" "}
        <button type="button" className={e.linkBtn} onClick={() => onPick(x.source)}>
          {label(x.source)}
        </button>{" "}
        to{" "}
        <button type="button" className={e.linkBtn} onClick={() => onPick(x.target)}>
          {label(x.target)}
        </button>
      </p>
      <p className={e.muted}>
        {x.origin === "derived"
          ? "Derived from persisted records (e.g. panel query provenance), not stored as an evidence edge."
          : "Stored evidence edge."}
      </p>
      <code className={e.mono}>{x.id}</code>
    </div>
  );
}

interface ReviewComment {
  id: string;
  nodeId: string;
  authorId: string;
  authorKind: string;
  body: string;
  createdAt: string;
}

/** Reviewer comments on one evidence node (kernel `comments`). Text is rendered as text, never markup. */
function Comments({ nodeId, workspaceId }: { nodeId: string; workspaceId: string }) {
  const [items, setItems] = useState<ReviewComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems(
        (
          await getJson<{ comments: ReviewComment[] }>(
            `${evidenceApi(workspaceId)}/comments?nodeId=${nodeId}`,
          )
        ).comments,
      );
    } catch (x) {
      setErr(x instanceof ApiError ? `${x.code}: ${x.message}` : String(x));
    }
  }, [nodeId, workspaceId]);
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);
  return (
    <div data-testid="node-comments">
      <h3 className={e.h3}>Reviewer comments</h3>
      {items === null ? (
        <p className={e.muted}>Loading…</p>
      ) : items.length ? (
        <ul className={e.links}>
          {items.map((c) => (
            <li key={c.id} data-testid="comment">
              <span className={e.muted}>
                {c.authorKind} · {c.createdAt.slice(0, 16).replace("T", " ")}
              </span>
              <div>{c.body}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className={e.muted}>No comments yet.</p>
      )}
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          const body = draft.trim();
          if (!body) return;
          void (async () => {
            try {
              setErr(null);
              await mutate(workspaceId, `${evidenceApi(workspaceId)}/comments`, { nodeId, body });
              setDraft("");
              await load();
            } catch (x) {
              setErr(x instanceof ApiError ? `${x.code}: ${x.message}` : String(x));
            }
          })();
        }}
      >
        <label className={e.field}>
          Add a comment
          <textarea
            className="nz-input"
            rows={2}
            maxLength={4000}
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            data-testid="comment-input"
          />
        </label>
        <button type="submit" className="nz-btn" disabled={!draft.trim()} data-testid="comment-submit">
          Comment
        </button>
      </form>
      {err ? (
        <p className={e.warn} role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}
