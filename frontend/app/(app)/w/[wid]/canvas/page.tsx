'use client';

import { use, useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Crosshair,
  Grid2x2,
  Keyboard,
  Plus,
  Redo2,
  Share2,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { Content, PageHeader } from '@/components/nx/shell';
import { PanelFrame, PanelProvenance } from '@/components/nx/panel';
import { PackPanelFrame, PackProvenance } from '@/components/nx/charts/pack-panel';
import { CanvasGrid, useLayoutHistory, type LayoutMap, type Rect } from '@/components/nx/canvas-grid';
import { Modal } from '@/components/nx/overlays';
import { Menu } from '@/components/nx/overlays';
import {
  Button,
  Card,
  EmptyState,
  IconButton,
  Input,
  KeyValues,
  Notice,
  Segmented,
  Select,
  Tabs,
  Textarea,
} from '@/components/nx/ui';
import { Badge, DataModeIndicator, ReasonCodeList } from '@/components/nx/evidence';
import { packFixture, packRows, SYNTHETIC_LABEL } from '@/lib/fixtures/pack';
import { validateViz } from '@/lib/viz/spec';
import * as db from '@/lib/data/client';
import { formatUsd, formatUtc, shortHash } from '@/lib/format';

/**
 * Spec 5.7 — Dynamic Canvas. The flagship screen.
 *
 * A canvas, not a page of preset widgets: panels are dragged, resized and
 * snapped on a twelve column track, the layout is a document revision of its
 * own, and undo moves geometry without touching a single query result.
 *
 * The behaviours the spec is strict about, all visible here.
 * A drag selection is ephemeral until the reader explicitly creates a marker:
 * no agent is spawned by hover, click, zoom or selection alone.
 * An AI edit arrives as a patch and is reviewed as a diff before it commits.
 * A query that fails leaves an explicit failed panel rather than being dropped
 * or filled with substitute numbers.
 * A lens that cannot apply to a panel says so and changes nothing.
 */

type Mode = 'grid' | 'freeform';
type InspectorTab = 'configure' | 'query' | 'sources' | 'evidence' | 'activity';

/** The full selection record spec 6.5 requires. Ephemeral by construction. */
type Selection = {
  panelId: string;
  seriesIds: string[];
  intervalUTC: { start: string; end: string };
  selectedPointIds: string[];
  queryHash: string;
  semanticVersion: string;
  sourceWatermark: string | null;
  units: string[];
};

const ROW_H = 56;
const GAP = 16;

/** Chart height for a panel of h tracks, after the header and footer chrome. */
function chartHeight(rect: Rect): number {
  return Math.max(120, rect.h * ROW_H + (rect.h - 1) * GAP - 132);
}

export default function CanvasPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = use(params);
  const ws = db.workspace(wid);
  const panels = useMemo(() => db.panels(wid), [wid]);

  const initialLayout = useMemo<LayoutMap>(
    () => Object.fromEntries(panels.map((p) => [p.id, p.layout])),
    [panels],
  );
  const history = useLayoutHistory(initialLayout, `nx.canvas.${wid}.layout`);

  const [mode, setMode] = useState<Mode>('grid');
  const [showGrid, setShowGrid] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<InspectorTab>('configure');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [lens, setLens] = useState('none');
  const [range, setRange] = useState('all');
  const [shareOpen, setShareOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const selectedPanel = useMemo(
    () => panels.find((p) => p.id === (selected ?? selection?.panelId)),
    [panels, selected, selection],
  );
  const selectedFixture = selectedPanel?.packFixtureId
    ? packFixture(selectedPanel.packFixtureId)
    : undefined;

  /**
   * Brushing records the whole selection context, because a marker made from
   * it has to pin the exact query and snapshot it was taken against, not just
   * two dates that might mean something different tomorrow.
   */
  const onSelectRange = useCallback(
    (panelId: string, r: { start: string; end: string }) => {
      const panel = panels.find((p) => p.id === panelId);
      if (!panel) return;
      const fixture = panel.packFixtureId ? packFixture(panel.packFixtureId) : undefined;
      const envelope = fixture?.result ?? db.resultFor(panel.metricIds);
      setSelected(panelId);
      setSelection({
        panelId,
        seriesIds: panel.metricIds,
        intervalUTC: r,
        selectedPointIds: [],
        queryHash: envelope.query.canonicalQueryHash,
        semanticVersion: envelope.query.semanticVersion,
        sourceWatermark: envelope.source.sourceWatermark,
        units: (envelope.columns ?? [])
          .filter((c) => c.role === 'measure')
          .map((c) => c.unit),
      });
    },
    [panels],
  );

  /**
   * A lens applies only where the measure it filters exists. Spec 6.5: an
   * incompatible panel reads "Lens not applicable" and is left untouched,
   * rather than being silently emptied.
   */
  const lensApplies = useCallback(
    (panelId: string): boolean => {
      if (lens === 'none') return true;
      const panel = panels.find((p) => p.id === panelId);
      if (!panel) return false;
      if (lens === 'ex_top5') return panel.kind === 'line' || panel.kind === 'bar';
      if (lens === 'stables') return panel.metricIds.some((m) => /quote|volume|swap/.test(m));
      return true;
    },
    [lens, panels],
  );

  if (!ws) return null;

  const ids = panels.map((p) => p.id);
  const lensIncompatible = ids.filter((id) => !lensApplies(id));

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
            <Badge outline title="Layout document revision. Data revisions are counted separately.">
              layout r{history.revision}
            </Badge>
          </>
        }
        actions={
          <Button onClick={() => setAskOpen(true)} variant="primary">
            <Sparkles size={14} />
            Ask AI to build or edit
          </Button>
        }
      />

      <div className="with-inspector">
        <Content>
          {/* ---- toolbar, spec 5.7 order ---- */}
          <div className="canvas-toolbar">
            <Select
              aria-label="Branch and snapshot"
              value={ws.snapshotId}
              onChange={() => undefined}
              options={[{ value: ws.snapshotId, label: `${ws.branch} · ${ws.snapshotId}` }]}
            />
            <Button disabled disabledReason="Adding a panel needs the authorized measure catalog.">
              <Plus size={14} />
              Add panel
            </Button>
            <span className="tool-sep" aria-hidden="true" />
            <IconButton
              label="Undo layout change"
              title={history.canUndo ? 'Undo layout change' : 'Nothing to undo yet'}
              onClick={history.undo}
              disabled={!history.canUndo}
            >
              <Undo2 size={15} />
            </IconButton>
            <IconButton
              label="Redo layout change"
              title={history.canRedo ? 'Redo layout change' : 'Nothing to redo'}
              onClick={history.redo}
              disabled={!history.canRedo}
            >
              <Redo2 size={15} />
            </IconButton>
            <Segmented
              ariaLabel="Layout mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'grid', label: 'Grid' },
                { value: 'freeform', label: 'Freeform' },
              ]}
            />
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
            <Select
              aria-label="Selected time range"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              options={[
                { value: 'all', label: 'Full series' },
                { value: '90', label: 'Last 90 days' },
                { value: '30', label: 'Last 30 days' },
              ]}
            />
            <div className="grow" />
            <Button onClick={() => setShareOpen(true)}>
              <Share2 size={14} />
              Share view
            </Button>
            <Button disabled disabledReason="Export carries provenance and needs the authorized API.">
              Export
            </Button>
            <Menu
              align="end"
              trigger={<IconButton label="More canvas actions"><Grid2x2 size={15} /></IconButton>}
              items={[
                { label: showGrid ? 'Hide grid' : 'Show grid', onSelect: () => setShowGrid((v) => !v) },
                { label: 'Reset viewport', onSelect: () => history.reset(initialLayout) },
                { label: 'Keyboard shortcuts', onSelect: () => setShortcutsOpen(true) },
              ]}
            />
          </div>

          {ws.id === db.FIXTURE_WORKSPACE_ID && (
            <Notice tone="bad" title={SYNTHETIC_LABEL}>
              Every panel in this workspace is drawn from the synthetic chart fixture pack. The
              records are fabricated for interface testing, they are not NEAR, NEAR Intents, 1Click
              or provider observations, and nothing here may be published as a finding.
            </Notice>
          )}

          {lens !== 'none' && (
            <Notice tone="info" title="A lens is applied">
              This is a view-level filter. It changes what the compatible panels show, never the
              certified measure definition, and it is not saved into the panels.
              {lensIncompatible.length > 0 && (
                <>
                  {' '}
                  {lensIncompatible.length} panel(s) cannot accept it and are left unchanged.
                </>
              )}
            </Notice>
          )}

          {selection && (
            <Notice tone="info" title="Range selected">
              <div className="col gap2">
                <div className="row gap3 wrap" style={{ alignItems: 'center' }}>
                  <span className="mono small">
                    {formatUtc(selection.intervalUTC.start, false)} to{' '}
                    {formatUtc(selection.intervalUTC.end, false)}
                  </span>
                  <span className="small">
                    Ephemeral. Nothing has been created and no agent has run.
                  </span>
                </div>
                <div className="row gap2 wrap">
                  <Button variant="primary" disabled disabledReason="Creating a marker needs the authorized API.">
                    Create marker
                  </Button>
                  <Button disabled disabledReason="Assigning an agent needs an approval bound to this selection.">
                    Ask agent about selection
                  </Button>
                  <Button disabled disabledReason="Comparison needs a second authorized query.">
                    Compare interval
                  </Button>
                  <Button
                    onClick={() =>
                      navigator.clipboard?.writeText(
                        `${selection.intervalUTC.start}/${selection.intervalUTC.end}`,
                      )
                    }
                  >
                    Copy range
                  </Button>
                  <Button onClick={() => setSelection(null)}>Clear</Button>
                </div>
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
            <CanvasGrid
              ids={ids}
              layout={history.layout}
              onLayoutChange={history.set}
              onCommit={history.commit}
              snap={mode === 'grid'}
              showGrid={showGrid}
              rowHeight={ROW_H}
              gap={GAP}
              selectedId={selected}
              onSelect={setSelected}
              renderItem={(id) => {
                const panel = panels.find((p) => p.id === id);
                if (!panel) return null;
                const rect = history.layout[id] ?? panel.layout;
                const h = chartHeight(rect);
                if (!lensApplies(id)) {
                  return (
                    <section className="card" aria-label={`${panel.title}, lens not applicable`}>
                      <header className="card-head">
                        <div className="grow">
                          <div className="h3" style={{ fontSize: 14 }}>{panel.title}</div>
                        </div>
                        <Badge tone="warn">Lens not applicable</Badge>
                      </header>
                      <div className="card-body">
                        <p className="small dim">
                          This panel does not carry the measure the lens filters on, so it is left
                          exactly as it was. It is not filtered to an empty result.
                        </p>
                      </div>
                    </section>
                  );
                }
                return panel.packFixtureId ? (
                  <PackPanelFrame
                    fixtureId={panel.packFixtureId}
                    panelId={panel.id}
                    workspaceId={wid}
                    height={h}
                    compactHeader
                    onSelectRange={(r) => onSelectRange(id, r)}
                  />
                ) : (
                  <PanelFrame
                    panel={panel}
                    workspaceId={wid}
                    height={h}
                    compactHeader
                    onSelectRange={(r) => onSelectRange(id, r)}
                  />
                );
              }}
            />
          )}

          <p className="tiny dim">
            Drag a panel to move it, drag its corner to resize, or focus one and use the arrow keys.
            Layout is a document revision: undo moves panels and never re-runs a query. Series over
            100k points are downsampled for the viewport and the method is stated in the inspector.
          </p>
        </Content>

        {/* ---- right inspector, spec 5.7 tabs ---- */}
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

                <Tabs
                  ariaLabel="Panel inspector sections"
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'configure', label: 'Configure' },
                    { value: 'query', label: 'Query' },
                    { value: 'sources', label: 'Sources' },
                    { value: 'evidence', label: 'Evidence' },
                    { value: 'activity', label: 'Activity' },
                  ]}
                />

                {tab === 'configure' && (
                  <InspectorConfigure
                    panelId={selectedPanel.id}
                    kind={selectedPanel.kind}
                    rect={history.layout[selectedPanel.id] ?? selectedPanel.layout}
                    onRect={(r) => history.commit({ ...history.layout, [selectedPanel.id]: r })}
                  />
                )}

                {tab === 'query' && (
                  <InspectorQuery panelId={selectedPanel.id} fixtureId={selectedPanel.packFixtureId} metricIds={selectedPanel.metricIds} />
                )}

                {tab === 'sources' &&
                  (selectedFixture ? (
                    <PackProvenance fixture={selectedFixture} />
                  ) : (
                    <PanelProvenance panel={selectedPanel} />
                  ))}

                {tab === 'evidence' && (
                  <div className="col gap3">
                    {db.claims(wid).length === 0 ? (
                      <p className="small dim">
                        No claim cites this panel yet. A panel becomes evidence when a claim links
                        to its result, not because it looks persuasive.
                      </p>
                    ) : (
                      db.claims(wid).map((c) => (
                        <Card key={c.id} title={<Link href={`/w/${wid}/claims/${c.id}`}>{c.statement}</Link>} />
                      ))
                    )}
                  </div>
                )}

                {tab === 'activity' && (
                  <div className="col gap2">
                    {db.timeline(wid).slice(0, 6).map((e) => (
                      <div key={e.id} className="tiny dim">
                        <span className="mono">{formatUtc(e.at)}</span> · {e.action}
                      </div>
                    ))}
                    {db.timeline(wid).length === 0 && (
                      <p className="small dim">No recorded activity for this workspace.</p>
                    )}
                  </div>
                )}

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
          <div className="col gap3">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Compare 90 days with the previous 90 days, and show volume next to the signer proxy."
              aria-label="Describe the change"
            />
            <Notice tone="info" title="What the model may and may not do">
              It proposes chart specifications and bounded queries over certified measures. It
              cannot invent an observation, a measure id, a hash or a permission, and a measure the
              catalog does not certify comes back as a missing measure rather than a new panel.
            </Notice>
          </div>
        ) : (
          <PatchDiff wid={wid} prompt={prompt} />
        )}
      </Modal>

      <Modal
        open={shareOpen}
        onOpenChange={setShareOpen}
        title="Share this view"
        description="A share link carries the layout, the snapshot and the lens, and is scoped to people who already have access."
        footer={<Button onClick={() => setShareOpen(false)}>Close</Button>}
      >
        <div className="col gap3">
          <Input
            readOnly
            aria-label="Share link"
            value={`https://nearesis.app/w/${wid}/canvas?rev=${history.revision}&snapshot=${ws.snapshotId}`}
          />
          <Notice tone="warn" title="Not a public link">
            Sharing does not grant access. A recipient without permission on this workspace sees a
            not found page, and the link is not a bare object id.
          </Notice>
        </div>
      </Modal>

      <Modal
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        title="Canvas keyboard shortcuts"
        footer={<Button onClick={() => setShortcutsOpen(false)}>Close</Button>}
      >
        <KeyValues
          rows={[
            { k: 'Tab', v: 'Move focus between panels' },
            { k: 'Arrow keys', v: 'Move the focused panel by one track' },
            { k: 'Shift + arrows', v: 'Resize the focused panel by one track' },
            { k: 'Cmd or Ctrl + K', v: 'Command palette' },
            { k: 'Esc', v: 'Dismiss the inspector or a dialog' },
          ]}
        />
      </Modal>
    </>
  );
}

