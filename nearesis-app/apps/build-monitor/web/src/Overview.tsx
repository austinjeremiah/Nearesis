import { useState } from "react";
import { PhaseChart } from "./PhaseChart.tsx";
import type { AgentView, State, WaitingItem } from "./types.ts";
import { GATE_NAMES, ageOf, collapseStarts, gatePill, pct, relAge } from "./util.ts";

export interface OverviewProps {
  s: State;
  now: number;
  openFile: (path: string, line?: number) => void;
  go: (tab: string, sub?: string) => void;
}

export function activeAgents(s: State): AgentView[] {
  return s.agents.filter((a) => a.effectiveStatus === "RUNNING");
}
export function staleAgents(s: State): AgentView[] {
  return s.agents.filter((a) => a.effectiveStatus === "STALE");
}

export function Overview({ s, now, openFile, go }: OverviewProps) {
  const active = activeAgents(s).length;
  const stale = staleAgents(s).length;
  const gatesPassed = s.gates.filter((g) => g.verdict === "PASS").length;
  return (
    <>
      <p className="lede" data-testid="lede">
        <b>{s.counts.passed}</b> of <b>{s.counts.required}</b> gate tests have passed at a commit.{" "}
        <b>{active}</b> agents are active and <b>{stale}</b> are stale. <b>{s.counts.failed}</b>{" "}
        {s.counts.failed === 1 ? "test is" : "tests are"} failing. <b>{s.waiting.length}</b>{" "}
        {s.waiting.length === 1 ? "item is" : "items are"} waiting on you.
      </p>
      <section className="tiles" aria-label="Headline figures">
        <div className="tile">
          <div className="k">Gate tests passed</div>
          <div className="v" data-testid="kpi-passed">
            {s.counts.passed} / {s.counts.required}
          </div>
          <div className="meter thin">
            <i style={{ width: `${pct(s.counts.passed, s.counts.required) * 100}%` }} />
          </div>
          <div className="s">evidence-based, at a commit</div>
        </div>
        <div className="tile">
          <div className="k">Gates passed</div>
          <div className="v">
            {gatesPassed} / {s.gates.length}
          </div>
          <div className="s">{s.phases.total} phases total; P06–P12 out of milestone</div>
        </div>
        <div className="tile">
          <div className="k">Agents active</div>
          <div className="v">{active}</div>
          <div className="s">
            of {s.limits.ENGINE_A.max} A + {s.limits.ENGINE_B.max} B allowed
            {stale > 0 && (
              <>
                {" "}
                · <span className="warn">{stale} stale</span>
              </>
            )}
            {stale === 0 && " · 0 stale"}
          </div>
        </div>
        <div className={`tile ${s.counts.failed > 0 ? "t-bad" : ""}`}>
          <div className="k">Failing tests</div>
          <div className={`v ${s.counts.failed > 0 ? "bad" : ""}`}>{s.counts.failed}</div>
          <div className="s">
            {s.counts.blocked} blocked · {s.counts.notRun} not run
          </div>
        </div>
        <div className={`tile ${s.waiting.length > 0 ? "t-warn" : ""}`}>
          <div className="k">Waiting on you</div>
          <div className={`v ${s.waiting.length > 0 ? "warn" : ""}`}>{s.waiting.length}</div>
          <div className="s">owner blockers and open queue items</div>
        </div>
      </section>

      <section className="card" id="phases">
        <h2>Phase completion</h2>
        <p className="note">
          Three bars per gate on a 0–100% scale. Nothing counts as passed without a recorded PASS verdict for
          that test; a gate also waits for its upstream gates.
        </p>
        <PhaseChart gates={s.gates} />
      </section>

      <Stepper s={s} go={go} />

      <div className="grid2">
        <WaitingCard items={s.waiting} now={now} openFile={openFile} />
        <AgentsNow s={s} now={now} />
      </div>
      <div className="grid2">
        <Activity s={s} now={now} />
        <Commits s={s} now={now} />
      </div>
      <InvalidBanner s={s} />
    </>
  );
}

