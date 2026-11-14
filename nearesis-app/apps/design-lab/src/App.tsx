import { useEffect, useState } from "react";
import { BenchPage } from "./pages/BenchPage";
import { ChartsPage } from "./pages/ChartsPage";
import { ComponentsPage } from "./pages/ComponentsPage";
import { WorkspaceScreen } from "./pages/WorkspaceScreen";

export const ROUTES = [
  ["workspace", "Workspace (shell + canvas + agent panel)"],
  ["workspace-empty", "Workspace, empty onboarding"],
  ["workspace-states", "Workspace, stale / error / loading / invalid panels"],
  ["workspace-approval", "Workspace, agent waiting on approval"],
  ["workspace-complete", "Workspace, run complete with abstention and panels"],
  ["workspace-blocked", "Workspace, run blocked"],
  ["components", "Component gallery"],
  ["charts", "Chart theme: every kind"],
  ["bench", "Chart benchmark (C18 thresholds)"],
] as const;

function useHash() {
  const [h, setH] = useState(() => location.hash.replace(/^#\/?/, "") || "index");
  useEffect(() => {
    const f = () => setH(location.hash.replace(/^#\/?/, "") || "index");
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return h;
}

export function App() {
  const route = useHash();
  switch (route.split("?")[0]) {
    case "workspace":
      return <WorkspaceScreen variant="baseline" />;
    case "workspace-empty":
      return <WorkspaceScreen variant="empty" />;
    case "workspace-states":
      return <WorkspaceScreen variant="states" />;
    case "workspace-approval":
      return <WorkspaceScreen variant="baseline" seed="approval" />;
    case "workspace-complete":
      return <WorkspaceScreen variant="baseline" seed="complete" />;
    case "workspace-blocked":
      return <WorkspaceScreen variant="baseline" seed="blocked" />;
    case "components":
      return <ComponentsPage />;
    case "charts":
      return <ChartsPage />;
    case "bench":
      return <BenchPage />;
    default:
      return (
        <div className="lab-page lab-index">
          <h1>Nearesis design lab</h1>
          <p style={{ color: "var(--fg-muted)" }}>
            All data is SYNTHETIC. Add ?theme=dark and ?motion=reduced to any URL.
          </p>
          <ul>
            {ROUTES.map(([r, label]) => (
              <li key={r}>
                <a href={`#/${r}`}>{label}</a>
              </li>
            ))}
          </ul>
        </div>
      );
  }
}