/* ---------------------------------------------------------------------------
   inspector tabs
   ------------------------------------------------------------------------ */

function InspectorConfigure({
  panelId,
  kind,
  rect,
  onRect,
}: {
  panelId: string;
  kind: string;
  rect: Rect;
  onRect: (r: Rect) => void;
}) {
  return (
    <div className="col gap3">
      <KeyValues
        rows={[
          { k: 'Panel id', v: <span className="mono">{panelId}</span> },
          { k: 'Visualization', v: <span className="mono">{kind}</span> },
        ]}
      />
      <div className="col gap2">
        <span className="label">Layout</span>
        <div className="row gap2 wrap">
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <label key={k} className="col gap1" style={{ width: 64 }}>
              <span className="tiny dim">{k}</span>
              <Input
                type="number"
                value={String(Math.round(rect[k]))}
                aria-label={`Panel ${k}`}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) onRect({ ...rect, [k]: Math.max(0, n) });
                }}
              />
            </label>
          ))}
        </div>
        <p className="tiny dim">
          Twelve column track. Editing these numbers is the same change as dragging the panel, and
          it increments the layout revision only.
        </p>
      </div>
      <Notice tone="info" title="Changing a measure is not a relabel">
        Units, grain and aggregation come from the certified measure. Editing them here would
        request a new authorized query rather than renaming the data already on screen.
      </Notice>
    </div>
  );
}

