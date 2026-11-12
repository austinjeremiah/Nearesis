'use client';

import { useCallback, useMemo, useState } from 'react';
import { Content, PageHeader } from '@/components/nx/shell';
import { Chart, baseOption, seriesPalette, type ChartTheme } from '@/components/nx/chart';
import { DataTable, type Column } from '@/components/nx/table';
import { Badge, DataModeIndicator } from '@/components/nx/evidence';
import { Card, Notice, Select } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { rng } from '@/lib/data/series';
import { formatPercent, formatUtc } from '@/lib/format';

/**
 * Spec 5.11 — Quote Observatory.
 *
 * "Sampled cross-chain route research, not swap execution." There is no Swap,
 * Deposit, Send or Execute control anywhere on this page, and every row is
 * labelled a dry quote. A route with no validated address reads Not sampled
 * rather than 0% available, because those are different facts.
 */
type Row = {
  id: string;
  fetchedAt: string;
  route: string;
  size: string;
  outcome: 'quoted' | 'no_quote' | 'timeout' | 'not_sampled';
  feeBps: number | null;
  requestHash: string;
};

const ROUTES = ['ETH→NEAR', 'SOL→NEAR', 'BTC→NEAR', 'USDC→NEAR', 'ARB→NEAR', 'BASE→NEAR'];
const SIZES = ['1k', '10k', '100k'];

function buildRows(): Row[] {
  // Deterministic, so the sampled table is identical on every render and on the
  // server. A quote sample that shuffles on reload cannot be cited.
  const r = rng(909);
  const out: Row[] = [];
  for (let i = 0; i < 48; i++) {
    const route = ROUTES[i % ROUTES.length];
    const size = SIZES[Math.floor(i / ROUTES.length) % SIZES.length];
    const roll = r();
    // BASE→NEAR has no validated recipient address in this snapshot, so it was
    // never sampled. That is not the same as being unavailable.
    const outcome: Row['outcome'] =
      route === 'BASE→NEAR' ? 'not_sampled' : roll > 0.88 ? 'no_quote' : roll > 0.84 ? 'timeout' : 'quoted';
    const hour = 23 - Math.floor(i / 2);
    out.push({
      id: `q${i}`,
      fetchedAt: `2026-11-09T${String(Math.max(0, hour)).padStart(2, '0')}:00:00.000Z`,
      route,
      size,
      outcome,
      feeBps: outcome === 'quoted' ? Number((6 + r() * 22).toFixed(1)) : null,
      requestHash: (0x1000000 + Math.floor(r() * 0xfffffff)).toString(16).slice(0, 8),
    });
  }
  return out;
}

export default function QuoteObservatoryPage() {
  const [route, setRoute] = useState('all');
  const [size, setSize] = useState('all');
  const all = useMemo(buildRows, []);

  const rows = useMemo(
    () =>
      all.filter((r) => (route === 'all' || r.route === route) && (size === 'all' || r.size === size)),
    [all, route, size],
  );

  const spread = useCallback(
    (t: ChartTheme) => {
      const base = baseOption(t);
      const pts = db.seriesFor('quotes.availability').slice(-60);
      return {
        ...base,
        yAxis: {
          ...(base.yAxis as object),
          max: 1,
          min: 0,
          axisLabel: {
            color: t.text3,
            fontFamily: t.mono,
            fontSize: 10,
            formatter: (v: number) => `${Math.round(v * 100)}%`,
          },
        },
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
    [],
  );

  const columns: Column<Row>[] = [
    { key: 'at', header: 'Fetched at (UTC)', render: (r) => <span className="small mono">{formatUtc(r.fetchedAt)}</span> },
    { key: 'route', header: 'Route', render: (r) => <span className="small mono">{r.route}</span> },
    { key: 'size', header: 'Size', numeric: true, render: (r) => <span className="small mono">{r.size}</span> },
    {
      key: 'outcome',
      header: 'Outcome',
      render: (r) =>
        r.outcome === 'quoted' ? (
          <Badge tone="ok">Quoted</Badge>
        ) : r.outcome === 'no_quote' ? (
          <Badge tone="warn">No quote</Badge>
        ) : r.outcome === 'timeout' ? (
          <Badge tone="bad">Timeout</Badge>
        ) : (
          <Badge outline title="No validated recipient address for this route in this snapshot.">
            Not sampled
          </Badge>
        ),
    },
    {
      key: 'fee',
      header: 'Implied fee (bps)',
      numeric: true,
      render: (r) => (r.feeBps === null ? <span className="unavailable" /> : <span className="small mono">{r.feeBps}</span>),
    },
    { key: 'hash', header: 'Request', render: (r) => <span className="small mono">{r.requestHash}</span> },
  ];

  const sampled = rows.filter((r) => r.outcome !== 'not_sampled');
  const quoted = rows.filter((r) => r.outcome === 'quoted');

  return (
    <>
      <PageHeader
        title="Quote observatory"
        description="Sampled dry quotes across cross-chain routes. No transaction is ever executed."
        crumbs={[{ label: 'Explore data', href: '/data' }, { label: 'Quote observatory' }]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
      />
      <Content>
        <Notice tone="warn" title="Dry quote, no transaction executed">
          These are hypothetical price and route observations sampled hourly. They are not executed
          swaps, not realized execution quality and not revenue. There is deliberately no action on
          this page that could send anything.
        </Notice>

        <div className="row gap3 wrap">
          <Select
            aria-label="Route"
            value={route}
            onChange={(e) => setRoute(e.target.value)}
            options={[{ value: 'all', label: 'All routes' }, ...ROUTES.map((r) => ({ value: r, label: r }))]}
          />
          <Select
            aria-label="Size"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            options={[{ value: 'all', label: 'All sizes' }, ...SIZES.map((s) => ({ value: s, label: s }))]}
          />
        </div>

        <div className="grid c3">
          <Card title="Sampled">
            <span className="num lg">{sampled.length}</span>
            <span className="tiny dim">
              of {rows.length} rows. {rows.length - sampled.length} routes were never sampled.
            </span>
          </Card>
          <Card title="Quote returned">
            <span className="num lg">
              {sampled.length ? formatPercent(quoted.length / sampled.length, 0) : '—'}
            </span>
            <span className="tiny dim">Share of sampled routes that returned a quote.</span>
          </Card>
          <Card title="Median implied fee">
            <span className="num lg">
              {quoted.length
                ? `${[...quoted.map((q) => q.feeBps!)].sort((a, b) => a - b)[Math.floor(quoted.length / 2)].toFixed(1)}`
                : '—'}
            </span>
            <span className="tiny dim">Basis points, from quotes only. Not a realized cost.</span>
          </Card>
        </div>

        <Card title="Availability over time" subtitle="Share of sampled routes returning a quote, by day.">
          <Chart option={spread} height={220} ariaLabel="Quote availability over the last 60 days" />
        </Card>

        <DataTable
          caption={`${rows.length} sampled quotes`}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          state={{ status: rows.length === 0 ? 'no_results' : 'ready' }}
        />
      </Content>
    </>
  );
}
