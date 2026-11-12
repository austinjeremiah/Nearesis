'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { PanelFrame, PanelProvenance } from '@/components/nx/panel';
import {
  Badge,
  CoverageChip,
  DataModeIndicator,
  MaturityChip,
  ReasonCodeList,
} from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, LinkButton, Notice, Select, Tabs } from '@/components/nx/ui';
import { DataTable, type Column } from '@/components/nx/table';
import * as db from '@/lib/data/client';
import type { Point } from '@/lib/data/series';
import { EM_DASH, formatMeasure, formatUtc, shortHash } from '@/lib/format';

/**
 * Spec 5.8 — panel full view.
 *
 * Large chart on top, then Data, Query, Provenance, Evidence, History and
 * Display. The Data tab is where spec 4.4 is most visible: an unavailable day
 * renders as an em dash in the table, exactly as it breaks the line in the
 * chart, rather than being dropped from the rows.
 */
type Tab = 'data' | 'query' | 'provenance' | 'evidence' | 'history' | 'display';

export default function PanelDetailPage({
  params,
}: {
  params: Promise<{ wid: string; panelId: string }>;
}) {
  const { wid, panelId } = use(params);
  const ws = db.workspace(wid);
  const panel = db.panel(wid, panelId);
  const [tab, setTab] = useState<Tab>('data');
  const [scale, setScale] = useState('linear');

  if (!ws || !panel) {
    return (
      <Content>
        <EmptyState
          title="Panel not found"
          body="That panel does not exist, or you do not have access to it."
          action={<LinkButton href={`/w/${wid}/canvas`}>Back to canvas</LinkButton>}
        />
      </Content>
    );
  }

  const result = db.resultFor(panel.metricIds);
  const primaryMetric = db.metric(panel.metricIds[0]);
  const rows: Point[] = db.seriesFor(panel.metricIds[0]).slice(-60).reverse();
  const markers = db.markers(wid).filter((m) => m.panelId === panel.id);

  const cols: Column<Point>[] = [
    { key: 'date', header: 'Block date (UTC)', render: (r) => <span className="mono">{r[0]}</span> },
    {
      key: 'value',
      header: `${primaryMetric?.name ?? ''} (${primaryMetric?.unit ?? ''})`,
      numeric: true,
      render: (r) =>
        r[1] === null ? (
          <span className="unavailable" title="Unavailable. Not an observed zero." />
        ) : (
          <span className="mono">{formatMeasure(r[1], { precision: primaryMetric?.kind === 'price' ? 4 : 0 })}</span>
        ),
    },
    {
      key: 'state',
      header: 'State',
      render: (r) =>
        r[1] === null ? <Badge tone="warn">Unavailable</Badge> : <Badge tone="ok">Observed</Badge>,
    },
  ];

  return (
    <>
      <PageHeader
        title={panel.title}
        description={panel.description}
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Canvas', href: `/w/${wid}/canvas` },
          { label: panel.title },
        ]}
        context={
          <>
            <MaturityChip maturity={result.source.maturity} />
            <DataModeIndicator
              mode={result.source.dataMode}
              origin={result.source.datasetOrigin}
              watermark={result.source.sourceWatermark}
            />
          </>
        }
        actions={
          <>
            <LinkButton href={`/w/${wid}/canvas`}>Back to canvas</LinkButton>
            <Button disabled disabledReason="Creating a marker needs a range selection and the authorized API.">
              Add marker
            </Button>
            <Button disabled disabledReason="Export needs the authorized API. Not available on fixture data.">
              Export
            </Button>
          </>
        }
      />
      <Content>
        <PanelFrame panel={panel} workspaceId={wid} height={340} />

        <Tabs<Tab>
          ariaLabel="Panel detail"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'data', label: 'Data' },
            { value: 'query', label: 'Query' },
            { value: 'provenance', label: 'Provenance' },
            { value: 'evidence', label: 'Evidence' },
            { value: 'history', label: 'History' },
            { value: 'display', label: 'Display' },
          ]}
        />

        {tab === 'data' && (
          <div className="col gap3">
            <Notice tone="info" title="How to read this table">
              An em dash ({EM_DASH}) means the value is unavailable for that day. It is not a zero,
              and the row is kept so the gap is visible rather than silently absent.
            </Notice>
            <DataTable
              caption={`Last 60 days of ${result.rowCount} rows`}
              columns={cols}
              rows={rows}
              rowKey={(r) => r[0]}
            />
          </div>
        )}

        {tab === 'query' && (
          <Card title="Query" subtitle="Read-only. Re-running produces a new result revision.">
            <KeyValues
              rows={[
                { k: 'Canonical hash', v: <span className="mono">{result.query.canonicalQueryHash}</span> },
                { k: 'Semantic version', v: <span className="mono">{result.query.semanticVersion}</span> },
                { k: 'Snapshot', v: <span className="mono">{result.query.snapshotId}</span> },
                { k: 'Grain', v: <span className="mono">{result.query.grain} · {result.query.timezone}</span> },
                {
                  k: 'Measures',
                  v: panel.metricIds.map((m) => (
                    <Link key={m} className="link mono" href={`/data/metrics/${m}`} style={{ display: 'block' }}>
                      {m}
                    </Link>
                  )),
                },
              ]}
            />
            <div className="col gap2">
              <span className="label">Measure definition</span>
              <pre
                className="mono"
                style={{
                  margin: 0,
                  padding: 12,
                  background: 'var(--sunken)',
                  whiteSpace: 'pre-wrap',
                  fontSize: 12,
                }}
              >
                {primaryMetric?.definition}
              </pre>
            </div>
            <div className="row gap2">
              <Button
                onClick={() => navigator.clipboard?.writeText(result.query.canonicalQueryHash)}
              >
                Copy query hash
              </Button>
              <Button disabled disabledReason="Re-running needs the authorized API.">Re-run</Button>
            </div>
          </Card>
        )}

        {tab === 'provenance' && (
          <Card title="Provenance">
            <PanelProvenance panel={panel} />
          </Card>
        )}

        {tab === 'evidence' && (
          <Card title="Evidence links">
            {markers.length === 0 ? (
              <EmptyState
                title="No markers on this panel"
                body="Select a range on the chart to create one. A selection alone does not run anything."
              />
            ) : (
              <div className="col gap3">
                {markers.map((m) => {
                  const f = db.finding(m.findingId);
                  return (
                    <div key={m.id} className="col gap2" style={{ borderBottom: '1px dashed var(--line)', paddingBottom: 12 }}>
                      <Link className="small strong" href={`/w/${wid}/markers/${m.id}`}>
                        {m.label}
                      </Link>
                      <span className="tiny mono dim">
                        {formatUtc(m.start, false)} to {formatUtc(m.end, false)}
                      </span>
                      {m.assignedTo && <Badge outline>Assigned to {m.assignedTo}</Badge>}
                      {f && <p className="small muted">{f.summary}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        {tab === 'history' && (
          <Card title="Revisions" subtitle="Layout, data and evidence revisions are tracked separately.">
            <KeyValues
              rows={[
                { k: 'Document revision', v: <span className="mono">3</span> },
                { k: 'Data revision', v: <span className="mono">7</span> },
                { k: 'Evidence revision', v: <span className="mono">2</span> },
                { k: 'Last good result', v: <span className="mono">{shortHash(result.resultHash)}</span> },
              ]}
            />
            <p className="tiny dim">
              These three never collide. A layout change does not invalidate the data, and a
              refresh does not rewrite the evidence attached to a marker.
            </p>
            <Button disabled disabledReason="Restoring a revision needs the authorized API.">
              Restore a previous revision
            </Button>
          </Card>
        )}

        {tab === 'display' && (
          <Card title="Display" subtitle="Validated before apply. An invalid combination is refused, not rendered.">
            <div className="row gap4 wrap">
              <div className="field" style={{ minWidth: 180 }}>
                <span className="label">Scale</span>
                <Select
                  value={scale}
                  onChange={(e) => setScale(e.target.value)}
                  options={[
                    { value: 'linear', label: 'Linear' },
                    { value: 'log', label: 'Logarithmic' },
                  ]}
                />
              </div>
              <div className="field" style={{ minWidth: 220 }}>
                <span className="label">Missing values</span>
                <Select
                  value="break"
                  onChange={() => undefined}
                  options={[
                    { value: 'break', label: 'Break the line' },
                    { value: 'show_gap', label: 'Shade the gap' },
                  ]}
                />
              </div>
            </div>
            <Notice tone="info" title="Interpolation is not an option">
              There is no setting that draws a line through missing data. A gap is a fact about the
              source and the chart has to show it.
            </Notice>
            {scale === 'log' && (
              <Notice tone="warn" title="Log scale changes how a reader reads the slope">
                The axis will be labelled as logarithmic on export and in the static dashboard.
              </Notice>
            )}
            <div className="row gap2">
              <ReasonCodeList codes={panel.reasonCodes} />
              <CoverageChip coverage={result.source.coverage} />
            </div>
          </Card>
        )}
      </Content>
    </>
  );
}