function Stepper({ s, go }: { s: State; go: OverviewProps["go"] }) {
  return (
    <section className="card">
      <h2>Gate pipeline</h2>
      <div className="stepper" role="list">
        {s.gates.map((g) => {
          const pill = gatePill(g);
          return (
            <button
              key={g.gate}
              role="listitem"
              className={`step step-${pill}`}
              onClick={() => go("tests", g.gate)}
              title={`${g.gate}: ${g.passed}/${g.total} passed. ${g.upstream.length ? `Needs ${g.upstream.join(" + ")}` : "No upstream"}`}
            >
              <b>{g.gate}</b>
              <span>{GATE_NAMES[g.gate]}</span>
              <small>
                {g.passed}/{g.total} · {pill}
              </small>
              {g.upstream.length > 0 && <em>needs {g.upstream.join(" + ")}</em>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function WaitingCard({
  items,
  now,
  openFile,
}: {
  items: WaitingItem[];
  now: number;
  openFile: (p: string, line?: number) => void;
}) {
  return (
    <section className="card">
      <h2>Waiting on you</h2>
      {items.length === 0 ? (
        <p className="muted">Nothing is waiting on the owner.</p>
      ) : (
        <ul className="rowlist">
          {items.map((w) => (
            <li key={w.kind + w.id + (w.line ?? "")}>
              <button
                className="rowbtn wait"
                onClick={() => w.path && openFile(w.path, w.line)}
                title="Open in the reports drawer"
              >
                <span className="waitmeta">
                  <span className={`kind kind-${w.kind}`}>{w.kind}</span>
                  <span className="mono">{w.id.replace("BLK-20261110-", "BLK-")}</span>
                  {w.severity && <span className="muted sev">{w.severity.split(/[ (]/)[0]}</span>}
                  <span className="grow" />
                  <span className="muted">{ageOf(w.since, now)}</span>
                </span>
                <span className="clamp2" data-testid="wait-title">
                  {w.title}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CapacityMeter({
  label,
  active,
  max,
  breach,
}: {
  label: string;
  active: number;
  max: number;
  breach: boolean;
}) {
  const slots = Math.max(max, active);
  return (
    <div className="cap" data-testid={`limit-${label}`}>
      <div className="caphead">
        <span>{label.replace("ENGINE_", "Engine ")}</span>
        <span className={breach ? "bad" : "muted"}>
          {active}/{max}
          {breach ? " LIMIT BREACH" : ""}
        </span>
      </div>
      <div className="segs" aria-hidden="true">
        {Array.from({ length: slots }, (_, i) => (
          <i key={i} className={i < active ? (i >= max ? "on over" : "on") : ""} />
        ))}
      </div>
    </div>
  );
}

function AgentsNow({ s, now }: { s: State; now: number }) {
  const shown = s.agents.filter(
    (a) =>
      a.effectiveStatus === "RUNNING" ||
      a.effectiveStatus === "STALE" ||
      a.effectiveStatus === "BLOCKED" ||
      a.effectiveStatus === "INVALID",
  );
  return (
    <section className="card">
      <h2>Agents now</h2>
      <div className="caps">
        <CapacityMeter label="ENGINE_A" {...s.limits.ENGINE_A} />
        <CapacityMeter label="ENGINE_B" {...s.limits.ENGINE_B} />
      </div>
      {shown.length === 0 ? (
        <p className="muted">No active agent records.</p>
      ) : (
        <ul className="rowlist">
          {shown.map((a) => {
            const r = a.record;
            const st = a.effectiveStatus;
            return (
              <li key={a.agentId} className="arow" data-testid={`now-${a.agentId}`}>
                <span className={`dot dot-${st}`} title={st} />
                <span className="mono agent-id">{a.agentId}</span>
                <span className="grow">
                  {r ? r.taskId : <span className="bad">INVALID record</span>}
                  {st === "STALE" && r && (
                    <small className="warn">
                      {" "}
                      record says RUNNING · last heartbeat {relAge(a.heartbeatAgeMs)}
                    </small>
                  )}
                  {st !== "STALE" && st !== "RUNNING" && <small className="muted"> {st}</small>}
                </span>
                {r && (
                  <>
                    <span className="muted">{relAge(now - Date.parse(r.heartbeatAt))}</span>
                    <span className="mono muted">
                      {r.testsPassed}/{r.testsFailed}
                    </span>
                    <span className="mono muted">{r.commitSha?.slice(0, 7) ?? "-"}</span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const KIND_GLYPH: Record<string, [string, string]> = {
  "test.passed": ["✓", "ok"],
  "test.failed": ["✕", "bad"],
  "test.blocked": ["!", "warn"],
  "test.started": ["◌", "muted"],
  "commit.created": ["●", "accent"],
  "agent.started": ["▶", "ok"],
  "agent.stopped": ["■", "muted"],
  "subagent.spawned": ["▶", "ok"],
  "blocker.recorded": ["⚑", "warn"],
  "finding.recorded": ["◆", "warn"],
  "gate.passed": ["✓", "ok"],
  "gate.failed": ["✕", "bad"],
  "task.completed": ["✓", "accent"],
  "task.assigned": ["→", "muted"],
  heartbeat: ["·", "muted"],
};
const CHIPS: Record<string, (k: string) => boolean> = {
  All: () => true,
  Tests: (k) => k.startsWith("test.") || k.startsWith("gate."),
  Commits: (k) => k === "commit.created",
  Agents: (k) =>
    k.startsWith("agent.") || k === "subagent.spawned" || k === "task.assigned" || k === "task.completed",
  Blockers: (k) => k === "blocker.recorded" || k === "finding.recorded",
};

function Activity({ s, now }: { s: State; now: number }) {
  const [chip, setChip] = useState("All");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const PER_GROUP = 12;
  const match = CHIPS[chip] ?? CHIPS.All!;
  const rows = [...collapseStarts(s.events)]
    .reverse()
    .filter((e) => (chip === "All" ? e.kind !== "heartbeat" : match(e.kind)));
  const groups: [string, typeof rows][] = [
    ["Last 15 min", rows.filter((e) => now - Date.parse(e.ts) <= 15 * 60_000)],
    [
      "Last hour",
      rows.filter((e) => now - Date.parse(e.ts) > 15 * 60_000 && now - Date.parse(e.ts) <= 3600_000),
    ],
    ["Earlier", rows.filter((e) => now - Date.parse(e.ts) > 3600_000)],
  ];
  return (
    <section className="card">
      <h2>Activity</h2>
      <div className="chips" role="group" aria-label="Filter events">
        {Object.keys(CHIPS).map((c) => (
          <button
            key={c}
            className={`chip ${c === chip ? "on" : ""}`}
            aria-pressed={c === chip}
            onClick={() => setChip(c)}
          >
            {c}
          </button>
        ))}
      </div>
      {rows.length === 0 && <p className="muted">No events.</p>}
      {groups.map(([title, list]) => {
        const part = expanded[title] ? list : list.slice(0, PER_GROUP);
        return part.length === 0 ? null : (
          <div key={title}>
            <h3>{title}</h3>
            <ul className="rowlist">
              {part.map((e, i) => {
                const [g, c] = KIND_GLYPH[e.kind] ?? ["·", "muted"];
                return (
                  <li key={e.ts + i} className="evrow">
                    <span className={`glyph ${c}`} aria-hidden="true">
                      {g}
                    </span>
                    <span className="grow">
                      <b>{e.kind}</b> <span className="mono">{e.subject}</span>
                      {e.detail ? <span className="muted"> — {e.detail}</span> : null}
                    </span>
                    <span className="muted mono">{e.session}</span>
                    <span className="muted">{ageOf(e.ts, now)}</span>
                  </li>
                );
              })}
            </ul>
            {list.length > PER_GROUP && (
              <button
                className="chip"
                onClick={() => setExpanded({ ...expanded, [title]: !expanded[title] })}
              >
                {expanded[title] ? "show fewer" : `show more (${list.length - PER_GROUP})`}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Commits({ s, now }: { s: State; now: number }) {
  return (
    <section className="card">
      <h2>Recent commits</h2>
      {s.commits.length === 0 && <p className="muted">git log unavailable.</p>}
      <ul className="rowlist">
        {s.commits.map((c) => (
          <li key={c.sha} className={`crow ${/^(feat|fix|test)\(/.test(c.subject) ? "scoped" : ""}`}>
            <span className="mono accent">{c.sha.slice(0, 7)}</span>
            <span className="grow">{c.subject}</span>
            <span className="muted">{c.author}</span>
            <span className="muted">{ageOf(c.date, now)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InvalidBanner({ s }: { s: State }) {
  if (s.invalid.length === 0) return null;
  return (
    <details className="banner" data-testid="invalid-banner">
      <summary>{s.invalid.length} records failed schema validation — view</summary>
      <ul>
        {s.invalid.map((i, n) => (
          <li key={n}>
            <code>{i.path}</code>: {i.error}
          </li>
        ))}
      </ul>
    </details>
  );
}