function InspectorQuery({
  panelId,
  fixtureId,
  metricIds,
}: {
  panelId: string;
  fixtureId?: string;
  metricIds: string[];
}) {
  const fixture = fixtureId ? packFixture(fixtureId) : undefined;
  const envelope = fixture?.result ?? db.resultFor(metricIds);
  const rows = fixture ? packRows(fixture) : [];
  const verdict = fixture ? validateViz(fixture.chartSpec, fixture.result.columns, rows) : null;

  return (
    <div className="col gap3">
      <KeyValues
        rows={[
          { k: 'Result id', v: <span className="mono">{envelope.resultId}</span> },
          {
            k: 'Query hash',
            v: (
              <span className="mono" title={envelope.query.canonicalQueryHash}>
                {shortHash(envelope.query.canonicalQueryHash)}
              </span>
            ),
          },
          { k: 'Semantic version', v: <span className="mono">{envelope.query.semanticVersion}</span> },
          { k: 'Measures', v: envelope.query.metricIds.map((m) => <div key={m} className="mono">{m}</div>) },
          { k: 'Rows', v: <span className="mono">{envelope.rowCount}</span> },
          { k: 'Rows reference', v: <span className="mono">{envelope.rowsRef}</span> },
        ]}
      />
      {verdict && (
        <Notice tone={verdict.ok ? 'ok' : 'bad'} title={verdict.ok ? 'Specification validated' : 'Specification refused'}>
          {verdict.ok
            ? verdict.notes.join(' ') || 'Encodings, units and column roles all check out against this result.'
            : verdict.reason}
        </Notice>
      )}
      <p className="tiny dim">
        Panel {panelId} reads the result by reference. Re-running the query produces a new result
        id rather than editing this one.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   AI patch diff
   ------------------------------------------------------------------------ */

/**
 * The preview the spec demands before anything commits: the operations with
 * stable ids, the measures and snapshots behind them, the cost, and an honest
 * account of what could not be built.
 */
function PatchDiff({ wid, prompt }: { wid: string; prompt: string }) {
  const panels = db.panels(wid);
  return (
    <div className="col gap4">
      <KeyValues
        rows={[
          { k: 'Prompt', v: <span className="small">{prompt}</span> },
          { k: 'Workspace', v: <span className="mono">{wid}</span> },
          { k: 'Estimated cost', v: <span className="mono">{formatUsd(0.04)}</span> },
        ]}
      />

      <div className="col gap2">
        <span className="label">Proposed operations</span>
        <div className="table-wrap">
          <table className="table" data-density="compact">
            <thead>
              <tr>
                <th>Op</th>
                <th>Panel</th>
                <th>Measures</th>
                <th>Snapshot</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><Badge tone="ok">add</Badge></td>
                <td className="mono">p_new_compare</td>
                <td className="mono">intents.daily_volume</td>
                <td className="mono">{db.SNAPSHOT_ID}</td>
                <td className="mono">$0.02</td>
              </tr>
              <tr>
                <td><Badge tone="warn">update</Badge></td>
                <td className="mono">{panels[0]?.id ?? '—'}</td>
                <td className="mono">{panels[0]?.metricIds.join(', ') ?? '—'}</td>
                <td className="mono">{db.SNAPSHOT_ID}</td>
                <td className="mono">$0.02</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <Notice tone="warn" title="One requested panel cannot be built">
        The prompt asks for all-Intents solver market share. The certified catalog covers 1Click
        swap history only, so that panel is not proposed. A provider-scoped panel is offered
        instead and the missing source is named rather than estimated.
      </Notice>

      <Notice tone="info" title="Applying is atomic and revision checked">
        The patch carries the document revision it was built against. If the canvas has moved on,
        the apply is refused with a diff and the choice to refresh, apply to latest or discard.
      </Notice>
    </div>
  );
}
