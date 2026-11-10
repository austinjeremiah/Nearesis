import { useMemo, useState } from "react";
import type { State } from "./types.ts";

export const TASK_COLORS: Record<string, string> = {
  READY: "var(--t-ready)",
  RUNNING: "var(--t-running)",
  WAITING_INTERFACE: "var(--t-wif)",
  WAITING_TESTS: "var(--t-wtest)",
  WAITING_CREDENTIALS: "var(--t-wcred)",
  BLOCKED: "var(--t-blocked)",
  DONE: "var(--t-done)",
};

export function TasksTab({ s }: { s: State }) {
  const [view, setView] = useState<"graph" | "list">("graph");
  const W = 210,
    H = 54,
    GX = 56,
    GY = 16;
  const nodes = s.graph.nodes;
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of nodes) m.set(n.id, { x: 12 + n.layer * (W + GX), y: 12 + n.order * (H + GY) });
    return m;
  }, [nodes]);
  const width = 24 + Math.max(1, s.graph.layers.length) * (W + GX);
  const height = 24 + Math.max(1, ...s.graph.layers.map((l) => l.length)) * (H + GY);
  return (
    <section className="card">
      <h2>Tasks</h2>
      <div className="chips">
        <button className={`chip ${view === "graph" ? "on" : ""}`} onClick={() => setView("graph")}>
          Graph
        </button>
        <button className={`chip ${view === "list" ? "on" : ""}`} onClick={() => setView("list")}>
          List
        </button>
      </div>
      <div className="legend">
        {Object.entries(TASK_COLORS).map(([k, c]) => (
          <span key={k}>
            <i className="sw" style={{ background: c }} />
            {k}
          </span>
        ))}
      </div>
      {nodes.length === 0 && <p className="muted">No task board.</p>}
      {view === "graph" && nodes.length > 0 && (
        <div className="scrollx dag">
          <svg width={width} height={height} role="img" aria-label="Task dependency graph">
            {s.graph.edges.map((e, i) => {
              const a = pos.get(e.from),
                b = pos.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + W,
                y1 = a.y + H / 2,
                x2 = b.x,
                y2 = b.y + H / 2;
              return (
                <path
                  key={i}
                  className="edge"
                  fill="none"
                  d={`M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`}
                />
              );
            })}
            {nodes.map((n) => {
              const p = pos.get(n.id)!;
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} data-testid={`task-${n.id}`}>
                  <rect width={W} height={H} rx={12} fill={TASK_COLORS[n.status] ?? "gray"} />
                  <text x={12} y={22} className="svgt">
                    {n.id.replace("T-", "")}
                  </text>
                  <text x={12} y={40} className="svgs">
                    {n.status.replace("WAITING_", "WAIT ")}
                  </text>
                  <rect x={W - 46} y={8} width={38} height={18} rx={9} className="badge" />
                  <text x={W - 27} y={21} textAnchor="middle" className="svgb">
                    {n.owner.replace("ENGINE_", "E")}
                  </text>
                  <title>{`${n.id}: ${n.title} [${n.status}] owner ${n.owner}`}</title>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      {view === "list" && (
        <div className="scrollx">
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Title</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Depends on</th>
                <th>Tests</th>
              </tr>
            </thead>
            <tbody>
              {s.tasks.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.id}</td>
                  <td>{t.title}</td>
                  <td>
                    <span
                      className="pill"
                      style={{ background: TASK_COLORS[t.status], color: "#fff", borderColor: "transparent" }}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td>{t.owner}</td>
                  <td className="mono">{t.dependsOn.join(", ") || "-"}</td>
                  <td className="mono">{t.tests.join(", ") || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s.graph.missingDeps.length > 0 && (
        <p className="bad">
          Unknown dependencies: {s.graph.missingDeps.map((m) => `${m.task}->${m.dep}`).join(", ")}
        </p>
      )}
    </section>
  );
}
