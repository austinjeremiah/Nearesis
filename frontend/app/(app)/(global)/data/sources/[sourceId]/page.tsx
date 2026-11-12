'use client';

import { use, useCallback } from 'react';
import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { Chart, baseOption, type ChartTheme } from '@/components/nx/chart';
import { Badge, CoverageChip, DataModeIndicator, SourceHealthChip } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, LinkButton, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatAge, formatUtc, shortHash } from '@/lib/format';

/**
 * Spec 5.10 — source detail.
 *
 * Coverage heatmap by day and hour, missing intervals, ingestion history and
 * the rate-limit state. Maintainer actions are listed but each states the limit
 * that blocks it: the spec is explicit that no UI control may bypass the
 * backend's rate limiter or the BigQuery byte ceiling.
 */
export default function SourceDetailPage({ params }: { params: Promise<{ sourceId: string }> }) {
  const { sourceId } = use(params);
  const s = db.source(sourceId);
  const meta = db.sourceFor(sourceId);

  const heatmap = useCallback(
    (t: ChartTheme) => {
      // Coverage by weekday and hour over the sampled window. Cells are a
      // ratio bounded to 0..1, so a sparse week cannot look complete.
      const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const avail = db.seriesFor('quotes.availability');
      const cells: [number, number, number][] = [];
      for (let d = 0; d < 7; d++) {
        for (let hour = 0; hour < 24; hour++) {
          const v = avail[(d * 24 + hour) % avail.length]?.[1];
          if (v !== null && v !== undefined) cells.push([hour, d, Number(v.toFixed(3))]);
        }
      }
      return {
        ...baseOption(t),
        grid: { left: 54, right: 16, top: 12, bottom: 54 },
        tooltip: { trigger: 'item', backgroundColor: '#2a2a2a', borderWidth: 0, textStyle: { color: '#f1efe2', fontSize: 12 } },
        xAxis: {
          type: 'category',
          data: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')),
          axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 9, interval: 2 },
          axisLine: { lineStyle: { color: t.lineStrong } },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'category',
          data: days,
          axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 10 },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
        },
        visualMap: {
          min: 0,
          max: 1,
          orient: 'horizontal',
          left: 54,
          bottom: 4,
          itemWidth: 10,
          itemHeight: 90,
          textStyle: { color: t.text3, fontSize: 10, fontFamily: t.mono },
          inRange: { color: [t.page, t.accent] },
        },
        series: [{ type: 'heatmap', data: cells, itemStyle: { borderColor: t.page, borderWidth: 1 } }],
      };
    },
    [],
  );

  if (!s) {
    return (
      <Content>
        <EmptyState
          title="Source not found"
          body="That source does not exist, or you do not have access to it."
          action={<LinkButton href="/data/sources">Back to sources</LinkButton>}
        />
      </Content>
    );
  }

  const dependentMetrics = db.metrics().filter((m) => m.sourceId === s.id);

  return (
    <>
      <PageHeader
        title={s.name}
        description={s.provider}
        crumbs={[
          { label: 'Explore data', href: '/data' },
          { label: 'Sources', href: '/data/sources' },
          { label: s.name },
        ]}
        context={
          <>
            <SourceHealthChip health={s.health} />
            <DataModeIndicator mode="frozen" origin="fixture" watermark={s.watermark} />
          </>
        }
      />
      <Content>
        {s.error && (
          <Notice tone="bad" title={`Ingestion failing: ${s.error.code}`}>
            <div className="col gap1">
              <span>{s.error.message}</span>
              <span className="tiny mono dim">First seen {formatUtc(s.error.firstSeen)}</span>
            </div>
          </Notice>
        )}
        {s.note && <Notice tone="info" title="Provider note">{s.note}</Notice>}

        <div className="grid c3">
          <Card title="State">
            <KeyValues
              rows={[
                { k: 'Health', v: <SourceHealthChip health={s.health} /> },
                { k: 'Last finalized', v: <span className="mono">{formatUtc(s.watermark)}</span> },
                { k: 'Age', v: <span className="mono">{formatAge(s.watermark)}</span> },
                { k: 'Checked', v: <span className="mono">{formatAge(s.checkedAt)}</span> },
                { k: 'Rate limit', v: s.rateLimit },
              ]}
            />
          </Card>
          <Card title="Coverage">
            <KeyValues
              rows={[
                {
                  k: 'Window',
                  v: s.coveragePct !== null ? <CoverageChip coverage={meta.coverage} /> : <Badge outline>Not sampled</Badge>,
                },
                { k: 'Observed', v: <span className="mono">{meta.coverage.observed}</span> },
                { k: 'Unknown', v: <span className="mono">{meta.coverage.unknown}</span> },
                {
                  k: 'Gaps',
                  v: meta.coverage.gaps.length ? (
                    <span className="mono small">{meta.coverage.gaps.join(', ')}</span>
                  ) : (
                    <span className="unavailable" />
                  ),
                },
              ]}
            />
          </Card>
          <Card title="Integrity">
            <KeyValues
              rows={[
                { k: 'Snapshot', v: <span className="mono">{meta.snapshotId}</span> },
                { k: 'Raw manifest', v: <span className="mono">{shortHash(meta.rawManifestHash)}</span> },
                { k: 'Archive path', v: <span className="small dim">Permissioned. Not shown on fixture data.</span> },
                { k: 'Normalizer', v: <Badge tone="ok">Up to date</Badge> },
              ]}
            />
          </Card>
        </div>

        <Card title="Coverage by weekday and hour" subtitle="Blank cells are intervals with no observation, not zeros.">
          <Chart option={heatmap} height={240} ariaLabel={`Coverage heatmap for ${s.name}`} />
        </Card>

        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Measures from this source">
            {dependentMetrics.length === 0 ? (
              <EmptyState title="No measures depend on this source" />
            ) : (
              <KeyValues
                rows={dependentMetrics.map((m) => ({
                  k: m.name,
                  v: (
                    <Link className="link mono small" href={`/data/metrics/${m.id}`}>
                      {m.id}
                    </Link>
                  ),
                }))}
              />
            )}
          </Card>

          <Card title="Maintainer actions" subtitle="Every one of these is enforced on the server.">
            <div className="col gap2">
              <Button block disabled disabledReason="Needs the data maintainer role and the authorized API.">
                Retry failed window
              </Button>
              <Button block disabled disabledReason="Needs the data maintainer role and the authorized API.">
                Resume backfill
              </Button>
              <Button block disabled disabledReason="Needs the data maintainer role and the authorized API.">
                Pause source
              </Button>
              <Button block disabled disabledReason="Needs the data maintainer role and the authorized API.">
                Check credentials
              </Button>
            </div>
            <Notice tone="info" title="What these cannot do">
              No control here bypasses the backend rate limiter or the BigQuery byte ceiling, and
              checking credentials returns a status, never the secret itself.
            </Notice>
          </Card>
        </div>
      </Content>
    </>
  );
}
