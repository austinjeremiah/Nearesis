'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SectionBar } from '@/components/nx/section';
import { Badge } from '@/components/nx/evidence';
import { Button, Card, EmptyState, Field, Input, KeyValues, Notice, Select } from '@/components/nx/ui';
import { DataTable } from '@/components/nx/table';
import { ApiRequestError } from '@/lib/api/errors';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import { formatUtc } from '@/lib/format';
import { hist, type Reconstruction, type SnapshotRow } from '@/lib/ws6/api';
import { ActionError, Hash, Json, Slot, useAction } from '@/components/ws6/common';

function VintageBlock({ v }: { v: SnapshotRow['dataVintage'] }) {
  const pins = Object.keys(v.semanticPins ?? {});
  return (
    <KeyValues
      rows={[
        { k: 'Captured at', v: <span className="mono">{formatUtc(v.capturedAt)}</span> },
        { k: 'Event sequence', v: <span className="mono">{v.eventSeq}</span> },
        { k: 'Document revision', v: <span className="mono">{v.documentRevision}</span> },
        { k: 'Data revision', v: <span className="mono">{v.dataRevision}</span> },
        { k: 'Workspace version', v: <span className="mono">{v.workspaceVersion}</span> },
        { k: 'Semantic pins', v: pins.length ? <span className="mono">{pins.join(', ')}</span> : <span className="dim">none recorded</span> },
        {
          k: 'Source snapshot',
          v: v.sourceSnapshot ? <Hash value={v.sourceSnapshot.manifestHash} /> : <span className="dim">no source data pinned</span>,
        },
      ]}
    />
  );
}

