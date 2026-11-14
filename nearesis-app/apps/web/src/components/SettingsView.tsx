"use client";
import { Button } from "@nearesis/ui";
import { RENDERER_VERSION } from "../lib/chart-option.ts";

export interface SettingsViewProps {
  workspaceId: string;
  workspaceName: string;
  mode: "kernel" | "fixture" | null;
  source: "fixture" | "live";
  theme: "light" | "dark";
  user: string;
  signedIn: boolean;
  onToggleTheme: () => void;
  onSwitchSource: (s: "fixture" | "live") => void;
  onBack: () => void;
}

const SHORTCUTS: Array<[string, string]> = [
  ["Ctrl/Cmd+K", "Command palette"],
  ["Ctrl/Cmd+J", "Show or hide the agent panel"],
  ["Ctrl/Cmd+Z / Shift+Z", "Undo / redo canvas edits"],
  ["[", "Collapse the sidebar"],
  ["Alt+Arrow (panel focused)", "Move panel"],
  ["Alt+Shift+Arrow (panel focused)", "Resize panel"],
  ["Arrow / Shift+Arrow / Enter (chart focused)", "Cursor, extend range, commit selection"],
];

/** Workspace settings: only values the app actually applies or reports. Nothing here is a placeholder toggle. */
export function SettingsView(p: SettingsViewProps) {
  return (
    <article className="nz-page" data-testid="settings-page" aria-labelledby="settings-title">
      <header>
        <h1 id="settings-title">Settings</h1>
        <p className="nz-sb-meta">
          Preferences apply to this browser. Workspace facts are read from the backend.
        </p>
      </header>
      <section aria-labelledby="set-appearance">
        <h2 id="set-appearance">Appearance</h2>
        <dl className="nz-kv">
          <dt>Theme</dt>
          <dd>
            <Button size="sm" data-testid="settings-theme" onClick={p.onToggleTheme}>
              {p.theme === "dark" ? "Dark (switch to light)" : "Light (switch to dark)"}
            </Button>
          </dd>
        </dl>
      </section>
      <section aria-labelledby="set-data">
        <h2 id="set-data">Data source</h2>
        <dl className="nz-kv">
          <dt>Active layer</dt>
          <dd data-testid="settings-source">{p.source === "live" ? "Live (LIVE)" : "Fixture (SYNTHETIC)"}</dd>
          <dt>Switch</dt>
          <dd>
            <div className="nz-page-actions">
              <Button
                size="sm"
                aria-pressed={p.source === "fixture"}
                disabled={p.mode !== "kernel"}
                onClick={() => p.onSwitchSource("fixture")}
              >
                Fixture
              </Button>
              <Button
                size="sm"
                aria-pressed={p.source === "live"}
                disabled={p.mode !== "kernel"}
                onClick={() => p.onSwitchSource("live")}
              >
                Live
              </Button>
            </div>
            {p.mode !== "kernel" && <div className="nz-sb-meta">Needs the kernel backend.</div>}
          </dd>
        </dl>
      </section>
      <section aria-labelledby="set-ws">
        <h2 id="set-ws">Workspace</h2>
        <dl className="nz-kv">
          <dt>Name</dt>
          <dd>{p.workspaceName}</dd>
          <dt>Workspace id</dt>
          <dd className="nz-tabular">{p.workspaceId}</dd>
          <dt>Backend</dt>
          <dd>{p.mode ?? "loading"}</dd>
          <dt>Signed in as</dt>
          <dd>{p.signedIn ? p.user : "Signed out"}</dd>
          <dt>Chart renderer</dt>
          <dd className="nz-tabular">{RENDERER_VERSION}</dd>
        </dl>
      </section>
      <section aria-labelledby="set-keys">
        <h2 id="set-keys">Keyboard</h2>
        <dl className="nz-kv">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt className="nz-tabular">{k}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </section>
      <div className="nz-page-actions">
        <Button onClick={p.onBack} data-testid="back-to-canvas">
          Back to canvas
        </Button>
      </div>
    </article>
  );
}
