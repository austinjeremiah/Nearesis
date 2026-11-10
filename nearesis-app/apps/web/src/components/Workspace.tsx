"use client";
import "../lib/zod-config.ts";
import type { DomainEvent, GridLayout, MarkerSpec, PanelSpec, PatchOp, Selection } from "@nearesis/contracts";
import {
  buildSelection,
  CANVAS_SCHEMA_VERSION,
  initialRuntime,
  type Issue,
  type PanelRuntime,
  type PanelState,
  transition,
  validatePanelSpec,
} from "@nearesis/canvas-schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBackend, KernelBackend } from "../lib/backend.ts";
import { RENDERER_VERSION } from "../lib/chart-option.ts";
import { hooks } from "../lib/test-hooks.ts";
import type { CanvasBackend, GraphProjection, PanelData } from "../lib/types.ts";
import { InvalidPanel, type Palette, Panel } from "./Panel.tsx";

const ACTOR = "00000000-0000-4000-8000-0000000000a1";

interface LoadedDoc {
  revision: number;
  dataRevision: number;
  panels: PanelSpec[];
  invalid: Array<{ index: number; raw: unknown; issues: Issue[] }>;
  markers: MarkerSpec[];
  selections: Selection[];
  sourceLabel: string;
}

/** Splits an untrusted stored document into valid panels and isolated invalid ones (C09b). */
function readDocument(raw: unknown): LoadedDoc {
  const d = (raw ?? {}) as Record<string, unknown>;
  const panelsRaw = Array.isArray(d.panels) ? (d.panels as unknown[]) : [];
  const panels: PanelSpec[] = [];
  const invalid: LoadedDoc["invalid"] = [];
  const seen = new Set<string>();
  panelsRaw.forEach((p, index) => {
    const r = validatePanelSpec(p, {}, `panels[${index}]`);
    if (r.ok && !seen.has(r.value.panelId)) {
      seen.add(r.value.panelId);
      panels.push(r.value);
    } else
      invalid.push({
        index,
        raw: p,
        issues: r.ok
          ? [{ code: "DUPLICATE_PANEL_ID", path: `panels[${index}].panelId`, message: "duplicate" }]
          : r.issues,
      });
  });
  return {
    revision: typeof d.documentRevision === "number" ? d.documentRevision : 0,
    dataRevision: typeof d.dataRevision === "number" ? d.dataRevision : 0,
    panels,
    invalid,
    markers: Array.isArray(d.markers) ? (d.markers as MarkerSpec[]) : [],
    selections: Array.isArray(d.activeSelections) ? (d.activeSelections as Selection[]) : [],
    sourceLabel: "",
  };
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    fg: v("--fg"),
    muted: v("--muted"),
    grid: v("--grid"),
    series: [v("--s1"), v("--s2"), v("--s3"), v("--s4")],
    gap: v("--gap"),
    marker: v("--marker"),
  };
}

