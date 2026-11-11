"use client";
import "../lib/zod-config.ts";
import type {
  DomainEvent,
  GridLayout,
  Lens,
  Marker,
  MarkerSpec,
  PanelSpec,
  PatchOp,
  Selection,
} from "@nearesis/contracts";
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
import { InvalidPanel, Panel, type PanelMonitoring } from "./Panel.tsx";
import type { LensApplication } from "./monitoring/LensesTab.tsx";
import { MonitoringView, useMonitorUi } from "./monitoring/MonitoringView.tsx";
import { MONITORING_EVENTS } from "../lib/monitoring/api.ts";
import { useMonitoring } from "../lib/monitoring/use-monitoring.ts";
import { ReportView } from "./ReportView.tsx";
import { SettingsView } from "./SettingsView.tsx";
import {
  AgentChatPanel,
  AppShell,
  Button,
  CommandPalette,
  HonestyBanner,
  Sidebar,
  TopBar,
  WorkspaceOnboarding,
  useCommandPaletteShortcut,
  type ConnectionState,
  type PaletteCommand,
  type SidebarData,
} from "@nearesis/ui";
import { BUDGET_NOTE, useRunConversation } from "../lib/run-conversation.ts";
import {
  devLoginAvailable,
  kernelWorkspaceUrl,
  listWorkspaces,
  signInDev,
  type WorkspaceRow,
} from "../lib/dev-login.ts";

const ACTOR = "00000000-0000-4000-8000-0000000000a1";

