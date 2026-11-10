import { useEffect, useMemo, useState } from "react";
import type { AgentView, EngineView, ReportItem, State } from "./types.ts";

const TASK_COLORS: Record<string, string> = {
  READY: "var(--c-ready)",
  RUNNING: "var(--c-running)",
  WAITING_INTERFACE: "var(--c-wait-if)",
  WAITING_TESTS: "var(--c-wait-test)",
  WAITING_CREDENTIALS: "var(--c-wait-cred)",
  BLOCKED: "var(--c-blocked)",
  DONE: "var(--c-done)",
};
const VERDICT_CLASS: Record<string, string> = {
  PASS: "v-pass",
  FAIL: "v-fail",
  BLOCKED_DEPENDENCY: "v-blocked",
  NOT_RUN: "v-notrun",
};

function age(ms: number | null): string {
  if (ms === null) return "telemetry unavailable";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}
const orNA = (v: string | null | undefined): string => (v ? v : "telemetry unavailable");

export function useMonitorState(): { state: State | null; connected: boolean } {
  const [state, setState] = useState<State | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener("state", (e) => setState(JSON.parse((e as MessageEvent<string>).data) as State));
    return () => es.close();
  }, []);
  return { state, connected };
}

export function App() {
  const { state, connected } = useMonitorState();
  const [viewer, setViewer] = useState<{ title: string; text: string } | null>(null);
  const open = async (path: string): Promise<void> => {
    try {
      const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
      const text = r.ok ? await r.text() : `Error ${r.status}: ${await r.text()}`;
      setViewer({ title: path, text });
    } catch (e) {
      setViewer({ title: path, text: `Failed to load: ${(e as Error).message}` });
    }
  };
  if (!state)
    return (
      <main>
        <h1>Nearesis Build Monitor</h1>
        <p>Connecting to monitor stream...</p>
      </main>
    );
  return (
    <main>
      <header>
        <h1>Nearesis Build Monitor</h1>
        <span className={connected ? "pill ok" : "pill bad"} data-testid="conn">
          {connected ? "live" : "disconnected"}
        </span>
        <span className="muted">
          snapshot {state.generatedAt} | heartbeat timeout {state.heartbeatTimeoutMs / 60000} min
        </span>
      </header>
      {state.notes.length > 0 && <p className="note">{state.notes.join(" | ")}</p>}
      <Progress s={state} />
      <section>
        <h2>Engines</h2>
        <div className="grid2">
          <EngineCard label="Engine A" v={state.engines.A} />
          <EngineCard label="Engine B" v={state.engines.B} />
        </div>
      </section>
      <Agents s={state} />
      <TaskGraph s={state} />
      <Events s={state} />
      <Matrix s={state} open={open} />
      <Reports s={state} open={open} />
      {state.invalid.length > 0 && (
        <section>
          <h2>Invalid records ({state.invalid.length})</h2>
          <ul>
            {state.invalid.map((i, n) => (
              <li key={n} className="bad-text">
                <code>{i.path}</code>: {i.error}
              </li>
            ))}
          </ul>
        </section>
      )}
      {viewer && (
        <aside className="viewer" role="dialog" aria-label="file viewer">
          <div className="viewer-head">
            <strong>{viewer.title}</strong>
            <button onClick={() => setViewer(null)}>close</button>
          </div>
          <pre data-testid="viewer-text">{viewer.text}</pre>
        </aside>
      )}
    </main>
  );
}

