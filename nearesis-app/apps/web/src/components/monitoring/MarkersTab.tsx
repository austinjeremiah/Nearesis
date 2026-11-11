"use client";
import {
  AgentRole,
  type Marker,
  type MarkerStatus,
  MARKER_TRANSITIONS,
  type MarkerTask,
} from "@nearesis/contracts";
import { Button } from "@nearesis/ui";
import { useEffect, useState } from "react";
import type { Delegation } from "../../lib/monitoring/api.ts";
import type { MonitoringStore } from "../../lib/monitoring/use-monitoring.ts";
import {
  describeAnchor,
  explainReason,
  fmtTime,
  MarkerStatusBadge,
  ModeBadge,
  STATUS_LABEL,
} from "./shared.tsx";

const ROLES = AgentRole.options.filter((r) => r !== "director");

export interface PanelRef {
  panelId: string;
  title: string;
}

export function MarkersTab(p: {
  store: MonitoringStore;
  panels: PanelRef[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onFocusPanel: (panelId: string) => void;
  onOpenEvidence: (evidenceId: string) => void;
  onNotice: (msg: string) => void;
}) {
  const { store } = p;
  const markers = store.data.markers;
  const sel = markers.find((m) => m.markerId === p.selectedId) ?? null;
  return (
    <div className="nz-split" data-testid="markers-tab">
      <div className="nz-split-list">
        {markers.length === 0 ? (
          <p className="nz-sb-meta" data-testid="markers-empty">
            No markers yet. Select a range or point on a chart and choose &quot;Monitor selection&quot; or
            &quot;Mark point&quot;.
          </p>
        ) : (
          <ul className="nz-list" role="listbox" aria-label="Markers">
            {markers.map((m) => (
              <li key={m.markerId} role="option" aria-selected={m.markerId === p.selectedId}>
                <button
                  type="button"
                  className="nz-list-item"
                  data-testid={`marker-row-${m.markerId}`}
                  aria-current={m.markerId === p.selectedId ? "true" : undefined}
                  onClick={() => p.onSelect(m.markerId)}
                >
                  <span className="nz-grow">{describeAnchor(m.anchor)}</span>
                  {m.mode === "replay" && <ModeBadge mode="replay" />}
                  <MarkerStatusBadge status={m.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="nz-split-detail">
        {sel ? (
          <Inspector
            key={sel.markerId}
            marker={sel}
            tasks={store.data.tasks.filter((t) => t.markerId === sel.markerId)}
            store={store}
            panelTitle={p.panels.find((x) => x.panelId === sel.sourcePanelId)?.title ?? sel.sourcePanelId}
            onFocusPanel={p.onFocusPanel}
            onOpenEvidence={p.onOpenEvidence}
            onNotice={p.onNotice}
          />
        ) : (
          <p className="nz-sb-meta">Select a marker to inspect it.</p>
        )}
      </div>
    </div>
  );
}

function Inspector(p: {
  marker: Marker;
  tasks: MarkerTask[];
  store: MonitoringStore;
  panelTitle: string;
  onFocusPanel: (id: string) => void;
  onOpenEvidence: (id: string) => void;
  onNotice: (m: string) => void;
}) {
  const m = p.marker;
  const [agents, setAgents] = useState<string[]>(["quant"]);
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ code: string; text: string } | null>(null);
  const [delegations, setDelegations] = useState<Delegation[] | null>(null);
  const [delegationsError, setDelegationsError] = useState<string | null>(null);
  const run = async (fn: Parameters<MonitoringStore["act"]>[0]) => {
    setBusy(true);
    setActionError(null);
    const r = await p.store.act(fn);
    setBusy(false);
    if (!r.ok) {
      const text = `${r.reasonCode}: ${explainReason(r.reasonCode) ?? r.message}`;
      setActionError({ code: r.reasonCode, text });
      p.onNotice(text);
    }
    return r;
  };
  // The delegation chain is read from the server whenever the marker or its tasks change.
  const taskKey = p.tasks.map((t) => `${t.taskId}:${t.status}`).join(",");
  const api = p.store.api;
  useEffect(() => {
    let live = true;
    void api?.listDelegations(m.markerId).then((r) => {
      if (!live) return;
      if (r.ok) {
        setDelegations(r.value);
        setDelegationsError(null);
      } else setDelegationsError(`${r.reasonCode}: ${r.message}`);
    });
    return () => {
      live = false;
    };
  }, [api, m.markerId, m.version, taskKey]);
  const failedTask = p.tasks.find((t) => t.status === "FAILED");
  const reason = m.reasonCode ?? failedTask?.reasonCode ?? null;
  const showReason =
    (m.status === "ACTIVE" || m.status === "INVESTIGATING") && (m.reasonCode !== null || failedTask);
  const pending = m.status === "ACTIVE" ? p.tasks.find((t) => t.status === "PENDING") : undefined;
  const next = MARKER_TRANSITIONS[m.status];
  const needsResolution = (to: MarkerStatus) => to === "RESOLVED" || to === "DISMISSED";
  return (
    <section aria-label="Marker inspector" data-testid="marker-inspector" data-marker-id={m.markerId}>
      <h3 className="nz-h3">
        Marker <MarkerStatusBadge status={m.status} /> {m.mode === "replay" && <ModeBadge mode="replay" />}
      </h3>
      {showReason && (
        <p
          role="alert"
          className="nz-error"
          data-testid="marker-reason"
          data-reason={reason ?? "TASK_FAILED"}
        >
          Investigation did not succeed: <b>{reason ?? "TASK_FAILED"}</b>
          {explainReason(reason) ? ` — ${explainReason(reason)}` : ""}
        </p>
      )}
      {pending && (
        <p className="nz-sb-meta" role="status" data-testid="marker-pending">
          Assignment queued. The marker stays Active until the dispatcher has durably started the
          investigation; it then becomes Investigating.
        </p>
      )}
      <dl className="nz-kv">
        <dt>Anchor</dt>
        <dd data-testid="marker-anchor">{describeAnchor(m.anchor)}</dd>
        <dt>Source panel</dt>
        <dd>
          <button type="button" className="nz-chip" onClick={() => p.onFocusPanel(m.sourcePanelId)}>
            {p.panelTitle}
          </button>{" "}
          <span className="nz-sb-meta">at canvas revision {m.sourceVersion}</span>
        </dd>
        <dt>Question</dt>
        <dd>{m.question ?? "none"}</dd>
        <dt>Created</dt>
        <dd className="nz-tabular">{fmtTime(m.timestamp)}</dd>
        {m.selection && (
          <>
            <dt>Query hash</dt>
            <dd className="nz-tabular" data-testid="marker-query-hash">
              {m.selection.queryHash}
            </dd>
            <dt>Interval</dt>
            <dd className="nz-tabular">
              {fmtTime(m.selection.interval.start)} to {fmtTime(m.selection.interval.end)}
            </dd>
            <dt>Series</dt>
            <dd>{m.selection.seriesIds.join(", ") || "none"}</dd>
            <dt>Watermark</dt>
            <dd className="nz-tabular">{fmtTime(m.selection.sourceWatermark)}</dd>
          </>
        )}
        <dt>Assigned agents</dt>
        <dd>{m.assignedAgents.length ? m.assignedAgents.join(", ") : "none"}</dd>
        {m.resolution && (
          <>
            <dt>Resolution</dt>
            <dd>{m.resolution}</dd>
          </>
        )}
      </dl>

      <h4 className="nz-h4">Task status</h4>
      {p.tasks.length === 0 ? (
        <p className="nz-sb-meta">No investigation task for this marker.</p>
      ) : (
        <ul className="nz-plain-list" data-testid="marker-tasks">
          {p.tasks.map((t) => (
            <li key={t.taskId} data-testid={`task-${t.taskId}`}>
              <span data-testid="task-status" data-status={t.status}>
                {t.status}
              </span>{" "}
              · {t.agents.join(", ")} · {t.origin === "rule" ? "started by rule" : "assigned"}{" "}
              <ModeBadge mode={t.mode} />
              {t.runId && <span className="nz-sb-meta"> · run {t.runId.slice(0, 8)}</span>}
              {t.reasonCode && (
                <span className="nz-error" data-testid="task-reason">
                  {" "}
                  · {t.reasonCode}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4 className="nz-h4">Delegation chain</h4>
      {delegationsError ? (
        <p role="alert" className="nz-error" data-testid="delegations-error">
          {delegationsError}
        </p>
      ) : delegations && delegations.length > 0 ? (
        <ol className="nz-plain-list" data-testid="marker-delegations">
          {delegations.map((d) => (
            <li key={d.delegationId} data-testid={`delegation-${d.delegationId}`} data-depth={d.depth}>
              depth {d.depth} · user {d.userId ? d.userId.slice(0, 8) : "system"} → agents{" "}
              {d.agents.join(", ")} · grants {d.grants.length ? d.grants.join(", ") : "none"}
              {d.parentDelegationId ? ` · parent ${d.parentDelegationId.slice(0, 8)}` : ""}
            </li>
          ))}
        </ol>
      ) : (
        <p className="nz-sb-meta" data-testid="delegations-empty">
          No delegation recorded (nothing has been assigned).
        </p>
      )}

      <h4 className="nz-h4">Evidence ({m.linkedEvidenceIds.length})</h4>
      {m.linkedEvidenceIds.length === 0 ? (
        <p className="nz-sb-meta">No evidence linked yet.</p>
      ) : (
        <ul className="nz-plain-list" data-testid="marker-evidence">
          {m.linkedEvidenceIds.map((id) => (
            <li key={id}>
              <button type="button" className="nz-chip" onClick={() => p.onOpenEvidence(id)}>
                evidence {id.slice(0, 8)}
              </button>
            </li>
          ))}
        </ul>
      )}

      {m.status === "ACTIVE" && (
        <fieldset className="nz-fieldset" data-testid="assign-agent-form">
          <legend>Assign agents</legend>
          <div className="nz-checks">
            {ROLES.map((r) => (
              <label key={r} className="nz-field-inline">
                <input
                  type="checkbox"
                  checked={agents.includes(r)}
                  onChange={(e) =>
                    setAgents((a) => (e.target.checked ? [...a, r] : a.filter((x) => x !== r)))
                  }
                />
                {r}
              </label>
            ))}
          </div>
          <Button
            size="sm"
            variant="primary"
            data-testid="assign-agent"
            disabled={busy || agents.length === 0}
            onClick={() =>
              void run((api) => api.assignMarker({ markerId: m.markerId, agents: agents as never }))
            }
          >
            Assign and start investigation
          </Button>
        </fieldset>
      )}

      {actionError && (
        <p role="alert" className="nz-error" data-testid="action-error" data-reason={actionError.code}>
          {actionError.text}
        </p>
      )}
      {next.length > 0 && (
        <fieldset className="nz-fieldset" data-testid="transition-form">
          <legend>Move to</legend>
          {next.some(needsResolution) && (
            <label className="nz-field-block">
              Resolution note (required to resolve or dismiss)
              <textarea
                className="nz-input nz-textarea"
                value={resolution}
                data-testid="resolution-input"
                onChange={(e) => setResolution(e.target.value)}
                maxLength={4000}
              />
            </label>
          )}
          <div className="nz-page-actions">
            {next.map((to) => (
              <Button
                key={to}
                size="sm"
                data-testid={`transition-${to}`}
                disabled={busy || (needsResolution(to) && resolution.trim() === "")}
                onClick={() =>
                  void run((api) =>
                    api.transitionMarker({
                      markerId: m.markerId,
                      to,
                      ...(needsResolution(to) ? { resolution: resolution.trim() } : {}),
                    }),
                  )
                }
              >
                {STATUS_LABEL[to]}
              </Button>
            ))}
          </div>
        </fieldset>
      )}
    </section>
  );
}