function SnapshotDetail({ wid, sid }: { wid: string; sid: string }) {
  const q = useQuery({ queryKey: [...qk.snapshots(wid), sid], queryFn: () => hist.snapshot(wid, sid) });
  if (q.isError && q.error instanceof ApiRequestError && q.error.reasonCode === 'VINTAGE_UNAVAILABLE') {
    return (
      <div data-testid="vintage-unavailable">
        <Notice tone="warn" title="vintage_unavailable">
          {q.error.message} The data as of this snapshot can no longer be recovered, and today&apos;s data is not shown in its place. The snapshot&apos;s recorded hash and vintage metadata remain in the list.
        </Notice>
      </div>
    );
  }
  return (
    <Slot q={q}>
      {(s) => (
        <div className="col gap3" data-testid="snapshot-view" data-historical={String(s.historical)}>
          <Notice tone="info" title="Historical view">
            This is the workspace as of {formatUtc(s.capturedAt)}. It is not current data and cannot be published as current.
          </Notice>
          {s.stale && <Notice tone="warn" title="Newer revisions exist">The workspace has moved on: current document revision is {s.currentDocumentRevision}.</Notice>}
          {!s.integrityOk && <Notice tone="bad" title="Integrity check failed">The stored payload no longer matches its content hash. Nothing here should be trusted.</Notice>}
          <KeyValues
            rows={[
              { k: 'Label', v: s.label },
              { k: 'Content hash', v: <Hash value={s.contentHash} testId="snapshot-hash" /> },
              { k: 'Integrity', v: s.integrityOk ? <Badge tone="ok">hash verified</Badge> : <Badge tone="bad">mismatch</Badge> },
              { k: 'Panels at that time', v: <span className="mono">{s.canvas?.panels.length ?? 0}</span> },
              { k: 'Graph nodes / edges', v: <span className="mono">{s.graph ? `${s.graph.nodes.length} / ${s.graph.edges.length}` : 'not part of this view'}</span> },
            ]}
          />
          <div className="label">Data vintage</div>
          <VintageBlock v={s.dataVintage} />
          {s.canvas && s.canvas.panels.length > 0 && (
            <ul className="small">
              {s.canvas.panels.map((p) => (
                <li key={p.panelId}>{p.title ?? p.panelId}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Slot>
  );
}

function RevisionDetail({ r }: { r: Reconstruction }) {
  return (
    <div className="col gap3" data-testid="revision-view" data-exact={String(r.exactReproduction)}>
      <Notice tone={r.exactReproduction ? 'ok' : 'warn'} title={r.exactReproduction ? 'Exact reproduction' : 'Historical view only'}>
        {r.notice}
      </Notice>
      <KeyValues
        rows={[
          { k: 'Revision (journal seq)', v: <span className="mono">{r.revision}</span> },
          { k: 'Events applied', v: <span className="mono">{r.eventsApplied.length}</span> },
          { k: 'State hash', v: <Hash value={r.stateHash} /> },
          { k: 'Pinned snapshot', v: r.pinnedSnapshotId ? <Hash value={r.pinnedSnapshotId} /> : <span className="dim">none</span> },
          { k: 'Unreplayable events', v: <span className="mono">{r.unreplayableEvents.length}</span> },
        ]}
      />
      {r.panels.length === 0 ? (
        <p className="small dim">No panels existed at this revision.</p>
      ) : (
        <ul className="col gap2" style={{ listStyle: 'none', padding: 0 }}>
          {r.panels.map((p) => (
            <li key={p.panelId} className="row gap2" data-testid="revision-panel" data-state={p.dataState}>
              <span className="mono small">{p.panelId.slice(0, 12)}</span>
              {p.dataState === 'pinned' ? (
                <Badge tone="ok">pinned data vintage</Badge>
              ) : (
                <>
                  <Badge tone="warn">vintage_unavailable</Badge>
                  <span className="small dim">No recoverable data for this panel at that revision. Current data is not substituted.</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {r.unavailableSnapshotIds.length > 0 && <Json value={{ unavailableSnapshotIds: r.unavailableSnapshotIds }} />}
    </div>
  );
}

export default function HistoryView({ wid }: { wid: string }) {
  const snaps = useQuery({ queryKey: qk.snapshots(wid), queryFn: () => hist.snapshots(wid) });
  const timeline = useQuery({ queryKey: qk.timeline(wid), queryFn: () => browserApi.timeline(wid) });
  const [sid, setSid] = useState<string | null>(null);
  const [rev, setRev] = useState<Reconstruction | null>(null);
  const [revErr, setRevErr] = useState<unknown>(null);
  const [label, setLabel] = useState('');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [cmp, setCmp] = useState<unknown>(null);

  const create = useAction((l: string) => hist.createSnapshot(wid, l), {
    invalidate: [[...qk.snapshots(wid)], [...qk.timeline(wid)]],
    onDone: (r) => {
      setLabel('');
      setSid(r.result.snapshotId);
    },
  });
  const compare = useAction(() => hist.compare(wid, a, b), { onDone: setCmp });

  async function openRevision(seq: number) {
    setRevErr(null);
    try {
      setRev(await hist.revision(wid, seq));
    } catch (e) {
      setRev(null);
      setRevErr(e);
    }
  }

  const rows = snaps.data?.snapshots ?? [];

  return (
    <>
      <section>
        <SectionBar title="Snapshots" number="001" />
        <div className="grid c2">
          <Card
            title="Recorded snapshots"
            actions={
              <form
                className="row gap2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (label.trim()) void create.run(label.trim());
                }}
              >
                <Input aria-label="Snapshot label" placeholder="Snapshot label" value={label} onChange={(e) => setLabel(e.target.value)} data-testid="snapshot-label" />
                <Button variant="primary" type="submit" pending={create.pending} disabled={!label.trim()} disabledReason="Enter a label" data-testid="snapshot-create">
                  Take snapshot
                </Button>
              </form>
            }
          >
            <ActionError error={create.error} />
            <Slot q={snaps}>
              {() => (
                <DataTable
                  caption="Snapshots"
                  rows={rows}
                  rowKey={(r) => r.id}
                  empty={{ title: 'No snapshots yet', body: 'Take a snapshot to freeze the canvas, graph and data vintage at this moment.' }}
                  onRowClick={(r) => setSid(r.id)}
                  columns={[
                    { key: 'label', header: 'Label', render: (r) => <span className="strong">{r.label}</span> },
                    { key: 'at', header: 'Captured', render: (r) => <span className="mono small">{formatUtc(r.dataVintage.capturedAt)}</span> },
                    { key: 'seq', header: 'Seq', numeric: true, render: (r) => r.dataVintage.eventSeq },
                    { key: 'hash', header: 'Hash', render: (r) => <Hash value={r.contentHash} /> },
                  ]}
                />
              )}
            </Slot>
            {rows.length >= 2 && (
              <div className="row gap2" style={{ marginTop: 12 }}>
                <Field label="Compare A">
                  <Select value={a} onChange={(e) => setA(e.target.value)} aria-label="Snapshot A" data-testid="compare-a" options={[{ value: "", label: "Select" }, ...rows.map((r) => ({ value: r.id, label: r.label }))]} />
                </Field>
                <Field label="Compare B">
                  <Select value={b} onChange={(e) => setB(e.target.value)} aria-label="Snapshot B" data-testid="compare-b" options={[{ value: "", label: "Select" }, ...rows.map((r) => ({ value: r.id, label: r.label }))]} />
                </Field>
                <Button onClick={() => void compare.run()} disabled={!a || !b || a === b} disabledReason="Pick two different snapshots" pending={compare.pending} data-testid="compare-run">
                  Compare
                </Button>
              </div>
            )}
            <ActionError error={compare.error} />
            {cmp !== null && (
              <div data-testid="compare-result">
                <Json value={cmp} />
              </div>
            )}
          </Card>
          <Card title="Snapshot view">{sid ? <SnapshotDetail wid={wid} sid={sid} /> : <EmptyState title="Select a snapshot" body="Choose a snapshot to see the workspace as it was, with its data vintage." />}</Card>
        </div>
      </section>

      <section>
        <SectionBar title="Revision timeline" number="002" />
        <div className="grid c2">
          <Card title="Recorded events" subtitle="A revision is a journal sequence number. Open one to reconstruct the workspace at that point.">
            <Slot q={timeline}>
              {(t) => (
                <DataTable
                  caption="Revision timeline"
                  rows={[...t.entries].reverse().slice(0, 100)}
                  rowKey={(e) => String(e.seq)}
                  empty={{ title: 'No revisions yet' }}
                  onRowClick={(e) => void openRevision(e.seq)}
                  columns={[
                    { key: 'seq', header: 'Rev', numeric: true, render: (e) => e.seq },
                    { key: 'type', header: 'Event', render: (e) => <span className="mono small">{e.type}</span> },
                    { key: 'sum', header: 'Summary', render: (e) => e.summary },
                    { key: 'at', header: 'When', render: (e) => <span className="mono small">{formatUtc(e.at)}</span> },
                  ]}
                />
              )}
            </Slot>
          </Card>
          <Card title="Revision view">
            {revErr ? <ActionError error={revErr} /> : rev ? <RevisionDetail r={rev} /> : <EmptyState title="Select a revision" body="Choose an event to reconstruct the workspace at that revision." />}
          </Card>
        </div>
      </section>
    </>
  );
}
