import { useCallback, useEffect, useRef, useState } from "react";
import { AgentsTab } from "./AgentsTab.tsx";
import { Overview } from "./Overview.tsx";
import { ReportsTab } from "./ReportsTab.tsx";
import { TasksTab } from "./TasksTab.tsx";
import { TestsTab } from "./TestsTab.tsx";
import type { TestView } from "./types.ts";
import { useHashRoute, useMonitorState, useNow } from "./util.ts";

const TABS = ["overview", "agents", "tests", "tasks", "reports"] as const;

type DrawerState = { kind: "file"; path: string } | { kind: "test"; test: TestView } | null;

async function fetchText(path: string): Promise<string> {
  try {
    const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    return r.ok ? await r.text() : `Error ${r.status}: ${await r.text()}`;
  } catch (e) {
    return `Failed to load: ${(e as Error).message}`;
  }
}

export function App() {
  const { state, conn, lastAt } = useMonitorState();
  const now = useNow();
  const [tab, sub, go] = useHashRoute();
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const openFile = useCallback((path: string) => setDrawer({ kind: "file", path }), []);

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const connLabel =
    conn === "live"
      ? "Live"
      : conn === "reconnecting"
        ? "Reconnecting"
        : `Disconnected — showing snapshot from ${state ? new Date(state.generatedAt).toLocaleTimeString() : (lastAt ?? "never")}`;

  const onTabKey = (e: React.KeyboardEvent, i: number): void => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const n = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length]!;
      go(n);
      setTimeout(() => document.getElementById(`tab-${n}`)?.focus(), 0);
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="topin">
          <h1>Nearesis build monitor</h1>
          <span className={`conn conn-${conn}`} data-testid="conn" role="status">
            <i className="cdot" />
            {connLabel}
          </span>
          <span className="muted snap">
            {state ? `snapshot ${new Date(state.generatedAt).toLocaleTimeString()}` : ""}
          </span>
        </div>
        <nav className="tabs" role="tablist" aria-label="Sections">
          {TABS.map((t, i) => (
            <button
              key={t}
              id={`tab-${t}`}
              role="tab"
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
              className={tab === t ? "tab on" : "tab"}
              onClick={() => go(t)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {!state ? (
          <p className="muted">Connecting to the monitor stream…</p>
        ) : (
          <div role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {state.notes.length > 0 && <p className="note">{state.notes.join(" | ")}</p>}
            {tab === "overview" && <Overview s={state} now={now} openFile={openFile} go={go} />}
            {tab === "agents" && <AgentsTab s={state} now={now} />}
            {tab === "tests" && (
              <TestsTab
                s={state}
                now={now}
                focusGate={sub}
                openTest={(t) => setDrawer({ kind: "test", test: t })}
              />
            )}
            {tab === "tasks" && <TasksTab s={state} />}
            {tab === "reports" && <ReportsTab s={state} now={now} openFile={openFile} />}
          </div>
        )}
      </main>
      {drawer && <Drawer drawer={drawer} close={() => setDrawer(null)} openFile={openFile} />}
    </>
  );
}

function Drawer({
  drawer,
  close,
  openFile,
}: {
  drawer: NonNullable<DrawerState>;
  close: () => void;
  openFile: (p: string) => void;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, [drawer]);
  const title = drawer.kind === "file" ? drawer.path : `${drawer.test.testId} ${drawer.test.name}`;
  return (
    <>
      <div className="scrim" onClick={close} />
      <aside className="drawer" role="dialog" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="drawer-head">
          <strong className="grow">{title}</strong>
          <button className="chip" onClick={close} aria-label="Close drawer (Esc)">
            Close
          </button>
        </div>
        {drawer.kind === "file" ? (
          <FileBody path={drawer.path} />
        ) : (
          <TestBody t={drawer.test} openFile={openFile} />
        )}
      </aside>
    </>
  );
}

function FileBody({ path }: { path: string }) {
  const [text, setText] = useState("Loading…");
  useEffect(() => {
    let live = true;
    void fetchText(path).then((t) => live && setText(t));
    return () => {
      live = false;
    };
  }, [path]);
  return <pre data-testid="viewer-text">{text}</pre>;
}

function TestBody({ t, openFile }: { t: TestView; openFile: (p: string) => void }) {
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const latest = t.history[0];
  useEffect(() => {
    let live = true;
    setDetail(null);
    if (latest) {
      void fetchText(latest.path).then((x) => {
        try {
          if (live) setDetail(JSON.parse(x) as Record<string, unknown>);
        } catch {
          /* not json */
        }
      });
    }
    return () => {
      live = false;
    };
  }, [latest?.path]);
  const field = (k: string): string => (detail && detail[k] != null ? String(detail[k]) : "");
  return (
    <div className="drawer-body">
      <h3>PASS condition</h3>
      <p>{t.passCondition || "unavailable"}</p>
      <p className="muted">
        Owner {t.owner || "unknown"} · {t.implemented ? "implemented" : "not implemented"} · latest{" "}
        {t.latestVerdict}
      </p>
      {detail && (
        <>
          <h3>Expected</h3>
          <pre>{field("expected")}</pre>
          <h3>Observed</h3>
          <pre>{field("observed")}</pre>
          {field("failureReason") && (
            <>
              <h3>Failure reason</h3>
              <pre>{field("failureReason")}</pre>
            </>
          )}
        </>
      )}
      <h3>Run history ({t.history.length})</h3>
      {t.history.length === 0 && <p className="muted">No runs recorded.</p>}
      <ul className="rowlist">
        {t.history.map((h) => (
          <li key={h.runId}>
            <button className="rowbtn" onClick={() => openFile(h.path)}>
              <span
                className={`pill pill-${h.verdict === "PASS" ? "PASS" : h.verdict === "FAIL" ? "FAIL" : "BLOCKED"}`}
              >
                {h.verdict}
              </span>
              <span className="mono grow">{h.runId}</span>
              <span className="mono muted">{h.commitSha.slice(0, 7)}</span>
              <span className="muted">{h.executedAt}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
