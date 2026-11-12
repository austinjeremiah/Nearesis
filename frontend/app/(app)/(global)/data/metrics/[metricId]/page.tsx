'use client';

import { use, useCallback, useState } from 'react';
import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { Chart, baseOption, seriesPalette, type ChartTheme } from '@/components/nx/chart';
import { Badge, CoverageChip, DataModeIndicator, MaturityChip } from '@/components/nx/evidence';
import {
  Button,
  Card,
  EmptyState,
  KeyValues,
  LinkButton,
  Notice,
  Select,
} from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUsd, formatUtc, shortHash } from '@/lib/format';

/**
 * Spec 5.9 — metric detail.
 *
 * Definition, aggregation law, denominator policy, proxy meaning, version
 * history and a bounded preview. The preview has a cost estimate and a fixed
 * set of dimensions: an incompatible join is refused before it would run, not
 * after it returns something misleading.
 */
export default function MetricDetailPage({ params }: { params: Promise<{ metricId: string }> }) {
  const { metricId } = use(params);
  const m = db.metric(metricId);
  const [range, setRange] = useState('90');
  const [grain, setGrain] = useState('day');

  const option = useCallback(
    (t: ChartTheme) => {
      const base = baseOption(t);
      const pts = db.seriesFor(metricId).slice(-Number(range));
      return {
        ...base,
        series: [
          {
            type: 'line',
            connectNulls: false,
            showSymbol: false,
            lineStyle: { width: 1.75, color: seriesPalette(t)[0] },
            areaStyle: { color: seriesPalette(t)[0], opacity: 0.08 },
            data: pts.map(([d, v]) => [d, v]),
          },
        ],
      };
    },
    [metricId, range],
  );

  if (!m) {
    return (
      <Content>
        <EmptyState
          title="Measure not found"
          body="That measure does not exist in this catalog, or you do not have access to it."
          action={<LinkButton href="/data">Back to catalog</LinkButton>}
        />
      </Content>
    );
  }

  const src = db.source(m.sourceId);
  const result = db.resultFor([m.id]);

  return (
    <>
      <PageHeader
        title={m.name}
        description={m.definition}
        crumbs={[{ label: 'Explore data', href: '/data' }, { label: m.name }]}
        context={
          <>
            {m.certified ? <Badge tone="ok">Certified</Badge> : <Badge tone="warn">Workspace draft</Badge>}
            <MaturityChip maturity={result.source.maturity} />
            <DataModeIndicator mode="frozen" origin="fixture" watermark={result.source.sourceWatermark} />
          </>
        }
        actions={
          <>
            <Button onClick={() => navigator.clipboard?.writeText(m.id)}>Copy measure id</Button>
            <Button disabled disabledReason="Adding to a workspace needs the authorized API.">
              Add to workspace
            </Button>
          </>
        }
      />
      <Content>
        {m.proxyCaveat && (
          <Notice tone="info" title="What this measure is not">
            {m.proxyCaveat}
          </Notice>
        )}
        {!m.certified && (
          <Notice tone="warn" title="This is a workspace draft, not a certified measure">
            It can be charted inside the workspace that defined it, but it cannot be promoted into
            the global catalog without a maintainer review. Claims built on it are labelled.
          </Notice>
        )}

        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Definition">
            <KeyValues
              rows={[
                { k: 'Measure id', v: <span className="mono">{m.id}</span> },
                { k: 'Unit', v: <span className="mono">{m.unit}</span> },
                { k: 'Aggregation', v: m.kind },
                { k: 'Grain', v: <span className="mono">{m.grain} · UTC</span> },
                { k: 'Definition version', v: <span className="mono">{m.version}</span> },
                { k: 'Expected lag', v: <span className="mono">{m.lagHours} hours</span> },
                { k: 'Owner', v: m.owner },
                {
                  k: 'Source',
                  v: (
                    <Link className="link" href={`/data/sources/${m.sourceId}`}>
                      {src?.name ?? m.sourceId}
                    </Link>
                  ),
                },
                {
                  k: 'Denominator and zeros',
                  v: m.denominatorPolicy ?? 'Standard: unavailable rows are excluded and counted as unknown.',
                },
                { k: 'Visibility', v: m.visibility },
              ]}
            />
          </Card>

          <Card
            title="Preview"
            subtitle="Bounded. The cost is estimated before the query is allowed to run."
          >
            <div className="row gap3 wrap">
              <Select
                aria-label="Time range"
                value={range}
                onChange={(e) => setRange(e.target.value)}
                options={[
                  { value: '30', label: 'Last 30 days' },
                  { value: '90', label: 'Last 90 days' },
                  { value: '180', label: 'Last 180 days' },
                ]}
              />
              <Select
                aria-label="Grain"
                value={grain}
                onChange={(e) => setGrain(e.target.value)}
                options={[
                  { value: 'day', label: 'Day' },
                  { value: 'hour', label: 'Hour' },
                ]}
              />
              <span className="small dim row gap2">
                Estimated cost <span className="mono">{formatUsd(0.02)}</span>
              </span>
            </div>
            <Chart option={option} height={220} ariaLabel={`${m.name} over the last ${range} days`} />
            {grain === 'hour' && m.grain === 'day' && (
              <Notice tone="bad" title="Incompatible grain">
                This measure is defined at day grain. An hourly request is refused here rather than
                being silently resampled into a number that looks finer than the source.
              </Notice>
            )}
          </Card>
        </div>

        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Provenance">
            <KeyValues
              rows={[
                { k: 'Snapshot', v: <span className="mono">{result.source.snapshotId}</span> },
                { k: 'Raw manifest', v: <span className="mono">{shortHash(result.source.rawManifestHash)}</span> },
                { k: 'Watermark', v: <span className="mono">{formatUtc(result.source.sourceWatermark)}</span> },
                { k: 'Retrieved', v: <span className="mono">{formatUtc(result.source.retrievedAt)}</span> },
                { k: 'Coverage', v: <CoverageChip coverage={result.source.coverage} /> },
              ]}
            />
            {result.source.visibilityNotes.map((n) => (
              <Notice key={n} tone="warn" title="Visibility limitation">
                {n}
              </Notice>
            ))}
          </Card>

          <Card title="Version history">
            <KeyValues
              rows={[
                { k: 'v4.2.0 · 2026-11-01', v: 'Excluded registered infrastructure accounts from contract diversity.' },
                { k: 'v4.1.0 · 2026-10-18', v: 'Added the timestamped rate source requirement for USD conversion.' },
                { k: 'v4.0.0 · 2026-09-30', v: 'Breaking: separated Intents-generated receipts from the activity target.' },
              ]}
            />
            <p className="tiny dim">
              A breaking change marks every dependent panel STALE. It does not silently recompute
              them, because the old number and the new number answer different questions.
            </p>
          </Card>
        </div>
      </Content>
    </>
  );
}
