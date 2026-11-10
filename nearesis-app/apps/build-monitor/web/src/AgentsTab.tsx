import { useMemo, useState } from "react";
import { CapacityMeter } from "./Overview.tsx";
import type { AgentView, EngineView, State } from "./types.ts";
import { ageOf, orNA, relAge } from "./util.ts";

const RANK: Record<string, number> = {
  RUNNING: 0,
  STALE: 1,
  BLOCKED: 2,
  INVALID: 3,
  WAITING: 4,
  QUEUED: 5,
  FAILED: 6,
  DONE: 7,
};

export function AgentsTab({ s, now }: { s: State; now: number }) {
  const [sort, setSort] = useState<"status" | "heartbeat">("status");
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = useMemo(() => {
    const r = [...s.agents];
    r.sort((a, b) =>
      sort === "status"
        ? (RANK[a.effectiveStatus] ?? 9) - (RANK[b.effectiveStatus] ?? 9) ||
          a.agentId.localeCompare(b.agentId)
        : (a.heartbeatAgeMs ?? Infinity) - (b.heartbeatAgeMs ?? Infinity),
    );
    return r;
  }, [s.agents, sort]);
  return (
    <>
      <div className="grid2">
        <EngineCard
          label="Engine A"
          id="A"
          v={s.engines.A}
          lim={s.limits.ENGINE_A}
          engine="ENGINE_A"
          now={now}
        />
        <EngineCard
          label="Engine B"
          id="B"
          v={s.engines.B}
          lim={s.limits.ENGINE_B}
          engine="ENGINE_B"
          now={now}
        />
      </div>
      <section className="card">
        <h2>Subagents</h2>
        {(s.limits.ENGINE_A.breach || s.limits.ENGINE_B.breach) && (
          <p className="bad">Agent limit breached.</p>
        )}
        <div className="scrollx">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Engine</th>
                <th>Task</th>
                <th>
                  <button
                    className="th-btn"
                    onClick={() => setSort("status")}
                    aria-sort={sort === "status" ? "ascending" : "none"}
                  >
                    Status{sort === "status" ? " ▲" : ""}
                  </button>
                </th>
                <th>
                  <button
                    className="th-btn"
                    onClick={() => setSort("heartbeat")}
                    aria-sort={sort === "heartbeat" ? "ascending" : "none"}
                  >
                    Heartbeat{sort === "heartbeat" ? " ▲" : ""}
                  </button>
                </th>
                <th>Tests P/F</th>
                <th>Blockers</th>
                <th>Commit</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No agent records yet.
                  </td>
                </tr>
              )}
              {rows.map((a) => (
                <AgentRow
                  key={a.agentId}
                  a={a}
                  open={openId === a.agentId}
                  toggle={() => setOpenId(openId === a.agentId ? null : a.agentId)}
                  now={now}
                />
              ))}
              {s.declaredAgents
                .filter((d) => !d.hasRecord)
                .map((d) => (
                  <tr key={"d" + d.agentId} className="muted">
                    <td>{d.agentId}</td>
                    <td>{d.engine}</td>
                    <td>{d.taskId}</td>
                    <td colSpan={5}>declared, no record (telemetry unavailable)</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function AgentRow({
  a,
  open,
  toggle,
  now,
}: {
  a: AgentView;
  open: boolean;
  toggle: () => void;
  now: number;
}) {
  const r = a.record;
  return (
    <>
      <tr data-testid={`agent-${a.agentId}`} className={a.effectiveStatus === "STALE" ? "row-stale" : ""}>
        <td>
          <button className="rowbtn" aria-expanded={open} onClick={toggle}>
            <span className="mono">
              {open ? "▾" : "▸"} {a.agentId}
            </span>
          </button>
        </td>
        {r ? (
          <>
            <td>{r.parentEngine}</td>
            <td title={r.task}>{r.taskId}</td>
            <td>
              <span className={`pill pill-${a.effectiveStatus}`} data-testid={`status-${a.agentId}`}>
                {a.effectiveStatus}
              </span>
              {a.effectiveStatus !== r.status && <small className="muted"> record says {r.status}</small>}
            </td>
            <td>{relAge(now - Date.parse(r.heartbeatAt))}</td>
            <td className="mono">
              {r.testsPassed}/{r.testsFailed}
            </td>
            <td className="mono">{r.blockerIds.join(", ") || "-"}</td>
            <td className="mono">{r.commitSha?.slice(0, 10) ?? "-"}</td>
          </>
        ) : (
          <td colSpan={7} className="bad">
            <span className="pill pill-INVALID" data-testid={`status-${a.agentId}`}>
              INVALID
            </span>{" "}
            {a.error}
          </td>
        )}
      </tr>
      {open && r && (
        <tr className="expand">
          <td colSpan={8}>
            <div>
              <b>Task:</b> {r.task}
            </div>
            <div>
              <b>Started:</b> {r.startedAt} ({ageOf(r.startedAt, now)})
            </div>
            <div>
              <b>Owned paths:</b> <span className="mono">{r.ownedPaths.join(", ") || "none"}</span>
            </div>
            <div>
              <b>Blockers:</b> <span className="mono">{r.blockerIds.join(", ") || "none"}</span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function EngineCard({
  label,
  id,
  v,
  lim,
  engine,
  now,
}: {
  label: string;
  id: string;
  v: EngineView;
  lim: { active: number; max: number; breach: boolean };
  engine: string;
  now: number;
}) {
  const st = v.status;
  const banner =
    v.state === "NOT_STARTED"
      ? "NOT STARTED / no telemetry"
      : v.state === "STALE"
        ? `STALE (${relAge(v.heartbeatAgeMs)})`
        : v.state === "ACTIVE"
          ? `ACTIVE (${relAge(v.heartbeatAgeMs)})`
          : v.state;
  return (
    <section className="card" data-testid={`engine-${id}`}>
      <h2>
        {label}{" "}
        <span
          className={`pill ${v.state === "ACTIVE" ? "pill-PASS" : v.state === "NOT_STARTED" ? "pill-PENDING" : "pill-FAIL"}`}
        >
          {banner}
        </span>
      </h2>
      <CapacityMeter label={engine} {...lim} />
      {v.error && <p className="bad">INVALID: {v.error}</p>}
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
          <dd className="mono">{st.ownedModules.join(", ") || "none"}</dd>
          <dt>Active subagents</dt>
          <dd>{st.activeSubagents.join(", ") || "none reported"}</dd>
          <dt>Completed tasks</dt>
          <dd>{st.completedTasks.join(", ") || "none"}</dd>
          <dt>Blockers</dt>
          <dd>{st.blockers.join(", ") || "none"}</dd>
          <dt>Last heartbeat</dt>
          <dd>
            {st.heartbeatAt ? `${st.heartbeatAt} (${ageOf(st.heartbeatAt, now)})` : "telemetry unavailable"}
          </dd>
          <dt>Latest tests</dt>
          <dd>
            {st.latestTestResults
              ? `pass ${st.latestTestResults.passed} / fail ${st.latestTestResults.failed} / blocked ${st.latestTestResults.blocked}`
              : "telemetry unavailable"}
          </dd>
          <dt>Last commit</dt>
          <dd className="mono">
            {v.lastCommit
              ? `${v.lastCommit.sha.slice(0, 12)} (${v.lastCommit.source})`
              : "telemetry unavailable"}
          </dd>
        </dl>
      )}
    </section>
  );
}
