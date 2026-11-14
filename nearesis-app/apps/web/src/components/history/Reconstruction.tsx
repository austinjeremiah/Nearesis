/**
 * Event-log reconstruction (W11): the canvas and evidence graph rebuilt by replaying the journal up to a revision
 * (= journal sequence number). Panels without a recorded data vintage are shown as `vintage_unavailable`; current
 * data is never substituted. The export is the kernel's verifiable reconstruction file (content hash included).
 */
import { useEffect, useState } from "react";
import { Badge } from "@nearesis/ui";
import { ApiError, getJson, historyApi } from "./client.ts";
import e from "../evidence/evidence.module.css";

interface ReconstructedPanel {
  panelId: string;
  dataState: "pinned" | "vintage_unavailable";
  snapshotId: string | null;
  data: unknown;
}
export interface ReconstructionView {
  revision: number;
  historical: true;
  eventsApplied: Array<{ seq: number; type: string; payloadHash: string }>;
  unreplayableEvents: Array<{ seq: number; change: string }>;
  canvas: { documentRevision: number; panels: Array<{ panelId: string; title?: string }>; hash: string };
  graph: { nodes: Record<string, unknown>; edges: Record<string, unknown>; hash: string };
  stateHash: string;
  panels: ReconstructedPanel[];
  pinnedSnapshotId: string | null;
  unavailableSnapshotIds: string[];
  exactReproduction: boolean;
  notice: string;
}

export function Reconstruction({ workspaceId, revision }: { workspaceId: string; revision: number | null }) {
  const api = historyApi(workspaceId);
  const [rev, setRev] = useState(revision === null ? "" : String(revision));
  const [view, setView] = useState<ReconstructionView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [exported, setExported] = useState<{ contentHash: string; href: string } | null>(null);

  const load = async (n: number) => {
    setErr(null);
    setView(null);
    setExported(null);
    try {
      setView(await getJson<ReconstructionView>(`${api}/revisions/${n}`));
    } catch (x) {
      setErr(x instanceof ApiError ? `${x.code}: ${x.message}` : String(x));
    }
  };
  useEffect(() => {
    if (revision !== null) {
      setRev(String(revision));
      void load(revision);
    }
  }, [revision]);

  useEffect(() => {
    (window as unknown as { __reconstruction?: unknown }).__reconstruction = { view, err, exported };
  }, [view, err, exported]);

  const doExport = async () => {
    if (!view) return;
    try {
      const f = await getJson<{ contentHash: string }>(`${api}/revisions/${view.revision}/export`);
      const blob = new Blob([JSON.stringify(f, null, 2)], { type: "application/json" });
      setExported({ contentHash: f.contentHash, href: URL.createObjectURL(blob) });
    } catch (x) {
      setErr(x instanceof ApiError ? `${x.code}: ${x.message}` : String(x));
    }
  };

  const titleOf = (id: string) => view?.canvas.panels.find((p) => p.panelId === id)?.title ?? id;
  return (
    <section className={e.card} aria-labelledby="h-rec" data-testid="reconstruction">
      <h2 className={e.h2} id="h-rec">
        Reconstruct from the event log
      </h2>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          const n = Number(rev);
          if (Number.isInteger(n) && n >= 0) void load(n);
        }}
      >
        <label htmlFor="rec-rev">Revision (journal sequence)</label>{" "}
        <input
          id="rec-rev"
          className="nz-input"
          type="number"
          min={0}
          value={rev}
          onChange={(ev) => setRev(ev.target.value)}
          data-testid="rec-rev"
        />{" "}
        <button type="submit" className="nz-btn" disabled={rev === ""} data-testid="rec-load">
          Reconstruct
        </button>
      </form>
      {err ? (
        <p role="alert" data-testid="rec-error">
          Reconstruction unavailable ({err}).
        </p>
      ) : null}
      {view ? (
        <div data-testid="rec-view">
          <p>
            <Badge tone={view.exactReproduction ? "ok" : "warn"} data-testid="rec-exact">
              {view.exactReproduction ? "exact reproduction" : "not an exact reproduction"}
            </Badge>{" "}
            <span data-testid="rec-notice">{view.notice}</span>
          </p>
          <dl className={e.record}>
            <dt>Revision</dt>
            <dd data-testid="rec-revision">{view.revision}</dd>
            <dt>Events replayed</dt>
            <dd>{view.eventsApplied.length}</dd>
            <dt>Canvas revision</dt>
            <dd>{view.canvas.documentRevision}</dd>
            <dt>Evidence nodes</dt>
            <dd>{Object.keys(view.graph.nodes).length}</dd>
            <dt>State hash</dt>
            <dd className={e.mono} data-testid="rec-state-hash">
              {view.stateHash}
            </dd>
          </dl>
          {view.unreplayableEvents.length ? (
            <p className={e.notice} data-testid="rec-unreplayable">
              {view.unreplayableEvents.length} event(s) changed state that replay cannot rebuild:{" "}
              {view.unreplayableEvents.map((u) => `#${u.seq} ${u.change}`).join(", ")}.
            </p>
          ) : null}
          <h3 className={e.h3}>Panels at this revision</h3>
          {view.panels.length ? (
            <ul data-testid="rec-panels">
              {view.panels.map((p) => (
                <li key={p.panelId} data-testid={`rec-panel-${p.panelId}`} data-state={p.dataState}>
                  {titleOf(p.panelId)}:{" "}
                  {p.dataState === "vintage_unavailable" ? (
                    <strong data-testid="rec-vintage-unavailable">
                      vintage_unavailable: no recorded data vintage; current data is not shown
                    </strong>
                  ) : (
                    <span>
                      pinned to snapshot <code className={e.mono}>{p.snapshotId}</code>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className={e.muted}>No panels at this revision.</p>
          )}
          <button type="button" className="nz-btn" onClick={() => void doExport()} data-testid="rec-export">
            Export reconstruction file
          </button>
          {exported ? (
            <p data-testid="rec-exported">
              <a href={exported.href} download={`reconstruction-${view.revision}.json`}>
                Download
              </a>{" "}
              content hash <code className={e.mono}>{exported.contentHash}</code>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
