"use client";
import "../../lib/zod-config.ts"; // jitless zod: no eval probe under the strict CSP
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, EmptyState, ErrorState, HonestyBanner } from "@nearesis/ui";
import { CollabError, CollabRoom, type Peer, type Point, type Reconciliation } from "./room.ts";
import e from "../evidence/evidence.module.css";
import c from "./collab.module.css";

const TICK_MS = 500;
const NOTE_KEY = "shared";

interface PanelRow {
  panelId: string;
  title: string;
}

/**
 * Collaborative panel layout and shared notes (W15/W16). Positions and notes are a Yjs document per workspace,
 * synchronised through the kernel's collaboration transport; panels themselves (existence, titles, queries) come
 * from the canvas and change only through canvas commands. Reconciliation shows how the CRDT layout matches the
 * canvas recorded by the event log.
 */
export function CollabBoard({ workspaceId }: { workspaceId: string }) {
  const base = `/api/k/workspaces/${workspaceId}`;
  const rooms = useMemo(
    () => ({ layout: new CollabRoom(base, "layout"), notes: new CollabRoom(base, "notes") }),
    [base],
  );
  const clientId = useMemo(() => crypto.randomUUID(), []);
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [panels, setPanels] = useState<PanelRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [rec, setRec] = useState<Reconciliation | null>(null);
  const [synced, setSynced] = useState(false);
  const [draft, setDraft] = useState<Record<string, { x: string; y: string }>>({});
  const wasOffline = useRef(false);
  const busy = useRef(false);
  const tickNo = useRef(0);

  const loadPanels = useCallback(async () => {
    const r = await fetch(`${base}/canvas`, { cache: "no-store" });
    const body = (await r.json().catch(() => ({}))) as {
      panels?: Array<{ panelId: string; title?: string }>;
      reasonCode?: string;
      message?: string;
    };
    if (!r.ok) throw new Error(`${body.reasonCode ?? r.status}: ${body.message ?? "canvas unavailable"}`);
    setPanels((body.panels ?? []).map((p) => ({ panelId: p.panelId, title: p.title ?? p.panelId })));
  }, [base]);

  const reconcile = useCallback(async () => {
    try {
      setRec(await rooms.layout.reconcile());
      await loadPanels();
    } catch (err) {
      setRefusal(err instanceof CollabError ? `${err.code}: ${err.message}` : String(err));
    }
  }, [rooms, loadPanels]);

  /** One sync round: send buffered edits, pull merged state, refresh presence every few rounds. */
  const tick = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const netUp = typeof navigator === "undefined" || navigator.onLine;
      if (!netUp) {
        wasOffline.current = true;
        setOnline(false);
        return;
      }
      let offline = false;
      for (const room of [rooms.layout, rooms.notes]) {
        const f = await room.flush();
        if (f === "offline") offline = true;
        else if (f) setRefusal(`${f.code}: ${f.message}`);
        if ((await room.pull()) === "offline") offline = true;
      }
      if (!offline && tickNo.current++ % 4 === 0) {
        const p = await rooms.layout.setPresence(clientId, focus ? { focus } : {});
        if (p === "offline") offline = true;
        else setPeers(p);
      }
      setOnline(!offline);
      if (offline) wasOffline.current = true;
      else {
        setSynced(true);
        if (wasOffline.current) {
          // Back online: everything buffered was sent; reconcile against the canvas the event log records.
          wasOffline.current = false;
          await reconcile();
        }
      }
    } catch (err) {
      setRefusal(err instanceof CollabError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      busy.current = false;
      bump();
    }
  }, [rooms, clientId, focus, reconcile, bump]);

  useEffect(() => {
    loadPanels().catch((err) => setLoadError(String(err instanceof Error ? err.message : err)));
  }, [loadPanels]);

  useEffect(() => {
    const t = setInterval(() => void tick(), TICK_MS);
    const on = () => void tick();
    const off = () => {
      wasOffline.current = true;
      setOnline(false);
    };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    void tick();
    return () => {
      clearInterval(t);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [tick]);


  const layout = rooms.layout.layout();
  const notes = rooms.notes.notes();
  const live = new Set((panels ?? []).map((p) => p.panelId));
  const dangling = Object.keys(layout).filter((k) => panels && !live.has(k));
  const titleOf = (id: string) => panels?.find((p) => p.panelId === id)?.title ?? id;
  const buffered = rooms.layout.buffered + rooms.notes.buffered;

  useEffect(() => {
    const w = window as unknown as { __collab?: unknown };
    w.__collab = {
      ready: panels !== null && synced,
      online,
      buffered,
      refusal,
      layout,
      notes,
      peers,
      reconcile: rec,
      cursor: rooms.layout.cursor,
    };
  });

  const edit = (fn: () => void) => {
    setRefusal(null);
    fn();
    bump();
    void tick();
  };
  const place = (id: string, p: Point) => edit(() => rooms.layout.setPosition(id, p));
  const placeUnplaced = () =>
    edit(() =>
      rooms.layout.edit((d) => {
        const m = d.getMap<Point>("layout");
        (panels ?? []).forEach((p, i) => {
          if (!m.has(p.panelId)) m.set(p.panelId, { x: (i % 4) * 10, y: Math.floor(i / 4) * 10 });
        });
      }),
    );

  if (loadError) return <ErrorState code="CANVAS_UNAVAILABLE" message={loadError} />;

  const maxX = Math.max(40, ...Object.values(layout).map((p) => p.x + 10));
  const maxY = Math.max(30, ...Object.values(layout).map((p) => p.y + 10));
  const minX = Math.min(0, ...Object.values(layout).map((p) => p.x));
  const minY = Math.min(0, ...Object.values(layout).map((p) => p.y));

  return (
    <main className={e.page} data-testid="collab-page">
      <nav className={e.crumbs} aria-label="Breadcrumb">
        <a href={`/w/${workspaceId}`}>Workspace</a>
        <span aria-hidden="true">/</span>
        <span>Shared layout</span>
      </nav>
      <header className={e.head}>
        <h1 className={e.title}>Shared layout and notes</h1>
        <p className={e.muted}>
          Panel positions and notes are edited together in real time. Panels themselves, evidence and access
          are changed only through workspace commands; a panel deleted on the canvas is never brought back by
          a layout move.
        </p>
      </header>

      <div className={c.status} role="status" aria-live="polite" data-testid="collab-status">
        <Badge tone={online ? "ok" : "warn"} data-testid="collab-online">
          {online ? "online" : "offline"}
        </Badge>
        <span data-testid="collab-buffered">
          {buffered ? `${buffered} edit(s) waiting to be sent` : "all edits sent"}
        </span>
        <span className={e.muted} data-testid="collab-peers">
          {peers.length} active session(s) in this workspace
          {peers.some((p) => p.state.focus)
            ? `: ${peers
                .filter((p) => typeof p.state.focus === "string")
                .map((p) => `editing ${titleOf(p.state.focus as string)}`)
                .join(", ")}`
            : ""}
        </span>
      </div>
      {!online ? (
        <HonestyBanner data-testid="collab-offline">
          Offline. Edits are kept in this tab and sent when the connection returns; others do not see them
          yet.
        </HonestyBanner>
      ) : null}
      {refusal ? (
        <div className={e.notice} role="alert" data-testid="collab-refusal">
          Edit refused by the server ({refusal}). The shared layout is shown as stored; your change was not
          kept.
        </div>
      ) : null}

      <div className={e.grid2}>
        <section className={e.card} aria-labelledby="h-lay">
          <h2 className={e.h2} id="h-lay">
            Panel positions
          </h2>
          {!panels ? (
            <div className="nz-state" role="status" aria-busy="true">
              Loading panels…
            </div>
          ) : !panels.length ? (
            <EmptyState title="No panels on the canvas" art={false} />
          ) : (
            <>
              <button type="button" className="nz-btn" onClick={placeUnplaced} data-testid="collab-place-all">
                Place unplaced panels on a grid
              </button>
              <table className={c.table} data-testid="collab-layout">
                <thead>
                  <tr>
                    <th scope="col">Panel</th>
                    <th scope="col">x</th>
                    <th scope="col">y</th>
                    <th scope="col">
                      <span className="nz-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {panels.map((p) => {
                    const pos = layout[p.panelId];
                    const d = draft[p.panelId] ?? {
                      x: pos ? String(pos.x) : "",
                      y: pos ? String(pos.y) : "",
                    };
                    const setD = (k: "x" | "y", v: string) =>
                      setDraft((s) => ({ ...s, [p.panelId]: { ...d, [k]: v } }));
                    return (
                      <tr
                        key={p.panelId}
                        data-testid={`collab-row-${p.panelId}`}
                        data-x={pos?.x ?? ""}
                        data-y={pos?.y ?? ""}
                        onFocus={() => setFocus(p.panelId)}
                      >
                        <th scope="row">{p.title}</th>
                        <td>
                          <input
                            type="number"
                            aria-label={`${p.title} x`}
                            value={d.x}
                            onChange={(ev) => setD("x", ev.target.value)}
                            data-testid="collab-x"
                            className={c.num}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            aria-label={`${p.title} y`}
                            value={d.y}
                            onChange={(ev) => setD("y", ev.target.value)}
                            data-testid="collab-y"
                            className={c.num}
                          />
                        </td>
                        <td className={c.actions}>
                          <button
                            type="button"
                            className="nz-btn"
                            disabled={d.x === "" || d.y === ""}
                            onClick={() => {
                              place(p.panelId, { x: Number(d.x), y: Number(d.y) });
                              setDraft((s) => {
                                const n = { ...s };
                                delete n[p.panelId];
                                return n;
                              });
                            }}
                            data-testid="collab-set"
                          >
                            Move
                          </button>
                          <button
                            type="button"
                            className={e.linkBtn}
                            disabled={!pos}
                            onClick={() => edit(() => rooms.layout.removePosition(p.panelId))}
                            data-testid="collab-unplace"
                          >
                            Unplace
                          </button>
                          {pos ? null : <span className={e.muted}> not placed</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className={c.board} aria-hidden="true" data-testid="collab-board">
                {panels
                  .filter((p) => layout[p.panelId])
                  .map((p) => {
                    const pos = layout[p.panelId]!;
                    return (
                      <div
                        key={p.panelId}
                        className={c.tile}
                        data-focus={peers.some((x) => x.state.focus === p.panelId) || undefined}
                        style={{
                          left: `${((pos.x - minX) / (maxX - minX)) * 90}%`,
                          top: `${((pos.y - minY) / (maxY - minY)) * 85}%`,
                        }}
                      >
                        {p.title}
                      </div>
                    );
                  })}
              </div>
            </>
          )}
          {dangling.length ? (
            <p className={e.muted} data-testid="collab-dangling">
              {dangling.length} layout entr{dangling.length === 1 ? "y refers" : "ies refer"} to panels no
              longer on the canvas; reconciliation drops them.
            </p>
          ) : null}
        </section>

        <section className={e.card} aria-labelledby="h-rec">
          <h2 className={e.h2} id="h-rec">
            Reconciliation with the canvas
          </h2>
          <button
            type="button"
            className="nz-btn"
            onClick={() => void reconcile()}
            data-testid="collab-reconcile"
          >
            Reconcile now
          </button>
          {rec ? (
            <dl className={c.dl} data-testid="collab-reconcile-result">
              <dt>Canvas revision (event log)</dt>
              <dd data-testid="rec-revision">{rec.documentRevision}</dd>
              <dt>Panels on canvas</dt>
              <dd>{rec.panelIds.length}</dd>
              <dt>Placed</dt>
              <dd>{Object.keys(rec.layout).length}</dd>
              <dt>Not placed</dt>
              <dd data-testid="rec-unplaced">
                {rec.unplaced.length ? rec.unplaced.map(titleOf).join(", ") : "none"}
              </dd>
              <dt>Dropped (panel deleted on the canvas)</dt>
              <dd data-testid="rec-dropped" className={e.mono}>
                {rec.dropped.length ? rec.dropped.join(", ") : "none"}
              </dd>
              <dt>Rule</dt>
              <dd data-testid="rec-rule">{rec.rule}</dd>
            </dl>
          ) : (
            <p className={e.muted}>Runs automatically after reconnecting.</p>
          )}

          <h2 className={e.h2} id="h-notes">
            Shared notes
          </h2>
          <label className="nz-sr-only" htmlFor="collab-note">
            Shared notes
          </label>
          <textarea
            id="collab-note"
            className={c.note}
            rows={6}
            value={notes[NOTE_KEY] ?? ""}
            onChange={(ev) => edit(() => rooms.notes.setNote(NOTE_KEY, ev.target.value))}
            data-testid="collab-note"
          />
          <p className={e.muted}>Notes are plain text and are not evidence.</p>
        </section>
      </div>
    </main>
  );
}