export function Workspace({ workspaceId }: { workspaceId: string }) {
  const backendRef = useRef<CanvasBackend | null>(null);
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [data, setData] = useState<Record<string, PanelData | null>>({});
  const [runtimes, setRuntimes] = useState<Record<string, PanelRuntime>>({});
  const [graph, setGraph] = useState<GraphProjection | null>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [undoStack, setUndo] = useState<PatchOp[][]>([]);
  const [redoStack, setRedo] = useState<PatchOp[][]>([]);
  const [pendingSel, setPendingSel] = useState<Record<string, Selection>>({});
  const docRef = useRef(doc);
  docRef.current = doc;
  const dataRef = useRef(data);
  dataRef.current = data;

  const setState = useCallback(
    (panelId: string, to: PanelState, payload: Parameters<typeof transition>[2] = {}) => {
      setRuntimes((rs) => {
        const cur = rs[panelId] ?? initialRuntime();
        if (cur.state === to) return rs;
        try {
          const next = transition(cur, to, payload);
          hooks().stateLog[panelId] = next.history;
          return { ...rs, [panelId]: next };
        } catch (e) {
          hooks().lastError = String(e);
          return rs;
        }
      });
    },
    [],
  );

  const loadDoc = useCallback(async () => {
    const b = backendRef.current!;
    const d = readDocument(await b.load());
    d.sourceLabel = b.sourceLabel;
    setDoc(d);
    hooks().doc = {
      revision: d.revision,
      dataRevision: d.dataRevision,
      panels: d.panels.map((p) => p.panelId),
      layouts: Object.fromEntries(
        d.panels.map((p) => [p.panelId, { layout: p.layout, queryHash: p.queryRef.hash }]),
      ),
      invalid: d.invalid.length,
      markers: d.markers,
      selections: d.selections,
    };
    return d;
  }, []);

  const loadPanel = useCallback(
    async (p: PanelSpec) => {
      const b = backendRef.current!;
      setState(p.panelId, "VALIDATING");
      setState(p.panelId, "QUERYING");
      if (p.kind === "note") {
        setState(p.panelId, "READY");
        return;
      }
      if (p.kind === "evidenceGraph") {
        const g = await b.graph();
        setGraph(g);
        setState(
          p.panelId,
          g ? "READY" : "ERROR",
          g ? {} : { error: { code: "GRAPH_UNAVAILABLE", message: "no graph projection" } },
        );
        return;
      }
      const d = await b.fetchData(p.queryRef.hash);
      if (!d) {
        setState(p.panelId, "ERROR", {
          error: { code: "QUERY_UNRESOLVED", message: "query result not available" },
        });
        return;
      }
      d.chart = { ...d.chart, panelId: p.panelId };
      setData((m) => ({ ...m, [p.queryRef.hash]: d }));
      setState(p.panelId, "READY", { data: d.chart });
    },
    [setState],
  );

  useEffect(() => {
    const b = createBackend(new URLSearchParams(window.location.search), workspaceId);
    backendRef.current = b;
    hooks().backend = b;
    hooks().mode = b.mode;
    if (b instanceof KernelBackend) {
      b.onReload = () => void loadDoc();
      hooks().eventStore = b.store;
    }
    setPalette(readPalette());
    let unsub = () => {};
    void (async () => {
      const d = await loadDoc();
      await Promise.all(d.panels.map(loadPanel));
      unsub = b.subscribe(onEvent);
      hooks().ready = true;
    })();
    return () => unsub();
    // Mount once per workspace.
  }, [workspaceId]);

  /**
   * Data refresh of a set of panels (one source watermark advance = one data revision): each goes REFRESHING -> READY
   * with new data, or ERROR with a structured code while its last good data stays rendered and labelled. The
   * document's dataRevision increments once per refresh batch that produced new data; documentRevision never changes
   * (C18b/c, C12d).
   */
  const refresh = useCallback(
    async (panels: PanelSpec[]) => {
      const b = backendRef.current;
      if (!b || !panels.length) return;
      for (const p of panels) setState(p.panelId, "REFRESHING");
      const results = await Promise.all(
        panels.map(async (p) => {
          try {
            const nd = await b.fetchData(p.queryRef.hash);
            if (!nd)
              throw Object.assign(new Error("query result not available"), { code: "QUERY_UNRESOLVED" });
            nd.chart = { ...nd.chart, panelId: p.panelId };
            setData((m) => ({ ...m, [p.queryRef.hash]: nd }));
            setState(p.panelId, "READY", { data: nd.chart });
            return true;
          } catch (e) {
            const code = (e as { code?: string }).code ?? "QUERY_FAILED";
            setState(p.panelId, "ERROR", { error: { code, message: (e as Error).message } });
            return false;
          }
        }),
      );
      if (results.some(Boolean))
        setDoc((cur) => {
          if (!cur) return cur;
          const next = { ...cur, dataRevision: cur.dataRevision + 1 };
          hooks().doc = { ...(hooks().doc as object), dataRevision: next.dataRevision };
          return next;
        });
    },
    [setState],
  );
  hooks().refreshPanel = (panelId: string) => {
    const p = docRef.current?.panels.find((x) => x.panelId === panelId);
    if (p) void refresh([p]);
  };

  /** Watermark transitions (C14c) and data refresh (C12d / C18c): data revision only, document revision untouched. */
  const onEvent = useCallback(
    (e: DomainEvent) => {
      const d = docRef.current;
      if (!d) return;
      if (e.type === "snapshot.finalized" && e.data.kind === "watermark") {
        const provider = String(e.data.providerId);
        const state = String(e.data.state) as PanelData["chart"]["freshness"];
        setData((m) => {
          const next = { ...m };
          for (const [h, pd] of Object.entries(m))
            if (pd && pd.provenance.sources.includes(provider))
              next[h] = { ...pd, chart: { ...pd.chart, freshness: state } };
          return next;
        });
        const affected = d.panels.filter((p) =>
          dataRef.current[p.queryRef.hash]?.provenance.sources.includes(provider),
        );
        if (state === "fresh") void refresh(affected);
        else for (const p of affected) setState(p.panelId, "STALE");
      } else if (e.type === "query.completed") {
        setDoc((cur) => (cur ? { ...cur, dataRevision: cur.dataRevision + 1 } : cur));
      } else if (e.type === "canvas.patched") {
        void loadDoc();
      }
    },
    [loadDoc, setState, refresh],
  );

  const apply = useCallback(
    async (ops: PatchOp[], kind: "patch" | "undo" | "redo") => {
      const b = backendRef.current;
      const d = docRef.current;
      if (!b || !d) return false;
      const r = await b.apply(ops, d.revision, kind);
      if (!r.ok) {
        setToast(
          `${r.status === 409 ? "Conflict" : "Rejected"}: ${r.message}${r.report ? ` (${r.report.issues.map((i) => i.code).join(", ")})` : ""}`,
        );
        if (r.status === 409) await loadDoc();
        return false;
      }
      setToast(null);
      if (kind === "patch") {
        setUndo((u) => [...u, r.inverse]);
        setRedo([]);
      } else if (kind === "undo") setRedo((s) => [...s, r.inverse]);
      else setUndo((u) => [...u, r.inverse]);
      await loadDoc();
      return true;
    },
    [loadDoc],
  );

  const undo = useCallback(async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndo((u) => u.slice(0, -1));
    await apply(last, "undo");
  }, [undoStack, apply]);
  const redo = useCallback(async () => {
    const last = redoStack[redoStack.length - 1];
    if (!last) return;
    setRedo((s) => s.slice(0, -1));
    await apply(last, "redo");
  }, [redoStack, apply]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void (e.shiftKey ? redo() : undo());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const move = useCallback(
    (p: PanelSpec, dx: number, dy: number) => {
      const w = Math.min(12, p.layout.w);
      const layout: GridLayout = {
        ...p.layout,
        x: Math.max(0, Math.min(12 - w, p.layout.x + dx)),
        y: Math.max(0, p.layout.y + dy),
      };
      if (layout.x === p.layout.x && layout.y === p.layout.y) return;
      void apply([{ op: "movePanel", panelId: p.panelId, layout }], "patch");
    },
    [apply],
  );

  /** Selection from a brush or the keyboard: typed data context, persisted, and never spawns an agent (C13d). */
  const select = useCallback(
    (p: PanelSpec, startMs: number, endMs: number) => {
      const pd = data[p.queryRef.hash];
      if (!pd) return;
      const s = buildSelection({
        panel: p,
        data: pd.chart,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        rendererVersion: `${RENDERER_VERSION}+schema-${CANVAS_SCHEMA_VERSION}`,
      });
      setPendingSel((m) => ({ ...m, [p.panelId]: s }));
      hooks().lastSelection = s;
      void apply([{ op: "setSelection", selection: s }], "patch");
    },
    [data, apply],
  );

  const markRange = useCallback(
    (p: PanelSpec) => {
      const s = pendingSel[p.panelId] ?? docRef.current?.selections.find((x) => x.panelId === p.panelId);
      if (!s) return;
      const marker: MarkerSpec = {
        markerId: crypto.randomUUID(),
        panelId: p.panelId,
        anchor: { kind: "time_range", start: s.interval.start, end: s.interval.end },
        status: "ACTIVE",
        createdBy: ACTOR,
        createdAt: new Date().toISOString(),
      };
      void apply([{ op: "addMarker", marker }], "patch");
    },
    [pendingSel, apply],
  );

  const saveLayout = useCallback(async (pos: Record<string, { x: number; y: number }>) => {
    await backendRef.current?.saveGraphLayout(pos);
    hooks().graphLayoutSaved = { ...((hooks().graphLayoutSaved as object) ?? {}), ...pos };
  }, []);

  const markersByPanel = useMemo(() => {
    const m: Record<string, MarkerSpec[]> = {};
    for (const mk of doc?.markers ?? []) (m[mk.panelId] ??= []).push(mk);
    return m;
  }, [doc]);

  return (
    <>
      <header className="ws-header">
        <h1>Workspace</h1>
        <span className="rev" data-testid="document-revision">
          doc rev {doc?.revision ?? "…"}
        </span>
        <span className="rev" data-testid="data-revision">
          data rev {doc?.dataRevision ?? "…"}
        </span>
        {backendRef.current?.mode === "fixture" && (
          <span className="badge synthetic" data-testid="mode-badge">
            fixture mode · SYNTHETIC data
          </span>
        )}
        <span className="spacer" />
        <button onClick={() => void undo()} disabled={!undoStack.length} data-testid="undo">
          Undo
        </button>
        <button onClick={() => void redo()} disabled={!redoStack.length} data-testid="redo">
          Redo
        </button>
      </header>
      <main className="canvas-grid" aria-label="Research canvas">
        {doc?.invalid.map((i) => (
          <InvalidPanel key={`inv-${i.index}`} index={i.index} raw={i.raw} issues={i.issues} />
        ))}
        {doc?.panels.map((p) => (
          <Panel
            key={p.panelId}
            panel={p}
            runtime={runtimes[p.panelId] ?? initialRuntime()}
            data={data[p.queryRef.hash] ?? null}
            markers={markersByPanel[p.panelId] ?? []}
            graph={p.kind === "evidenceGraph" ? graph : null}
            palette={palette}
            onMove={(dx, dy) => move(p, dx, dy)}
            onBrush={(a, b) => select(p, a, b)}
            onKeyboardRange={(a, b) => select(p, a, b)}
            onMarkRange={() => markRange(p)}
            onGraphLayout={saveLayout}
            hasSelection={Boolean(
              pendingSel[p.panelId] ?? doc.selections.find((s) => s.panelId === p.panelId),
            )}
          />
        ))}
      </main>
      {toast && (
        <div className="toast" role="alert" data-testid="toast">
          {toast}
        </div>
      )}
    </>
  );
}
