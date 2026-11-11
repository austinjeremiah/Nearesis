"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState, ErrorState, HonestyBanner } from "@nearesis/ui";
import { ApiError, getJson, historyApi, mutate } from "./client.ts";
import e from "../evidence/evidence.module.css";

interface TimelineEntry {
  at: string;
  seq: number | null;
  kind: "event" | "snapshot" | "branch" | "merge" | "semantic_version";
  type: string;
  ref: string | null;
  summary: string;
  documentRevision: number | null;
}
interface Vintage {
  capturedAt: string;
  workspaceVersion: number;
  eventSeq: number;
  documentRevision: number;
  dataRevision: number;
  sourceSnapshot: { manifestHash?: string; watermark?: Record<string, string> } | null;
  semanticPins: Record<string, string>;
}
interface SnapshotSummary {
  id: string;
  label: string;
  createdAt: string;
  contentHash: string;
  dataVintage: Vintage;
}
interface SnapshotView {
  historical: true;
  label: string;
  capturedAt: string;
  dataVintage: Vintage;
  stale: boolean;
  currentDocumentRevision: number;
  integrityOk: boolean;
  contentHash: string;
  canvas?: { panels?: Array<{ panelId: string; title: string; kind: string }>; documentRevision?: number };
  graph?: { nodes: unknown[]; edges: unknown[] };
}
interface Change {
  objectId: string;
  change: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}
interface Branch {
  id: string;
  name: string;
  isMain?: boolean;
  status: string;
  baseSnapshotId: string | null;
  overlayRevision: number;
  createdAt: string;
}
interface Proposal {
  id: string;
  sourceBranchId: string;
  targetBranchId: string;
  status: "open" | "accepted" | "rejected";
  changes: Change[];
  conflicts: Array<{ objectId: string; base: unknown; ours: unknown; theirs: unknown; resolution: string }>;
  evidenceHashDiffs: Array<{ objectId: string; before: string; after: string }>;
  requiredApprovals: string[];
  excluded?: Array<{ objectId: string; reasonCode: string; reason: string; from: string; to: string }>;
  createdAt: string;
  decidedAt: string | null;
}

/** Known merge limitation: panel changes and edge deletions are deferred by the kernel, not applied. */
export function willDefer(c: Change): boolean {
  return c.objectId.startsWith("panel:") || (c.objectId.startsWith("edge:") && c.change === "removed");
}

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
const json = (v: unknown) => (v === undefined ? "—" : JSON.stringify(v).slice(0, 160));