/** Client undo/redo depth: older inverse operations are dropped so a long session does not grow without bound. */
const MAX_HISTORY = 50;
const NO_MARKERS: MarkerSpec[] = [];

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
function readDocument(raw: unknown, cache: Map<string, PanelSpec>): LoadedDoc {
  const d = (raw ?? {}) as Record<string, unknown>;
  const panelsRaw = Array.isArray(d.panels) ? (d.panels as unknown[]) : [];
  const panels: PanelSpec[] = [];
  const invalid: LoadedDoc["invalid"] = [];
  const seen = new Set<string>();
  const used = new Set<string>();
  panelsRaw.forEach((p, index) => {
    // A panel whose stored JSON did not change keeps its validated object (same identity), so memoised panels do not
    // re-render when another panel moves. Validation still runs for anything new or changed.
    const key = JSON.stringify(p);
    const hit = cache.get(key);
    if (hit && !seen.has(hit.panelId)) {
      seen.add(hit.panelId);
      panels.push(hit);
      used.add(key);
      return;
    }
    const r = validatePanelSpec(p, {}, `panels[${index}]`);
    if (r.ok && !seen.has(r.value.panelId)) {
      seen.add(r.value.panelId);
      panels.push(r.value);
      cache.set(key, r.value);
      used.add(key);
    } else
      invalid.push({
        index,
        raw: p,
        issues: r.ok
          ? [{ code: "DUPLICATE_PANEL_ID", path: `panels[${index}].panelId`, message: "duplicate" }]
          : r.issues,
      });
  });
  for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
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

export function Workspace({ workspaceId }: { workspaceId: string }) {
  const backendRef = useRef<CanvasBackend | null>(null);
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [data, setData] = useState<Record<string, PanelData | null>>({});
  const [runtimes, setRuntimes] = useState<Record<string, PanelRuntime>>({});
  const [graph, setGraph] = useState<GraphProjection | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [undoStack, setUndo] = useState<PatchOp[][]>([]);
  const [redoStack, setRedo] = useState<PatchOp[][]>([]);
  const [pendingSel, setPendingSel] = useState<Record<string, Selection>>({});
  const [mode, setMode] = useState<"kernel" | "fixture" | null>(null);
  const [source, setSource] = useState<"fixture" | "live">("fixture");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [chatOpen, setChatOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("live");
  const connRef = useRef<ConnectionState>("live");
  const [denied, setDenied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceFeedError, setSourceFeedError] = useState(false);
  const [entering, setEntering] = useState<Set<string>>(new Set());
  const [sources, setSources] = useState<SidebarData["sources"]>([]);
  const [user, setUser] = useState<{ name: string }>({ name: "Signed out" });
  const [devLogin, setDevLogin] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [view, setView] = useState<string>("canvas");
  const mon = useMonitoring(workspaceId, mode, mode !== null);
  const monRef = useRef(mon);
  monRef.current = mon;
  const [monUi, setMonUi] = useMonitorUi(workspaceId);
  const [lens, setLens] = useState<LensApplication | null>(null);
  const conv = useRunConversation(workspaceId, mode === "kernel", source);
  const convRef = useRef(conv);
  convRef.current = conv;
  const docRef = useRef(doc);
  docRef.current = doc;
  const dataRef = useRef(data);
  dataRef.current = data;
  const loadedRef = useRef(new Set<string>());
  const panelCacheRef = useRef(new Map<string, PanelSpec>());
  const pendingSelRef = useRef(pendingSel);
  pendingSelRef.current = pendingSel;

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
    const d = readDocument(await b.load(), panelCacheRef.current);
    d.sourceLabel = b.sourceLabel;
    // Unchanged markers/selections keep their identity too (derived per-panel marker lists stay stable).
    const prev = docRef.current;
    if (prev && JSON.stringify(prev.markers) === JSON.stringify(d.markers)) d.markers = prev.markers;
    if (prev && JSON.stringify(prev.selections) === JSON.stringify(d.selections))
      d.selections = prev.selections;
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
      loadedRef.current.add(p.panelId);
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
      let d: PanelData | null;
      try {
        d = await b.fetchData(p.queryRef.hash);
      } catch (e) {
        setState(p.panelId, "ERROR", {
          error: { code: "QUERY_FAILED", message: `data request failed: ${(e as Error).message}` },
        });
        return;
      }
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
    let srcTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    const search = new URLSearchParams(window.location.search);
    void devLoginAvailable().then(setDevLogin);
    const readHash = () => {
      const h = window.location.hash.replace(/^#/, "");
      setView(
        h === "settings" || h === "monitoring" || /^report\/[0-9a-f-]{36}$/.test(h)
          ? h.startsWith("report/")
            ? `rep:${h.slice(7)}`
            : h
          : "canvas",
      );
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    // Signed-in users get the kernel-backed workspace on the semantic layer by default.
    if (!search.has("backend") && /^[0-9a-f-]{36}$/.test(workspaceId))
      void fetch("/api/session", { cache: "no-store" }).then((r) => {
        if (r.ok) window.location.replace(kernelWorkspaceUrl(workspaceId) + window.location.hash);
      });
    const b = createBackend(new URLSearchParams(window.location.search), workspaceId);
    backendRef.current = b;
    hooks().backend = b;
    hooks().mode = b.mode;
    setMode(b.mode);
    setSource(b instanceof KernelBackend && b.dataMode === "live" ? "live" : "fixture");
    const stored = (() => {
      try {
        return localStorage.getItem("nz-theme");
      } catch {
        return null;
      }
    })();
    setTheme(
      stored === "dark" || stored === "light"
        ? stored
        : window.matchMedia?.("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
    );
    if (b instanceof KernelBackend) {
      b.onConnection = (st) => {
        if (st === "denied") {
          setDenied(true);
          connRef.current = "offline";
          setConnection("offline");
        } else {
          setDenied(false);
          const prev = connRef.current;
          connRef.current = st;
          setConnection(st);
          // After an outage events were replayed from the cursor; resync the document so nothing stale lingers.
          if (st === "live" && prev !== "live") void loadDoc();
        }
      };
      b.onReload = () => {
        setConnection("reload_required");
        void loadDoc().then(() => setConnection("live"));
      };
      hooks().eventStore = b.store;
      void fetch("/api/session", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((u: { subject?: string | null } | null) => {
          if (u?.subject) {
            setUser({ name: u.subject });
            setSignedIn(true);
            void listWorkspaces().then(setWorkspaces);
          }
        })
        .catch(() => undefined);
      if (b.dataMode !== "fixture") {
        const loadSources = () =>
          fetch(
            `/api/semantic/watermarks?workspace=${workspaceId}${b.dataMode === "live" ? "&source=live" : ""}`,
            {
              cache: "no-store",
            },
          )
            .then((r) => {
              if (!r.ok) throw new Error(`watermarks ${r.status}`);
              return r.json();
            })
            .then((w: Record<string, { state: string; newestEventTime: string | null }> | null) => {
              setSourceFeedError(false);
              if (w)
                setSources(
                  Object.entries(w).map(([id, v]) => ({
                    id,
                    name: id,
                    freshness: (["fresh", "late", "partial", "stale", "unavailable"].includes(v.state)
                      ? v.state
                      : "unavailable") as SidebarData["sources"][number]["freshness"],
                  })),
                );
            })
            .catch(() => {
              // A broken feed means freshness is unknown: never keep showing the last "fresh" state.
              setSourceFeedError(true);
              setSources((cur) => cur.map((x) => ({ ...x, freshness: "unavailable" as const })));
            });
        void loadSources();
        srcTimer = setInterval(() => void loadSources(), 5000);
      }
    }
    const goOffline = () => {
      connRef.current = "offline";
      setConnection("offline");
    };
    const goOnline = () => {
      // The stream reports "live" itself once it is open again; until then do not claim it.
      if (b instanceof KernelBackend) b.retryStream();
      else setConnection("live");
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    setChatOpen(window.innerWidth > 900);
    let unsub = () => {};
    void (async () => {
      try {
        const d = await loadDoc();
        if (b.mode === "kernel") setChatOpen(window.innerWidth > 900 && d.panels.length === 0);
        else setChatOpen(false);
        await Promise.all(d.panels.map(loadPanel));
        // A superseded mount (React strict-mode remount, route change) must not leave a second event stream open.
        if (!cancelled) unsub = b.subscribe(onEvent);
      } catch (e) {
        hooks().lastError = String(e);
        setLoadError(e instanceof Error ? e.message : String(e));
      }
      hooks().ready = true;
    })();
    return () => {
      cancelled = true;
      unsub();
      if (srcTimer) clearInterval(srcTimer);
      window.removeEventListener("hashchange", readHash);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
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
      convRef.current.ingestEvent(e);
      if (MONITORING_EVENTS.has(e.type)) void monRef.current.refresh();
      const d = docRef.current;
      if (!d) return;
      if (e.type === "snapshot.finalized" && e.data.kind === "watermark") {
        const provider = String(e.data.providerId);
        const state = String(e.data.state) as PanelData["chart"]["freshness"];
        // The sidebar must not keep saying "fresh" until the next poll: apply the transition immediately.
        setSources((cur) =>
          cur.map((x) =>
            x.id === provider ? { ...x, freshness: state as SidebarData["sources"][number]["freshness"] } : x,
          ),
        );
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
        // Panels added by another writer (e.g. a composer run) load their data when they first appear.
        void loadDoc().then((nd) => {
          const added = nd.panels.filter((p) => !loadedRef.current.has(p.panelId));
          for (const p of added) void loadPanel(p);
          if (added.length) {
            setEntering((cur) => new Set([...cur, ...added.map((p) => p.panelId)]));
            convRef.current.notePanels(
              added.map((p) => ({
                panelId: p.panelId,
                title: p.title,
                queryHash: p.queryRef.hash,
                sourceLabel: backendRef.current?.sourceLabel ?? "SYNTHETIC",
              })),
            );
          }
        });
      }
    },
    [loadDoc, loadPanel, setState, refresh],
  );

  const apply = useCallback(
    async (ops: PatchOp[], kind: "patch" | "undo" | "redo") => {
      const b = backendRef.current;
      const d = docRef.current;
      if (!b || !d) return false;
      let r: Awaited<ReturnType<typeof b.apply>>;
      try {
        r = await b.apply(ops, d.revision, kind);
      } catch (e) {
        setToast(`Not saved: the request failed (${(e as Error).message}). The document is unchanged.`);
        return false;
      }
      if (!r.ok) {
        setToast(
          `${r.status === 409 ? "Conflict" : "Rejected"}: ${r.message}${r.report ? ` (${r.report.issues.map((i) => i.code).join(", ")})` : ""}`,
        );
        if (r.status === 409) await loadDoc();
        return false;
      }
      setToast(null);
      if (kind === "patch") {
        setUndo((u) => [...u, r.inverse].slice(-MAX_HISTORY));
        setRedo([]);
      } else if (kind === "undo") setRedo((s) => [...s, r.inverse].slice(-MAX_HISTORY));
      else setUndo((u) => [...u, r.inverse].slice(-MAX_HISTORY));
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

  const resize = useCallback(
    (p: PanelSpec, dw: number, dh: number) => {
      const layout: GridLayout = {
        ...p.layout,
        w: Math.max(2, Math.min(12 - p.layout.x, p.layout.w + dw)),
        h: Math.max(3, p.layout.h + dh),
      };
      if (layout.w === p.layout.w && layout.h === p.layout.h) return;
      void apply([{ op: "movePanel", panelId: p.panelId, layout }], "patch");
    },
    [apply],
  );

  const addThreshold = useCallback(
    (p: PanelSpec, value: number) => {
      const metricId = p.encoding.y?.[0] ?? "";
      const marker: MarkerSpec = {
        markerId: crypto.randomUUID(),
        panelId: p.panelId,
        anchor: { kind: "threshold", metricId, op: "gt", value },
        status: "DRAFT", // the kernel accepts only DRAFT for a new marker (state machine)
        createdBy: ACTOR,
        createdAt: new Date().toISOString(),
      };
      void apply([{ op: "addMarker", marker }], "patch");
    },
    [apply],
  );

  /** Selection from a brush or the keyboard: typed data context, persisted, and never spawns an agent (C13d). */
  const select = useCallback(
    (p: PanelSpec, startMs: number, endMs: number) => {
      const pd = dataRef.current[p.queryRef.hash];
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
    [apply],
  );

  const markRange = useCallback(
    (p: PanelSpec) => {
      const s =
        pendingSelRef.current[p.panelId] ?? docRef.current?.selections.find((x) => x.panelId === p.panelId);
      if (!s) return;
      const marker: MarkerSpec = {
        markerId: crypto.randomUUID(),
        panelId: p.panelId,
        anchor: { kind: "time_range", start: s.interval.start, end: s.interval.end },
        status: "DRAFT", // the kernel accepts only DRAFT for a new marker (state machine)
        createdBy: ACTOR,
        createdAt: new Date().toISOString(),
      };
      void apply([{ op: "addMarker", marker }], "patch");
    },
    [apply],
  );

  const saveLayout = useCallback(async (pos: Record<string, { x: number; y: number }>) => {
    try {
      await backendRef.current?.saveGraphLayout(pos);
      hooks().graphLayoutSaved = { ...((hooks().graphLayoutSaved as object) ?? {}), ...pos };
    } catch (e) {
      setToast(`Layout not saved: ${(e as Error).message}`);
    }
  }, []);

  const markersByPanel = useMemo(() => {
    const m: Record<string, MarkerSpec[]> = {};
    for (const mk of doc?.markers ?? []) (m[mk.panelId] ??= []).push(mk);
    return m;
  }, [doc?.markers]);
  // A marker the monitoring store already draws (same id) is not drawn a second time from the canvas document: the
  // kernel returns the same marker through both reads after a reload. Computed once per change, not per render.
  const canvasMarkers = useMemo(() => {
    if (!mon.api) return markersByPanel;
    const drawn = new Set(mon.data.markers.map((x) => x.markerId));
    const out: Record<string, MarkerSpec[]> = {};
    for (const [id, list] of Object.entries(markersByPanel))
      out[id] = list.filter((m) => !drawn.has(m.markerId));
    return out;
  }, [markersByPanel, mon.api, mon.data.markers]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const n = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("nz-theme", n);
      } catch {
        /* storage unavailable: the choice lasts for this page only */
      }
      return n;
    });
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  // Toasts report an action once; they do not linger over the canvas.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 8000);
    return () => clearTimeout(id);
  }, [toast]);
  useCommandPaletteShortcut(setPaletteOpen);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setChatOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const focusPanel = useCallback((panelId: string) => {
    const el = document.querySelector<HTMLElement>(`[data-testid='panel-${panelId}']`);
    el?.scrollIntoView({ block: "center" });
    el?.focus();
  }, []);
  const askNow = useCallback(() => {
    setChatOpen(true);
    setTimeout(() => document.querySelector<HTMLElement>("[data-testid='ask-input']")?.focus(), 60);
  }, []);
  const openCitation = useCallback(
    (c: { queryHash: string }) => {
      const p = docRef.current?.panels.find((x) => x.queryRef.hash === c.queryHash);
      if (!p) return;
      focusPanel(p.panelId);
      const tgl = document.querySelector<HTMLElement>(
        `[data-testid='panel-${p.panelId}'] [data-testid='provenance-toggle']`,
      );
      if (tgl && tgl.getAttribute("aria-expanded") !== "true") tgl.click();
    },
    [focusPanel],
  );

  const navigateView = useCallback((key: string) => {
    const h =
      key === "settings"
        ? "#settings"
        : key === "monitoring"
          ? "#monitoring"
          : key.startsWith("rep:")
            ? `#report/${key.slice(4)}`
            : "";
    const u = new URL(window.location.href);
    u.hash = h;
    window.history.pushState(null, "", u.toString());
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, []);
  const reportRunId = view.startsWith("rep:") ? view.slice(4) : null;
  useEffect(() => {
    if (reportRunId && mode === "kernel" && !convRef.current.runs[reportRunId])
      convRef.current.openRun(
        reportRunId,
        convRef.current.investigations.find((r) => r.runId === reportRunId)?.questionSummary,
      );
  }, [reportRunId, mode]);

  const latestSelection: Selection | null = useMemo(() => {
    const all = [...(doc?.selections ?? []), ...Object.values(pendingSel)];
    return all.length ? all[all.length - 1]! : null;
  }, [doc, pendingSel]);

  /** Marker creation from a gesture: typed anchor plus the data context of the panel; never assigns an agent. */
  const createMonitorMarker = useCallback(
    async (p: PanelSpec, anchor: Marker["anchor"], interval: { start: string; end: string }) => {
      const pd = dataRef.current[p.queryRef.hash];
      const r = await monRef.current.act((api) =>
        api.createMarker({
          panelId: p.panelId,
          anchor,
          ...(pd
            ? {
                selection: {
                  queryHash: pd.provenance.queryHash,
                  semanticVersion: p.queryRef.semanticVersion,
                  interval,
                  seriesIds: p.encoding.y ?? [],
                  axisUnits: p.dataBinding.units,
                  sourceWatermark: pd.chart.sourceWatermark ?? null,
                },
              }
            : {}),
        }),
      );
      setToast(
        r.ok
          ? "Marker created. Open Monitoring to assign an agent or add a rule."
          : `${r.reasonCode}: ${r.message}`,
      );
    },
    [],
  );
  const applyLens = useCallback(
    async (lensId: string | null) => {
      setMonUi({ lensId });
      if (!lensId) return setLens(null);
      const r = await monRef.current.api?.resolveLens(lensId);
      if (r?.ok) setLens({ lensId, resolution: r.value });
      else {
        setLens(null);
        setToast(r ? `${r.reasonCode}: ${r.message}` : "Lens could not be resolved.");
      }
    },
    [setMonUi],
  );
  // After reload: re-resolve the persisted lens against the backend (never trust a stored resolution).
  useEffect(() => {
    if (
      mon.status === "ready" &&
      monUi.lensId &&
      !lens &&
      mon.data.lenses.some((l) => l.lensId === monUi.lensId)
    )
      void applyLens(monUi.lensId);
  }, [mon.status, mon.data.lenses, monUi.lensId, lens, applyLens]);
  /** Lens filters the canvas panels cannot apply (they filter by time only); listed on every affected panel. */
  const unappliedFilters = (f: Lens["filter"]): string[] => [
    ...(f.segment ? [`segment ${f.segment.dimension} in ${f.segment.values.join(", ")}`] : []),
    ...(f.route ? [`route ${f.route}`] : []),
  ];
  const onMarkPoint = useCallback(
    (p: PanelSpec, ms: number) => {
      const at = new Date(ms).toISOString();
      void createMonitorMarker(p, { kind: "time_point", at }, { start: at, end: at });
    },
    [createMonitorMarker],
  );
  const onMonitorSelection = useCallback(
    (p: PanelSpec) => {
      const s =
        pendingSelRef.current[p.panelId] ?? docRef.current?.selections.find((x) => x.panelId === p.panelId);
      if (s)
        void createMonitorMarker(
          p,
          { kind: "time_range", start: s.interval.start, end: s.interval.end },
          s.interval,
        );
    },
    [createMonitorMarker],
  );
  const onOpenMonitoring = useCallback(() => {
    setMonUi({ tab: "markers" });
    navigateView("monitoring");
  }, [setMonUi, navigateView]);
  /** Per-panel monitoring props, cached so an unchanged panel receives the same object (memoised panels stay put). */
  const monCache = useRef(new Map<string, PanelMonitoring>());
  const panelMonitoring = (p: PanelSpec): PanelMonitoring | undefined => {
    if (!mon.api) return undefined;
    const l = lens ? mon.data.lenses.find((x) => x.lensId === lens.lensId) : null;
    const res = lens?.resolution.panels.find((x) => x.panelId === p.panelId);
    const markers = mon.data.markers.filter((m) => m.sourcePanelId === p.panelId);
    const lensProps: PanelMonitoring["lens"] =
      l && res
        ? {
            name: l.name,
            range: res.compatible ? (res.appliedFilter?.timeRange ?? null) : null,
            skipped: !res.compatible
              ? (res.reason ?? "incompatible")
              : res.appliedFilter?.timeRange
                ? null
                : "the lens has no date range",
            unapplied: res.compatible ? unappliedFilters(res.appliedFilter ?? l.filter) : [],
          }
        : null;
    const prev = monCache.current.get(p.panelId);
    if (
      prev &&
      prev.markers.length === markers.length &&
      prev.markers.every((m, i) => m === markers[i]) &&
      JSON.stringify(prev.lens) === JSON.stringify(lensProps)
    )
      return prev;
    const next: PanelMonitoring = {
      markers,
      onMarkPoint,
      onMonitorSelection,
      onOpenMonitoring,
      lens: lensProps,
    };
    monCache.current.set(p.panelId, next);
    return next;
  };

  const kernel = mode === "kernel";
  const sidebar: SidebarData = {
    workspaces: workspaces.length
      ? workspaces.map((w) => ({ id: w.id, name: w.objective }))
      : [{ id: workspaceId, name: kernel ? "Workspace" : "Fixture workspace" }],
    activeWorkspaceId: workspaceId,
    investigations: conv.investigations.map((r) => ({
      id: r.runId,
      title: r.questionSummary,
      state: r.state,
      updated: r.updatedAt,
    })),
    sources,
    reports: conv.investigations
      .filter((r) => r.terminal)
      .map((r) => ({ id: r.runId, title: r.questionSummary })),
    user,
  };
  const commands: PaletteCommand[] = [
    { id: "ask", label: "Ask a research question", group: "Agent", shortcut: "⌘J", run: askNow },
    {
      id: "chat",
      label: chatOpen ? "Hide agent panel" : "Show agent panel",
      group: "Agent",
      run: () => setChatOpen((o) => !o),
    },
    {
      id: "theme",
      label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      group: "View",
      keywords: ["dark", "light", "appearance"],
      run: toggleTheme,
    },
    {
      id: "canvas",
      label: "Go to canvas",
      group: "Navigate",
      run: () => {
        navigateView("canvas");
        document.getElementById("main")?.scrollTo({ top: 0 });
      },
    },
    ...(mon.api
      ? [
          {
            id: "monitoring",
            label: "Open monitoring",
            group: "Navigate",
            keywords: ["markers", "rules", "lens", "notifications", "triggers"],
            run: () => navigateView("monitoring"),
          },
        ]
      : []),
    { id: "settings", label: "Open settings", group: "Navigate", run: () => navigateView("settings") },
    ...workspaces
      .filter((w) => w.id !== workspaceId)
      .map((w) => ({
        id: `ws-${w.id}`,
        label: `Open workspace: ${w.objective}`,
        group: "Navigate",
        run: () => window.location.assign(kernelWorkspaceUrl(w.id, source)),
      })),
    ...(doc?.panels ?? []).map((p) => ({
      id: `panel-${p.panelId}`,
      label: p.title,
      group: "Panels",
      hint: p.kind,
      run: () => focusPanel(p.panelId),
    })),
    ...conv.investigations.map((r) => ({
      id: `run-${r.runId}`,
      label: r.questionSummary,
      group: "Investigations",
      hint: r.state,
      run: () => {
        setChatOpen(true);
        conv.openRun(r.runId, r.questionSummary);
      },
    })),
  ];
  /** The source is part of the URL (single source of truth, shareable); switching reloads the canvas on the other layer. */
  const switchSource = (next: "fixture" | "live") => {
    if (next === source) return;
    const u = new URL(window.location.href);
    if (next === "live") u.searchParams.set("source", "live");
    else u.searchParams.delete("source");
    u.searchParams.set("backend", "kernel");
    if (next === "fixture" && !u.searchParams.has("data")) u.searchParams.set("data", "semantic");
    window.location.assign(u.toString());
  };
  const devSignIn = async () => {
    if (!(await signInDev())) {
      setToast("Dev sign-in failed. Run pnpm dev:seed and check that the API is running.");
      return;
    }
    const mine = await listWorkspaces();
    if (!mine.length) {
      setToast("Signed in, but there is no workspace yet. Run pnpm dev:seed.");
      setSignedIn(true);
      return;
    }
    const here = mine.find((w) => w.id === workspaceId) ?? mine[0]!;
    window.location.assign(kernelWorkspaceUrl(here.id, source));
  };
  const run = conv.activeRun;
  const runIndicator =
    run?.budget && !run.run.terminal
      ? {
          label: "Tokens",
          used: run.budget.tokens.used ?? 0,
          total: run.budget.tokens.total,
        }
      : null;
  const onSubmit = async (q: string) => {
    if (!kernel) {
      setToast("Questions need the kernel backend. Open this workspace with ?backend=kernel.");
      return;
    }
    await conv.submit(q);
  };

  return (
    <>
      <AppShell
        sidebarCollapsed={navCollapsed}
        chatOpen={chatOpen}
        mobileNavOpen={mobileNav}
        onDismissOverlays={() => {
          setMobileNav(false);
          setChatOpen(false);
        }}
        sidebar={
          <Sidebar
            data={sidebar}
            active={view}
            monitoring={mon.api ? { unread: mon.unread } : undefined}
            research={kernel}
            onSwitchWorkspace={(id) => window.location.assign(kernelWorkspaceUrl(id, source))}
            collapsed={navCollapsed}
            onToggleCollapsed={() => setNavCollapsed((c) => !c)}
            footerExtra={
              devLogin && !signedIn ? (
                <button type="button" className="nz-btn" data-testid="dev-signin" onClick={devSignIn}>
                  Sign in (dev)
                </button>
              ) : null
            }
            onNavigate={(key) => {
              setMobileNav(false);
              if (key.startsWith("page:")) {
                // Research pages are separate routes of the same workspace (kernel workspaces only).
                window.location.assign(
                  `/w/${workspaceId}/${key.slice(5)}${source === "live" ? "?source=live" : ""}`,
                );
                return;
              }
              if (key.startsWith("inv:")) {
                const id = key.slice(4);
                setChatOpen(true);
                conv.openRun(id, conv.investigations.find((r) => r.runId === id)?.questionSummary);
              } else if (
                key === "settings" ||
                key === "monitoring" ||
                key === "canvas" ||
                key.startsWith("rep:")
              )
                navigateView(key);
            }}
          />
        }
        topbar={
          <TopBar
            crumbs={[
              { label: kernel ? "Workspace" : "Fixture workspace" },
              {
                label:
                  view === "settings"
                    ? "Settings"
                    : view === "monitoring"
                      ? "Monitoring"
                      : reportRunId
                        ? "Report"
                        : "Canvas",
              },
            ]}
            connection={connection}
            run={runIndicator}
            onOpenPalette={() => setPaletteOpen(true)}
            chatOpen={chatOpen}
            onToggleChat={() => setChatOpen((o) => !o)}
            onOpenNav={() => setMobileNav(true)}
            theme={theme}
            onToggleTheme={toggleTheme}
            actions={
              <>
                {kernel && (
                  <div
                    className="nz-segmented"
                    role="group"
                    aria-label="Data source"
                    data-testid="source-switch"
                    data-source={source}
                  >
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-pressed={source === "fixture"}
                      onClick={() => switchSource("fixture")}
                      data-testid="source-fixture"
                    >
                      Fixture (SYNTHETIC)
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-pressed={source === "live"}
                      onClick={() => switchSource("live")}
                      data-testid="source-live"
                    >
                      Live (LIVE)
                    </Button>
                  </div>
                )}
                {mon.api && (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="notifications-bell"
                    aria-label={`Notifications, ${mon.unread} unread`}
                    onClick={() => {
                      setMonUi({ tab: "notifications" });
                      navigateView("monitoring");
                    }}
                  >
                    Alerts{mon.unread ? ` (${mon.unread})` : ""}
                  </Button>
                )}
                <span className="nz-sb-meta nz-tabular" data-testid="document-revision">
                  doc rev {doc?.revision ?? "…"}
                </span>
                <span className="nz-sb-meta nz-tabular" data-testid="data-revision">
                  data rev {doc?.dataRevision ?? "…"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void undo()}
                  disabled={!undoStack.length}
                  data-testid="undo"
                >
                  Undo
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void redo()}
                  disabled={!redoStack.length}
                  data-testid="redo"
                >
                  Redo
                </Button>
              </>
            }
          />
        }
        dock={
          <AgentChatPanel
            thread={conv.thread}
            runs={conv.runs}
            onSubmit={onSubmit}
            onCancel={conv.cancel}
            onDecide={conv.decide}
            onAddToCanvas={(_runId, panelId) => focusPanel(panelId)}
            onOpenCitation={openCitation}
            onClose={() => setChatOpen(false)}
            error={conv.error}
            budgetNote={BUDGET_NOTE}
          />
        }
      >
        {source === "live" && (
          <HonestyBanner data-testid="live-banner">
            LIVE data: real provider data from the live layer. Gaps stay gaps, partial days are labelled, and
            each panel shows its source watermark. Questions you ask here are answered from the same live
            layer.
          </HonestyBanner>
        )}
        {connection !== "live" && view === "canvas" && (
          <HonestyBanner data-testid="connection-banner">
            {denied
              ? "Live updates stopped: this session no longer has access to the workspace. Sign in again."
              : connection === "reconnecting"
                ? "Live updates paused: reconnecting. The data shown may be out of date."
                : connection === "reload_required"
                  ? "Live updates were interrupted; reloading the latest state."
                  : "Offline: live updates stopped. The data shown may be out of date."}{" "}
            {connection === "offline" && !denied && backendRef.current instanceof KernelBackend && (
              <button
                type="button"
                className="nz-btn"
                data-testid="stream-retry"
                onClick={() => (backendRef.current as KernelBackend).retryStream()}
              >
                Retry now
              </button>
            )}
          </HonestyBanner>
        )}
        {sourceFeedError && (
          <HonestyBanner data-testid="source-feed-error">
            The source freshness feed is unavailable. Freshness of the data shown is unknown, not fresh.
          </HonestyBanner>
        )}
        {loadError && (
          <div className="nz-state" role="alert" data-testid="workspace-error">
            <p>
              Could not load this workspace ({loadError}). Nothing is shown rather than stale or partial data.
            </p>
            <button
              type="button"
              className="nz-btn"
              data-testid="workspace-retry"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        )}
        {mode === "fixture" && (
          <HonestyBanner data-testid="mode-badge">fixture mode · SYNTHETIC data</HonestyBanner>
        )}
        {view === "settings" && (
          <SettingsView
            workspaceId={workspaceId}
            workspaceName={sidebar.workspaces.find((w) => w.id === workspaceId)?.name ?? "Workspace"}
            mode={mode}
            source={source}
            theme={theme}
            user={user.name}
            signedIn={signedIn}
            onToggleTheme={toggleTheme}
            onSwitchSource={switchSource}
            onBack={() => navigateView("canvas")}
          />
        )}
        {view === "monitoring" && (
          <MonitoringView
            store={mon}
            ui={monUi}
            setUi={setMonUi}
            panels={(doc?.panels ?? []).map((p) => ({ panelId: p.panelId, title: p.title }))}
            sources={sources.map((s) => ({ id: s.id, freshness: s.freshness }))}
            metrics={Array.from(new Set((doc?.panels ?? []).flatMap((p) => p.encoding.y ?? [])))}
            selectionInterval={latestSelection?.interval ?? null}
            lens={lens}
            onApplyLens={applyLens}
            onFocusPanel={(id) => {
              navigateView("canvas");
              setTimeout(() => focusPanel(id), 80);
            }}
            onOpenEvidence={(id) => {
              // The evidence graph page; `node` carries the linked node id so the explorer can select it.
              window.location.assign(`/w/${workspaceId}/evidence?node=${encodeURIComponent(id)}`);
            }}
            onNotice={setToast}
            onBack={() => navigateView("canvas")}
          />
        )}
        {reportRunId && (
          <ReportView
            runId={reportRunId}
            title={conv.investigations.find((r) => r.runId === reportRunId)?.questionSummary ?? "Report"}
            model={conv.runs[reportRunId] ?? null}
            unavailable={mode !== null && mode !== "kernel"}
            sourceLabel={source === "live" ? "LIVE" : "SYNTHETIC"}
            onBack={() => navigateView("canvas")}
            onOpenPanel={(h) => {
              navigateView("canvas");
              setTimeout(() => openCitation({ queryHash: h }), 80);
            }}
          />
        )}
        {view === "canvas" && doc && doc.panels.length === 0 && doc.invalid.length === 0 && (
          <WorkspaceOnboarding onAsk={askNow} />
        )}
        {view === "canvas" && (
          <div className="nz-canvas">
            {doc?.invalid.map((i) => (
              <InvalidPanel key={`inv-${i.index}`} index={i.index} raw={i.raw} issues={i.issues} />
            ))}
            {doc?.panels.map((p) => (
              <Panel
                key={p.panelId}
                panel={p}
                runtime={runtimes[p.panelId] ?? initialRuntime()}
                data={data[p.queryRef.hash] ?? null}
                markers={canvasMarkers[p.panelId] ?? NO_MARKERS}
                monitoring={panelMonitoring(p)}
                graph={p.kind === "evidenceGraph" ? graph : null}
                entering={entering.has(p.panelId)}
                onMove={move}
                onBrush={select}
                onKeyboardRange={select}
                onMarkRange={markRange}
                onResize={resize}
                onThreshold={addThreshold}
                onGraphLayout={saveLayout}
                staggerMount={doc.panels.length > 12}
                hasSelection={Boolean(
                  pendingSel[p.panelId] ?? doc.selections.find((s) => s.panelId === p.panelId),
                )}
              />
            ))}
          </div>
        )}
      </AppShell>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      {toast && (
        <div className="nz-toast" role="alert" data-testid="toast">
          {toast}
        </div>
      )}
    </>
  );
}