function Progress({ s }: { s: State }) {
  return (
    <section>
      <h2>Overall progress</h2>
      <div className="stats">
        <Stat
          k="Milestone (evidence-based)"
          v={`${s.milestone.percent}%`}
          sub={`${s.milestone.passed} / ${s.milestone.total} required tests PASS`}
        />
        <Stat
          k="Phases completed"
          v={`${s.phases.completed} / ${s.phases.total}`}
          sub={`current: ${s.phases.current ?? "n/a"}`}
        />
        <Stat k="Blocked/failed gates" v={s.phases.blocked.length ? s.phases.blocked.join(", ") : "none"} />
        <Stat k="Required tests" v={String(s.counts.required)} sub={`${s.counts.implemented} implemented`} />
        <Stat k="Passed" v={String(s.counts.passed)} />
        <Stat k="Failed" v={String(s.counts.failed)} />
        <Stat k="Blocked" v={String(s.counts.blocked)} />
        <Stat k="Not run" v={String(s.counts.notRun)} />
      </div>
      <div className="gates">
        {s.gates.map((g) => (
          <div
            key={g.gate}
            className={`gate g-${g.verdict}`}
            title={`needs: ${g.upstream.join(", ") || "none"}`}
          >
            <strong>{g.gate}</strong>
            <span>
              {g.passed}/{g.total}
            </span>
            <small>{g.verdict}</small>
          </div>
        ))}
      </div>
      <h3>Latest integration results</h3>
      {s.latestResults.length === 0 ? (
        <p className="muted">No test evidence recorded yet.</p>
      ) : (
        <ul className="compact">
          {s.latestResults.map((r) => (
            <li key={r.testId + r.runId}>
              <span className={`tag ${VERDICT_CLASS[r.verdict] ?? ""}`}>{r.verdict}</span> {r.testId}{" "}
              <span className="muted">{r.executedAt}</span>
            </li>
          ))}
        </ul>
      )}
      <h3>Recent commits</h3>
      <ul className="compact mono">
        {s.commits.length === 0 && <li className="muted">git log unavailable</li>}
        {s.commits.map((c) => (
          <li key={c.sha}>
            {c.sha.slice(0, 8)} {c.subject} <span className="muted">({c.author})</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="muted">{k}</div>
      <div className="big">{v}</div>
      {sub && <div className="muted">{sub}</div>}
    </div>
  );
}

function EngineCard({ label, v }: { label: string; v: EngineView }) {
  const st = v.status;
  const banner =
    v.state === "NOT_STARTED"
      ? "NOT STARTED / no telemetry"
      : v.state === "STALE"
        ? `STALE heartbeat (${age(v.heartbeatAgeMs)})`
        : v.state === "ACTIVE"
          ? `ACTIVE (heartbeat ${age(v.heartbeatAgeMs)})`
          : v.state;
  return (
    <div className="card" data-testid={`engine-${label.slice(-1)}`}>
      <h3>
        {label}{" "}
        <span className={`pill ${v.state === "ACTIVE" ? "ok" : v.state === "NOT_STARTED" ? "idle" : "bad"}`}>
          {banner}
        </span>
      </h3>
      {v.error && <p className="bad-text">INVALID: {v.error}</p>}
      {st && (
        <dl>
          <dt>Name</dt>
          <dd>{st.name}</dd>
          <dt>Session</dt>
          <dd>{orNA(st.sessionId)}</dd>
          <dt>Current task</dt>
          <dd>{orNA(st.currentTask)}</dd>
          <dt>Model/runtime</dt>
          <dd>{orNA(st.model)}</dd>
          <dt>Phase</dt>
          <dd>{orNA(st.currentPhase)}</dd>
          <dt>Owned modules</dt>
          <dd>{st.ownedModules.join(", ") || "none"}</dd>
          <dt>Active subagents</dt>
          <dd>{st.activeSubagents.join(", ") || "none reported"}</dd>
          <dt>Completed tasks</dt>
          <dd>{st.completedTasks.join(", ") || "none"}</dd>
          <dt>Blockers</dt>
          <dd>{st.blockers.join(", ") || "none"}</dd>
          <dt>Last heartbeat</dt>
          <dd>{st.heartbeatAt ? `${st.heartbeatAt} (${age(v.heartbeatAgeMs)})` : "telemetry unavailable"}</dd>
          <dt>Latest tests</dt>
          <dd>
            {st.latestTestResults
              ? `pass ${st.latestTestResults.passed} / fail ${st.latestTestResults.failed} / blocked ${st.latestTestResults.blocked}`
              : "telemetry unavailable"}
          </dd>
        </dl>
      )}
      <p className="mono">
        Most recent commit:{" "}
        {v.lastCommit ? `${v.lastCommit.sha.slice(0, 12)} (${v.lastCommit.source})` : "telemetry unavailable"}
      </p>
    </div>
  );
}

function Agents({ s }: { s: State }) {
  const statusClass = (a: AgentView): string =>
    a.effectiveStatus === "RUNNING"
      ? "ok"
      : a.effectiveStatus === "STALE" || a.effectiveStatus === "INVALID" || a.effectiveStatus === "FAILED"
        ? "bad"
        : "idle";
  return (
    <section>
      <h2>Subagents</h2>
      <p>
        {(["ENGINE_A", "ENGINE_B"] as const).map((e) => {
          const l = s.limits[e];
          return (
            <span key={e} className={l.breach ? "pill bad" : "pill idle"} data-testid={`limit-${e}`}>
              {e}: {l.active} / {l.max} active{l.breach ? " - LIMIT BREACH" : ""}
            </span>
          );
        })}
      </p>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Engine</th>
            <th>Task</th>
            <th>Status</th>
            <th>Heartbeat</th>
            <th>Tests P/F</th>
            <th>Blockers</th>
            <th>Commit</th>
          </tr>
        </thead>
        <tbody>
          {s.agents.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                No agent records yet.
              </td>
            </tr>
          )}
          {s.agents.map((a) => (
            <tr key={a.agentId} data-testid={`agent-${a.agentId}`}>
              <td>{a.agentId}</td>
              {a.record ? (
                <>
                  <td>{a.record.parentEngine}</td>
                  <td title={a.record.task}>{a.record.taskId}</td>
                  <td>
                    <span className={`pill ${statusClass(a)}`} data-testid={`status-${a.agentId}`}>
                      {a.effectiveStatus}
                    </span>
                    {a.effectiveStatus !== a.record.status && (
                      <small className="muted"> (record says {a.record.status})</small>
                    )}
                  </td>
                  <td>{age(a.heartbeatAgeMs)}</td>
                  <td>
                    {a.record.testsPassed}/{a.record.testsFailed}
                  </td>
                  <td>{a.record.blockerIds.join(", ") || "-"}</td>
                  <td className="mono">{a.record.commitSha?.slice(0, 10) ?? "-"}</td>
                </>
              ) : (
                <td colSpan={7} className="bad-text">
                  <span className="pill bad" data-testid={`status-${a.agentId}`}>
                    INVALID
                  </span>{" "}
                  {a.error}
                </td>
              )}
            </tr>
          ))}
          {s.declaredAgents
            .filter((d) => !d.hasRecord)
            .map((d) => (
              <tr key={"decl-" + d.agentId} className="muted">
                <td>{d.agentId}</td>
                <td>{d.engine}</td>
                <td>{d.taskId}</td>
                <td colSpan={5}>declared, no record (telemetry unavailable)</td>
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}

function TaskGraph({ s }: { s: State }) {
  const W = 190,
    H = 46,
    GX = 50,
    GY = 18;
  const nodes = s.graph.nodes;
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    for (const n of nodes) m.set(n.id, { x: 10 + n.layer * (W + GX), y: 10 + n.order * (H + GY) });
    return m;
  }, [nodes]);
  const width = 20 + (s.graph.layers.length || 1) * (W + GX);
  const height = 20 + Math.max(1, ...s.graph.layers.map((l) => l.length)) * (H + GY);
  return (
    <section>
      <h2>Task dependency graph</h2>
      <div className="legend">
        {Object.entries(TASK_COLORS).map(([k, c]) => (
          <span key={k}>
            <i style={{ background: c }} /> {k}
          </span>
        ))}
      </div>
      {nodes.length === 0 ? (
        <p className="muted">No task board.</p>
      ) : (
        <div className="scroll">
          <svg width={width} height={height} role="img" aria-label="task dependency graph">
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
                  d={`M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`}
                  className="edge"
                  fill="none"
                />
              );
            })}
            {nodes.map((n) => {
              const p = pos.get(n.id)!;
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} data-testid={`task-${n.id}`}>
                  <rect width={W} height={H} rx={6} fill={TASK_COLORS[n.status] ?? "gray"} />
                  <text x={8} y={19} className="svgt">
                    {n.id}
                  </text>
                  <text x={8} y={36} className="svgs">
                    {n.status}
                  </text>
                  <title>{`${n.id}: ${n.title} [${n.status}]`}</title>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      {s.graph.missingDeps.length > 0 && (
        <p className="bad-text">
          Unknown dependencies: {s.graph.missingDeps.map((m) => `${m.task}->${m.dep}`).join(", ")}
        </p>
      )}
    </section>
  );
}

function Events({ s }: { s: State }) {
  const rows = [...s.events].reverse().slice(0, 100);
  return (
    <section>
      <h2>Live event stream</h2>
      {rows.length === 0 ? (
        <p className="muted">No events.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Kind</th>
              <th>Session</th>
              <th>Subject</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e, i) => (
              <tr key={i}>
                <td className="mono">{e.ts}</td>
                <td>{e.kind}</td>
                <td>{e.session}</td>
                <td>{e.subject}</td>
                <td>{e.detail ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Matrix({ s, open }: { s: State; open: (p: string) => void }) {
  return (
    <section>
      <h2>Test matrix ({s.tests.length})</h2>
      <p className="muted">
        Cell colour = latest evidence verdict. Dashed border = not implemented. Click a cell with evidence to
        view the JSON.
      </p>
      {s.tests.length === 0 && <p className="muted">No test index.</p>}
      {s.gates.map((g) => (
        <div key={g.gate} className="matrix-row">
          <strong>{g.gate}</strong>
          <div className="cells">
            {s.tests
              .filter((t) => t.gate === g.gate)
              .map((t) => (
                <button
                  key={t.testId}
                  className={`cell ${VERDICT_CLASS[t.latestVerdict] ?? ""} ${t.implemented ? "" : "unimpl"}`}
                  title={`${t.testId} ${t.name}\n${t.latestVerdict}${t.implemented ? "" : " | NOT_IMPLEMENTED"}`}
                  disabled={!t.evidencePath}
                  onClick={() => t.evidencePath && open(t.evidencePath)}
                  data-testid={`test-${t.testId}`}
                >
                  {t.testId}
                </button>
              ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function Reports({ s, open }: { s: State; open: (p: string) => void }) {
  const groups: [string, ReportItem[]][] = [
    ["Phase reports", s.reports.phase],
    ["Blockers", s.reports.blockers],
    ["Findings", s.reports.findings],
    ["Decisions", s.reports.decisions],
    ["Test evidence", s.reports.tests],
    ["Handoffs", s.reports.handoffs],
  ];
  return (
    <section>
      <h2>Reports</h2>
      <div className="grid3">
        {groups.map(([title, items]) => (
          <details key={title} open={title !== "Test evidence"}>
            <summary>
              {title} ({items.length})
            </summary>
            {items.length === 0 ? (
              <p className="muted">none yet</p>
            ) : (
              <ul className="compact">
                {items.slice(0, 60).map((r) => (
                  <li key={r.path}>
                    <button className="link" onClick={() => open(r.path)}>
                      {r.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </details>
        ))}
      </div>
    </section>
  );
}