function Changes({ changes, testId, deferMark }: { changes: Change[]; testId: string; deferMark?: boolean }) {
  if (!changes.length)
    return (
      <p className={e.muted} data-testid={testId}>
        No differences.
      </p>
    );
  return (
    <table className={e.table} data-testid={testId}>
      <thead>
        <tr>
          <th>Object</th>
          <th>Change</th>
          <th>Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={c.objectId} data-object={c.objectId}>
            <td className={e.mono}>{short(c.objectId)}</td>
            <td className={e.change} data-change={c.change}>
              {c.change}
              {deferMark && willDefer(c) ? (
                <span className={e.deferred} data-testid="will-defer">
                  {" "}
                  · will be deferred, not applied
                </span>
              ) : null}
            </td>
            <td className={e.mono}>{json(c.before)}</td>
            <td className={e.mono}>{json(c.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VintageLine({
  v,
  stale,
  current,
  integrityOk,
}: {
  v: Vintage;
  stale?: boolean;
  current?: number;
  integrityOk?: boolean;
}) {
  return (
    <div className={e.vintage} data-testid="snapshot-vintage">
      Data vintage: captured {v.capturedAt} · workspace version {v.workspaceVersion} · event seq {v.eventSeq}{" "}
      · document revision {v.documentRevision} · data revision {v.dataRevision}
      {" · "}semantic pins{" "}
      {Object.keys(v.semanticPins).length
        ? Object.entries(v.semanticPins)
            .map(([m, x]) => `${m}@${x}`)
            .join(", ")
        : "none"}
      {" · "}source snapshot {v.sourceSnapshot?.manifestHash ?? "not pinned"}
      {stale ? (
        <span className={e.warn}>
          {" "}
          · current data has moved on (now revision {current}); shown as captured
        </span>
      ) : null}
      {integrityOk === undefined ? null : integrityOk ? (
        <Badge tone="ok">integrity ok</Badge>
      ) : (
        <Badge tone="bad">integrity check FAILED</Badge>
      )}
    </div>
  );
}

export function HistoryView({ workspaceId }: { workspaceId: string }) {
  const api = historyApi(workspaceId);
  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [kinds, setKinds] = useState<Set<string>>(
    new Set(["snapshot", "branch", "merge", "semantic_version", "event"]),
  );
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [proposals, setProposals] = useState<
    Array<{ id: string; sourceBranchId: string; status: string; conflictCount: number; changeCount: number }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<{
    id: string;
    data: SnapshotView | null;
    unavailable: string | null;
  } | null>(null);
  const [cmp, setCmp] = useState<{ a: string; b: string }>({ a: "", b: "" });
  const [diff, setDiff] = useState<{
    changes: Change[];
    documentRevision: { from: number; to: number };
    semanticPinChanges: Array<{ metricId: string; from: string | null; to: string | null }>;
  } | null>(null);
  const [branchSel, setBranchSel] = useState<string | null>(null);
  const [branchView, setBranchView] = useState<{
    name: string;
    baseSnapshotId: string | null;
    diff: Change[];
    objects: Record<string, unknown>;
    vsMain: Change[] | null;
  } | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [lastAccept, setLastAccept] = useState<{ applied: number; deferredObjects: string[] } | null>(null);
  const [ack, setAck] = useState(false);
  const [label, setLabel] = useState("");
  const [manifest, setManifest] = useState("");
  const [branchName, setBranchName] = useState("");
  const [branchFrom, setBranchFrom] = useState("");

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const [t, s, b, p] = await Promise.all([
      getJson<{ entries: TimelineEntry[] }>(`${api}/timeline?limit=500`),
      getJson<{ snapshots: SnapshotSummary[] }>(`${api}/snapshots`),
      getJson<{ branches: Branch[] }>(`${api}/branches`),
      getJson<{
        proposals: Array<{
          id: string;
          sourceBranchId: string;
          status: string;
          conflictCount: number;
          changeCount: number;
        }>;
      }>(`${api}/merge-proposals`),
    ]);
    setTimeline(t.entries);
    setSnapshots(s.snapshots);
    setBranches(b.branches);
    setProposals(p.proposals);
  }, [api]);

  useEffect(() => {
    void run(refresh);
  }, [run, refresh]);

  const mainId = branches.find((b) => b.isMain)?.id ?? null;

  const openSnapshot = (id: string) =>
    run(async () => {
      setView({ id, data: null, unavailable: null });
      try {
        setView({ id, data: await getJson<SnapshotView>(`${api}/snapshots/${id}`), unavailable: null });
      } catch (err) {
        // A historical view that cannot be reconstructed is reported; current data is never substituted.
        setView({
          id,
          data: null,
          unavailable: err instanceof ApiError ? `${err.code}: ${err.message}` : String(err),
        });
      }
    });

  const openBranch = (id: string) =>
    run(async () => {
      setBranchSel(id);
      const v = await getJson<{
        name: string;
        baseSnapshotId: string | null;
        diff: Change[];
        objects: Record<string, unknown>;
      }>(`${api}/branches/${id}`);
      const vsMain = mainId
        ? (await getJson<{ changes: Change[] }>(`${api}/branches/${id}/diff?against=${mainId}`)).changes
        : null;
      setBranchView({ ...v, vsMain });
    });

  const openProposal = (id: string) =>
    run(async () => {
      setLastAccept(null);
      setProposal(await getJson<Proposal>(`${api}/merge-proposals/${id}`));
    });

  useEffect(() => {
    const w = window as unknown as { __history?: unknown };
    w.__history = {
      ready: timeline !== null,
      snapshots: snapshots.length,
      branches: branches.length,
      view,
      diff,
      branchView,
      proposal,
      lastAccept,
      error,
    };
  }, [timeline, snapshots, branches, view, diff, branchView, proposal, lastAccept, error]);

  const branchNodes = useMemo(
    () =>
      branchView
        ? Object.entries(branchView.objects)
            .filter(([k]) => k.startsWith("node:"))
            .map(([k, v]) => ({ objectId: k, value: v as { label?: string; kind?: string } }))
        : [],
    [branchView],
  );
  const unresolved = proposal?.conflicts.filter((c) => c.resolution === "unresolved").length ?? 0;

  return (
    <main className={e.page} data-testid="history-page">
      <nav className={e.crumbs} aria-label="Breadcrumb">
        <a href={`/w/${workspaceId}`}>Workspace</a>
        <span aria-hidden="true">/</span>
        <span>Time machine</span>
        <span aria-hidden="true">·</span>
        <a href={`/w/${workspaceId}/evidence`}>Evidence graph</a>
      </nav>
      <header className={e.head}>
        <h1 className={e.title}>Time machine</h1>
        <p className={e.muted}>
          Every historical view is read from a captured snapshot and shows its data vintage. Snapshots cover
          the main branch only. Merges into main apply evidence and metric changes; panel changes and edge
          deletions are deferred and reported, not applied.
        </p>
      </header>
      {error ? <ErrorState code="REQUEST_FAILED" message={error} /> : null}

      <div className={e.grid2}>
        <section className={e.card} aria-labelledby="h-tl">
          <h2 className={e.h2} id="h-tl">
            Revision timeline
          </h2>
          <div className={e.kinds}>
            {["snapshot", "branch", "merge", "semantic_version", "event"].map((k) => (
              <label key={k}>
                <input
                  type="checkbox"
                  checked={kinds.has(k)}
                  onChange={(ev) =>
                    setKinds((s) => {
                      const n = new Set(s);
                      if (ev.target.checked) n.add(k);
                      else n.delete(k);
                      return n;
                    })
                  }
                />{" "}
                {k.replace("_", " ")}
              </label>
            ))}
          </div>
          {!timeline ? (
            <div className="nz-state" role="status" aria-busy="true">
              Loading timeline…
            </div>
          ) : (
            <ol className={e.timeline} data-testid="timeline">
              {[...timeline]
                .reverse()
                .filter((t) => kinds.has(t.kind))
                .map((t, i) => (
                  <li key={`${t.at}-${i}`} className={e.tlItem} data-kind={t.kind}>
                    <span className={e.mono}>{t.at.slice(5, 16).replace("T", " ")}</span>
                    <span>
                      <strong>{t.kind.replace("_", " ")}</strong> · {t.summary}
                      {t.documentRevision !== null ? (
                        <span className={e.muted}> · rev {t.documentRevision}</span>
                      ) : null}
                      {t.kind === "snapshot" && t.ref ? (
                        <>
                          {" "}
                          <button
                            type="button"
                            className={e.linkBtn}
                            onClick={() => void openSnapshot(t.ref!)}
                          >
                            view
                          </button>
                        </>
                      ) : null}
                    </span>
                  </li>
                ))}
            </ol>
          )}
        </section>

        <section className={e.card} aria-labelledby="h-snap">
          <h2 className={e.h2} id="h-snap">
            Snapshots
          </h2>
          <form
            className={e.toolbar}
            onSubmit={(ev) => {
              ev.preventDefault();
              if (!label.trim()) return;
              void run(async () => {
                await mutate(workspaceId, `${api}/snapshots`, {
                  label: label.trim(),
                  ...(/^[0-9a-f]{64}$/.test(manifest) ? { sourceSnapshot: { manifestHash: manifest } } : {}),
                });
                setLabel("");
                await refresh();
              });
            }}
          >
            <label className={e.field}>
              Label
              <input
                className="nz-input"
                value={label}
                onChange={(ev) => setLabel(ev.target.value)}
                data-testid="snapshot-label"
                maxLength={200}
              />
            </label>
            <label className={e.field}>
              Pin source manifest hash (optional)
              <input
                className="nz-input"
                value={manifest}
                onChange={(ev) => setManifest(ev.target.value.trim())}
                placeholder="sha256 hex"
              />
            </label>
            <Button type="submit" disabled={busy || !label.trim()} data-testid="capture-snapshot">
              Capture snapshot
            </Button>
          </form>
          <table className={e.table} data-testid="snapshot-list">
            <thead>
              <tr>
                <th>Label</th>
                <th>Captured</th>
                <th>Rev</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id}>
                  <td>{s.label}</td>
                  <td className={e.mono}>{s.createdAt.slice(0, 19)}</td>
                  <td>{s.dataVintage.documentRevision}</td>
                  <td>
                    <button
                      type="button"
                      className={e.linkBtn}
                      onClick={() => void openSnapshot(s.id)}
                      data-testid={`open-snapshot-${s.label}`}
                    >
                      view
                    </button>{" "}
                    <a href={`/w/${workspaceId}/evidence?snapshot=${s.id}`}>graph</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {view ? (
        <section className={e.card} aria-labelledby="h-view" data-testid="snapshot-view">
          <h2 className={e.h2} id="h-view">
            Snapshot view
          </h2>
          {view.unavailable ? (
            <EmptyState title="vintage_unavailable" data-testid="vintage-unavailable">
              This snapshot cannot be reconstructed ({view.unavailable}). Current data is not substituted.
            </EmptyState>
          ) : !view.data ? (
            <div className="nz-state" role="status" aria-busy="true">
              Loading snapshot…
            </div>
          ) : (
            <>
              <HonestyBanner>
                Historical view of “{view.data.label}”. Values are as captured, not today’s.
              </HonestyBanner>
              <VintageLine
                v={view.data.dataVintage}
                stale={view.data.stale}
                current={view.data.currentDocumentRevision}
                integrityOk={view.data.integrityOk}
              />
              <p>
                {view.data.canvas?.panels?.length ?? 0} panel(s), {view.data.graph?.nodes.length ?? 0}{" "}
                evidence node(s), {view.data.graph?.edges.length ?? 0} edge(s) · content hash{" "}
                <code className={e.mono}>{view.data.contentHash}</code>
              </p>
              <ul data-testid="snapshot-panels">
                {(view.data.canvas?.panels ?? []).map((p) => (
                  <li key={p.panelId}>
                    {p.title} <span className={e.muted}>({p.kind})</span>
                  </li>
                ))}
              </ul>
              <a href={`/w/${workspaceId}/evidence?snapshot=${view.id}`}>
                Open the evidence graph at this snapshot
              </a>
            </>
          )}
        </section>
      ) : null}

      <section className={e.card} aria-labelledby="h-cmp">
        <h2 className={e.h2} id="h-cmp">
          Compare snapshots
        </h2>
        <div className={e.toolbar}>
          {(["a", "b"] as const).map((k) => (
            <label className={e.field} key={k}>
              {k === "a" ? "From" : "To"}
              <select
                className="nz-input"
                value={cmp[k]}
                onChange={(ev) => setCmp((c) => ({ ...c, [k]: ev.target.value }))}
                data-testid={`compare-${k}`}
              >
                <option value="">Choose…</option>
                {snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <Button
            disabled={!cmp.a || !cmp.b || busy}
            data-testid="compare-run"
            onClick={() =>
              void run(async () => setDiff(await getJson(`${api}/snapshots/compare?a=${cmp.a}&b=${cmp.b}`)))
            }
          >
            Compare
          </Button>
        </div>
        {diff ? (
          <>
            <p className={e.muted} data-testid="compare-summary">
              Document revision {diff.documentRevision.from} → {diff.documentRevision.to} ·{" "}
              {diff.changes.length} object change(s) · semantic pin changes:{" "}
              {diff.semanticPinChanges.length
                ? diff.semanticPinChanges
                    .map((p) => `${p.metricId} ${p.from ?? "∅"}→${p.to ?? "∅"}`)
                    .join(", ")
                : "none"}
            </p>
            <Changes changes={diff.changes} testId="compare-changes" />
          </>
        ) : null}
      </section>

      <div className={e.grid2}>
        <section className={e.card} aria-labelledby="h-br">
          <h2 className={e.h2} id="h-br">
            Branches
          </h2>
          <form
            className={e.toolbar}
            onSubmit={(ev) => {
              ev.preventDefault();
              if (!branchName.trim() || !branchFrom) return;
              void run(async () => {
                const r = await mutate(workspaceId, `${api}/branches`, {
                  fromSnapshotId: branchFrom,
                  name: branchName.trim(),
                });
                setBranchName("");
                await refresh();
                const id = String(r.result.branchId ?? "");
                if (id) await openBranch(id);
              });
            }}
          >
            <label className={e.field}>
              From snapshot
              <select
                className="nz-input"
                value={branchFrom}
                onChange={(ev) => setBranchFrom(ev.target.value)}
                data-testid="branch-from"
              >
                <option value="">Choose…</option>
                {snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={e.field}>
              Name
              <input
                className="nz-input"
                value={branchName}
                onChange={(ev) => setBranchName(ev.target.value)}
                data-testid="branch-name"
                maxLength={120}
              />
            </label>
            <Button
              type="submit"
              disabled={busy || !branchName.trim() || !branchFrom}
              data-testid="create-branch"
            >
              Create branch
            </Button>
          </form>
          <ul className={e.links} data-testid="branch-list">
            {branches.map((b) => (
              <li key={b.id}>
                {b.isMain ? (
                  <span>
                    <strong>{b.name}</strong> <span className={e.muted}>(main, live)</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    className={e.linkBtn}
                    onClick={() => void openBranch(b.id)}
                    data-testid={`open-branch-${b.name}`}
                  >
                    {b.name}
                  </button>
                )}{" "}
                <span className={e.muted}>
                  {b.status} · overlay rev {b.overlayRevision}
                </span>
                {!b.isMain ? (
                  <>
                    {" · "}
                    <a href={`/w/${workspaceId}/evidence?branch=${b.id}`}>graph</a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
          {branchView && branchSel ? (
            <div data-testid="branch-view">
              <h3 className={e.h3}>
                Branch “{branchView.name}” · base snapshot{" "}
                <code className={e.mono}>{branchView.baseSnapshotId ?? "none"}</code>
              </h3>
              <h3 className={e.h3}>Diff against its base snapshot</h3>
              <Changes changes={branchView.diff} testId="branch-diff-base" />
              {branchView.vsMain ? (
                <>
                  <h3 className={e.h3}>Diff against main (live)</h3>
                  <Changes changes={branchView.vsMain} testId="branch-diff-main" />
                </>
              ) : null}
              <h3 className={e.h3}>Edit on this branch (main is untouched)</h3>
              <ul className={e.links} data-testid="branch-nodes">
                {branchNodes.map((n) => (
                  <li key={n.objectId}>
                    {n.value.kind}: {n.value.label}{" "}
                    <button
                      type="button"
                      className={e.linkBtn}
                      data-testid={`relabel-${n.objectId}`}
                      onClick={() => {
                        const next = window.prompt("New label", n.value.label ?? "");
                        if (!next) return;
                        void run(async () => {
                          await mutate(workspaceId, `${api}/branches/${branchSel}/changes`, {
                            ops: [{ op: "set", objectId: n.objectId, value: { ...n.value, label: next } }],
                          });
                          await openBranch(branchSel);
                          await refresh();
                        });
                      }}
                    >
                      relabel
                    </button>
                  </li>
                ))}
              </ul>
              <Button
                disabled={busy}
                data-testid="propose-merge"
                onClick={() =>
                  void run(async () => {
                    const r = await mutate(workspaceId, `${api}/merge-proposals`, {
                      sourceBranchId: branchSel,
                    });
                    await refresh();
                    const id = String(r.result.proposalId ?? "");
                    if (id) await openProposal(id);
                  })
                }
              >
                Propose merge into main
              </Button>
            </div>
          ) : null}
        </section>

        <section className={e.card} aria-labelledby="h-merge">
          <h2 className={e.h2} id="h-merge">
            Merge proposals
          </h2>
          <ul className={e.links} data-testid="proposal-list">
            {proposals.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={e.linkBtn}
                  onClick={() => void openProposal(p.id)}
                  data-testid={`open-proposal-${p.id}`}
                >
                  {branches.find((b) => b.id === p.sourceBranchId)?.name ?? p.sourceBranchId} → main
                </button>{" "}
                <span className={e.muted}>
                  {p.status} · {p.changeCount} change(s), {p.conflictCount} conflict(s)
                </span>
              </li>
            ))}
          </ul>
          {proposal ? (
            <div data-testid="proposal-view">
              <h3 className={e.h3}>
                Proposal {proposal.id.slice(0, 8)} · {proposal.status}
                {proposal.requiredApprovals.length ? (
                  <span className={e.warn}> · requires: {proposal.requiredApprovals.join(", ")}</span>
                ) : null}
              </h3>
              <Changes changes={proposal.changes} testId="proposal-changes" deferMark />
              {proposal.evidenceHashDiffs.length ? (
                <p className={e.muted}>
                  {proposal.evidenceHashDiffs.length} evidence object(s) change their hash:{" "}
                  {proposal.evidenceHashDiffs.map((d) => d.objectId).join(", ")}
                </p>
              ) : null}
              {proposal.excluded?.length ? (
                <div data-testid="proposal-excluded">
                  <h3 className={e.h3}>Excluded by policy (not merged)</h3>
                  <ul className={e.links}>
                    {proposal.excluded.map((x) => (
                      <li key={x.objectId}>
                        <code className={e.mono}>{short(x.objectId)}</code>{" "}
                        <span className={e.deferred}>{x.reasonCode}</span>: {x.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <h3 className={e.h3}>Conflicts ({unresolved} unresolved)</h3>
              {proposal.conflicts.length ? (
                <table className={e.table} data-testid="conflicts">
                  <thead>
                    <tr>
                      <th>Object</th>
                      <th>Base</th>
                      <th>Branch (ours)</th>
                      <th>Main (theirs)</th>
                      <th>Resolution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposal.conflicts.map((c) => (
                      <tr key={c.objectId}>
                        <td className={e.mono}>{short(c.objectId)}</td>
                        <td className={e.mono}>{json(c.base)}</td>
                        <td className={e.mono}>{json(c.ours)}</td>
                        <td className={e.mono}>{json(c.theirs)}</td>
                        <td>
                          {proposal.status === "open"
                            ? (["ours", "theirs", "keep_both"] as const).map((r) => (
                                <Button
                                  key={r}
                                  size="sm"
                                  aria-pressed={c.resolution === r}
                                  data-testid={`resolve-${r}`}
                                  disabled={busy}
                                  onClick={() =>
                                    void run(async () => {
                                      await mutate(
                                        workspaceId,
                                        `${api}/merge-proposals/${proposal.id}/resolve`,
                                        { objectId: c.objectId, resolution: r },
                                      );
                                      await openProposal(proposal.id);
                                    })
                                  }
                                >
                                  {r === "ours" ? "keep branch" : r === "theirs" ? "keep main" : "keep both"}
                                </Button>
                              ))
                            : c.resolution}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className={e.muted}>No conflicts.</p>
              )}
              {proposal.status === "open" ? (
                <div className={e.toolbar}>
                  <label>
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(ev) => setAck(ev.target.checked)}
                      data-testid="ack-verdict"
                    />{" "}
                    I acknowledge this merge may change a claim verdict
                  </label>
                  <Button
                    disabled={busy || unresolved > 0}
                    data-testid="accept-merge"
                    onClick={() =>
                      void run(async () => {
                        const r = await mutate(workspaceId, `${api}/merge-proposals/${proposal.id}/accept`, {
                          acknowledgeVerdictChange: ack,
                        });
                        setLastAccept({
                          applied: Number(r.result.applied ?? 0),
                          deferredObjects: (r.result.deferredObjects as string[] | undefined) ?? [],
                        });
                        setProposal(await getJson<Proposal>(`${api}/merge-proposals/${proposal.id}`));
                        await refresh();
                      })
                    }
                  >
                    {unresolved > 0 ? `Resolve ${unresolved} conflict(s) first` : "Accept merge"}
                  </Button>
                  <Button
                    disabled={busy}
                    data-testid="reject-merge"
                    onClick={() =>
                      void run(async () => {
                        await mutate(workspaceId, `${api}/merge-proposals/${proposal.id}/reject`, {});
                        setProposal(await getJson<Proposal>(`${api}/merge-proposals/${proposal.id}`));
                        await refresh();
                      })
                    }
                  >
                    Reject
                  </Button>
                </div>
              ) : null}
              {lastAccept ? (
                <div className={e.vintage} data-testid="merge-result">
                  Applied {lastAccept.applied} change(s).{" "}
                  {lastAccept.deferredObjects.length ? (
                    <span className={e.deferred}>
                      Deferred, not applied: {lastAccept.deferredObjects.join(", ")}
                    </span>
                  ) : (
                    "Nothing deferred."
                  )}
                </div>
              ) : null}
              <p className={e.muted} data-testid="comments-note">
                Reviewer comments are attached to evidence nodes: open a node in the{" "}
                <a href={`/w/${workspaceId}/evidence`}>evidence graph</a> to read or add them.
              </p>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
