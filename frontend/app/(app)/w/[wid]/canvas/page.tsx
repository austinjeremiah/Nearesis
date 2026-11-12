'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, Redo2, Sparkles, Undo2 } from 'lucide-react';
import { Content, PageHeader } from '@/components/nx/shell';
import { PanelFrame, PanelProvenance } from '@/components/nx/panel';
import { Modal } from '@/components/nx/overlays';
import {
  Button,
  Card,
  EmptyState,
  Input,
  KeyValues,
  Notice,
  Select,
  Textarea,
} from '@/components/nx/ui';
import { Badge, DataModeIndicator, ReasonCodeList } from '@/components/nx/evidence';
import * as db from '@/lib/data/client';
import { formatUsd, formatUtc } from '@/lib/format';

/**
 * Spec 5.7 — Dynamic Canvas. The flagship screen.
 *
 * Three behaviours the spec is strict about, all visible here.
 * A drag selection is ephemeral until the user explicitly creates a marker: no
 * agent is spawned by hover, click, zoom or selection alone.
 * An AI edit arrives as a patch and is reviewed as a diff before it commits.
 * A query that fails leaves an explicit failed panel rather than being dropped
 * or filled with substitute numbers.
 */
export default function CanvasPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = use(params);
  const ws = db.workspace(wid);
  const panels = db.panels(wid);

  const [selected, setSelected] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ panelId: string; start: string; end: string } | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [lens, setLens] = useState('none');

  const selectedPanel = useMemo(
    () => panels.find((p) => p.id === (selected ?? selection?.panelId)),
    [panels, selected, selection],
  );

  if (!ws) return null;

  return (
    <>
      <PageHeader
        title="Canvas"
        description="Panels are typed specs bound to a certified query. Nothing here renders without its provenance."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Canvas' },
        ]}
        context={
          <>
            <Badge outline>branch {ws.branch}</Badge>
            <DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />
          </>
        }
        actions={
          <>
            <Button onClick={() => setAskOpen(true)} variant="primary">
              <Sparkles size={14} />
              Ask AI to build or edit
            </Button>
          </>
        }
      />

      <div className="with-inspector">
        <Content>
          {/* ---- toolbar ---- */}
          <div className="row gap2 wrap" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 12 }}>
            <Select
              aria-label="Snapshot"
              value={ws.snapshotId}
              onChange={() => undefined}
              options={[{ value: ws.snapshotId, label: `Snapshot ${ws.snapshotId}` }]}
            />
            <Button disabled disabledReason="Adding a panel needs the authorized API.">
              <Plus size={14} />
              Add panel
            </Button>
            <Button disabled disabledReason="Nothing to undo in this session.">
              <Undo2 size={14} />
              Undo
            </Button>
            <Button disabled disabledReason="Nothing to redo in this session.">
              <Redo2 size={14} />
              Redo
            </Button>
            <Select
              aria-label="Lens"
              value={lens}
              onChange={(e) => setLens(e.target.value)}
              options={[
                { value: 'none', label: 'No lens' },
                { value: 'ex_top5', label: 'Lens: exclude top 5% volume cohort' },
                { value: 'stables', label: 'Lens: stablecoin routes only' },
              ]}
            />
            <div className="grow" />
            <Button disabled disabledReason="Export needs the authorized API. Not available on fixture data.">
              Export
            </Button>
          </div>

          {lens !== 'none' && (
            <Notice tone="info" title="A lens is applied">
              Every panel below is filtered by this view-level lens. It changes what the charts
              show, not the underlying measure definition, and it is not saved into the panels.
            </Notice>
          )}

          {selection && (
            <Notice tone="info" title="Range selected">
              <div className="row gap3 wrap" style={{ alignItems: 'center' }}>
                <span className="mono small">
                  {formatUtc(selection.start, false)} to {formatUtc(selection.end, false)}
                </span>
                <span className="small">
                  This selection is ephemeral. Nothing has been created and no agent has run.
                </span>
                <Button
                  variant="primary"
                  disabled
                  disabledReason="Creating a marker needs the authorized API."
                >
                  Create marker from selection
                </Button>
                <Button onClick={() => setSelection(null)}>Clear</Button>
              </div>
            </Notice>
          )}

          {panels.length === 0 ? (
            <EmptyState
              title="Describe the comparisons you want to see"
              body="Nearesis will use certified metrics and show their sources. Pick a source scope and a snapshot first."
              action={
                <Button variant="primary" onClick={() => setAskOpen(true)}>
                  Describe the dashboard you want
                </Button>
              }
              secondary={<Button disabled disabledReason="Templates need the authorized API.">Choose a template</Button>}
            />
          ) : (
            <div className="grid c2">
              {panels.map((p) => (
                <div
                  key={p.id}
                  onClick={() => setSelected(p.id)}
                  style={{ outline: selected === p.id ? '2px solid var(--accent)' : undefined }}
                >
                  <PanelFrame
                    panel={p}
                    workspaceId={wid}
                    height={230}
                    onSelectRange={(r) => {
                      setSelected(p.id);
                      setSelection({ panelId: p.id, ...r });
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          <p className="tiny dim">
            Series over 100k points are downsampled for the viewport and the method is stated in
            the panel inspector. Zooming requests the detail rather than redrawing an approximation.
          </p>
        </Content>

        <aside className="inspector" aria-label="Panel inspector">
          <div className="inspector-head">
            <span className="label">{selectedPanel ? 'Panel' : 'Inspector'}</span>
          </div>
          <div className="inspector-body">
            {!selectedPanel ? (
              <p className="small dim">
                Select a panel to see its configuration, query, sources, evidence and activity.
              </p>
            ) : (
              <>
                <div className="col gap2">
                  <span className="h3">{selectedPanel.title}</span>
                  <p className="small dim">{selectedPanel.description}</p>
                  <ReasonCodeList codes={selectedPanel.reasonCodes} />
                </div>
                <PanelProvenance panel={selectedPanel} />
                <div className="col gap2">
                  <span className="label">Activity</span>
                  {db
                    .timeline(wid)
                    .slice(0, 3)
                    .map((e) => (
                      <div key={e.id} className="tiny dim">
                        <span className="mono">{formatUtc(e.at)}</span> · {e.action}
                      </div>
                    ))}
                </div>
                <Link className="link small" href={`/w/${wid}/panels/${selectedPanel.id}`}>
                  Open full view
                </Link>
              </>
            )}
          </div>
        </aside>
      </div>

      {/* ---- AI edit modal, spec 5.7 ---- */}
      <Modal
        open={askOpen}
        onOpenChange={(v) => {
          setAskOpen(v);
          if (!v) setShowDiff(false);
        }}
        wide
        title="Ask AI to build or edit the canvas"
        description="The model proposes a patch. You review the diff before anything commits."
        footer={
          showDiff ? (
            <>
              <Button onClick={() => setShowDiff(false)}>Revise prompt</Button>
              <Button variant="primary" disabled disabledReason="Applying a patch needs the authorized API.">
                Apply changes
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => setAskOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => setShowDiff(true)}
                disabled={prompt.trim().length < 6}
                disabledReason="Describe the change first."
              >
                Preview patch
              </Button>
            </>
          )
        }
      >
        {!showDiff ? (
          <>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Compare 90 days with the previous 90 days, and show volume next to the signer proxy."
              aria-label="Describe the change"
            />
            <p className="tiny dim">
              The model emits a typed panel spec, never React, SQL or HTML. Anything it cannot
              express in that schema cannot reach the canvas.
            </p>
          </>
        ) : (
          <div className="col gap4">
            <Card title="Proposed patch" actions={<Badge tone="warn">Not applied</Badge>}>
              <KeyValues
                rows={[
                  { k: 'Operations', v: '2 add, 1 update, 0 remove' },
                  { k: 'Expected revision', v: <span className="mono">12</span> },
                  { k: 'Query count', v: <span className="mono">3</span> },
                  { k: 'Estimated cost', v: <span className="mono">{formatUsd(0.14)}</span> },
                  { k: 'Snapshot', v: <span className="mono">{ws.snapshotId}</span> },
                ]}
              />
            </Card>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Op</th>
                    <th>Panel</th>
                    <th>Measure</th>
                    <th>Range</th>
                    <th>Query hash</th>
                    <th>Risk</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><Badge tone="ok">add</Badge></td>
                    <td>Volume, 90d vs prior 90d</td>
                    <td className="mono">intents.daily_volume</td>
                    <td className="mono">180d</td>
                    <td className="mono">4f81c…</td>
                    <td><Badge tone="warn">Degraded source</Badge></td>
                  </tr>
                  <tr>
                    <td><Badge tone="ok">add</Badge></td>
                    <td>Signer proxy, 90d vs prior 90d</td>
                    <td className="mono">near.distinct_signer_proxy</td>
                    <td className="mono">180d</td>
                    <td className="mono">9b02a…</td>
                    <td><span className="unavailable" /></td>
                  </tr>
                  <tr>
                    <td><Badge tone="info">update</Badge></td>
                    <td>1Click swap volume</td>
                    <td className="mono">intents.daily_volume</td>
                    <td className="mono">90d → 180d</td>
                    <td className="mono">c771e… → 4f81c…</td>
                    <td><span className="unavailable" /></td>
                  </tr>
                </tbody>
              </table>
            </div>

            <Notice tone="warn" title="If one query fails, the patch still commits atomically">
              A panel whose query fails stays on the canvas in ERROR with its last good vintage and
              a retry. It is not dropped, and it is never filled with substitute numbers.
            </Notice>
          </div>
        )}
      </Modal>
    </>
  );
}
