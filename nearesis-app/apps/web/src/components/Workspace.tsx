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
import { InvalidPanel, Panel } from "./Panel.tsx";
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
  const [entering, setEntering] = useState<Set<string>>(new Set());
  const [sources, setSources] = useState<SidebarData["sources"]>([]);
  const [user, setUser] = useState<{ name: string }>({ name: "Signed out" });
  const conv = useRunConversation(workspaceId, mode === "kernel");
  const convRef = useRef(conv);
  convRef.current = conv;
  const docRef = useRef(doc);
  docRef.current = doc;
  const dataRef = useRef(data);
  dataRef.current = data;
  const loadedRef = useRef(new Set<string>());

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
    let srcTimer: ReturnType<typeof setInterval> | null = null;
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
      b.onReload = () => {
        setConnection("reload_required");
        void loadDoc().then(() => setConnection("live"));
      };
      hooks().eventStore = b.store;
      void fetch("/api/session", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((u: { subject?: string | null } | null) => {
          if (u?.subject) setUser({ name: u.subject });
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
            .then((r) => (r.ok ? r.json() : null))
            .then((w: Record<string, { state: string; newestEventTime: string | null }> | null) => {
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
            .catch(() => undefined);
        void loadSources();
        srcTimer = setInterval(() => void loadSources(), 5000);
      }
    }
    const goOffline = () => setConnection("offline");
    const goOnline = () => setConnection("live");
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    setChatOpen(window.innerWidth > 900);
    let unsub = () => {};
    void (async () => {
      const d = await loadDoc();
      if (b.mode === "kernel") setChatOpen(window.innerWidth > 900 && d.panels.length === 0);
      else setChatOpen(false);
      await Promise.all(d.panels.map(loadPanel));
      unsub = b.subscribe(onEvent);
      hooks().ready = true;
    })();
    return () => {
      unsub();
      if (srcTimer) clearInterval(srcTimer);
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
        status: "ACTIVE",
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
  }, [doc]);

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

  const kernel = mode === "kernel";
  const sidebar: SidebarData = {
    workspaces: [{ id: workspaceId, name: kernel ? "Workspace" : "Fixture workspace" }],
    activeWorkspaceId: workspaceId,
    investigations: conv.investigations.map((r) => ({
      id: r.runId,
      title: r.questionSummary,
      state: r.state,
      updated: r.updatedAt,
    })),
    sources,
    reports: [],
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
      run: () => document.getElementById("main")?.scrollTo({ top: 0 }),
    },
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
            active="canvas"
            collapsed={navCollapsed}
            onToggleCollapsed={() => setNavCollapsed((c) => !c)}
            onNavigate={(key) => {
              setMobileNav(false);
              if (key.startsWith("inv:")) {
                const id = key.slice(4);
                setChatOpen(true);
                conv.openRun(id, conv.investigations.find((r) => r.runId === id)?.questionSummary);
              } else if (key === "settings") setToast("Settings are not available yet.");
            }}
          />
        }
        topbar={
          <TopBar
            crumbs={[{ label: kernel ? "Workspace" : "Fixture workspace" }, { label: "Canvas" }]}
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
            each panel shows its source watermark. The agent still queries through the worker's configured
            gateway.
          </HonestyBanner>
        )}
        {mode === "fixture" && (
          <HonestyBanner data-testid="mode-badge">fixture mode · SYNTHETIC data</HonestyBanner>
        )}
        {doc && doc.panels.length === 0 && doc.invalid.length === 0 && <WorkspaceOnboarding onAsk={askNow} />}
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
              markers={markersByPanel[p.panelId] ?? []}
              graph={p.kind === "evidenceGraph" ? graph : null}
              entering={entering.has(p.panelId)}
              onMove={(dx, dy) => move(p, dx, dy)}
              onBrush={(a, b) => select(p, a, b)}
              onKeyboardRange={(a, b) => select(p, a, b)}
              onMarkRange={() => markRange(p)}
              onResize={(dw, dh) => resize(p, dw, dh)}
              onThreshold={(v) => addThreshold(p, v)}
              onGraphLayout={saveLayout}
              hasSelection={Boolean(
                pendingSel[p.panelId] ?? doc.selections.find((s) => s.panelId === p.panelId),
              )}
            />
          ))}
        </div>
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
