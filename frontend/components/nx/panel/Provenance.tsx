'use client';

import { useState } from 'react';
import { Badge } from '@/components/nx/evidence';
import { Button, KeyValues } from '@/components/nx/ui';
import { formatUtc } from '@/lib/format';
import { CERT_LABEL, certificationOf, coverageInfo, dateRuns, freshnessInfo, truncationInfo, truncationLabel } from '@/lib/panel/model';
import type { CanvasPanel, PanelData } from '@/lib/panel/types';

export function CopyHash({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="row gap2" style={{ flexWrap: 'wrap' }}>
      <span className="nxp-hash" data-testid={`hash-${label}`}>{value}</span>
      <Button
        size={undefined}
        variant="ghost"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          } catch {
            /* clipboard unavailable: the value is selectable text */
          }
        }}
      >
        {done ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

const RUN_LIMIT = 40;
function DayRuns({ days }: { days: string[] }) {
  const runs = dateRuns(days);
  if (!days.length) return <span className="dim">none</span>;
  const shown = runs.slice(0, RUN_LIMIT);
  return (
    <span className="nxp-cov-list">
      {shown.map(([a, z]) => (a === z ? a : `${a} to ${z}`)).join(', ')}
      {runs.length > RUN_LIMIT ? `, and ${runs.length - RUN_LIMIT} more runs` : ''} ({days.length} day{days.length === 1 ? '' : 's'})
    </span>
  );
}

/** Coverage, gaps and caveats. Missing periods are unknown, never zero. */
export function CoverageBlock({ data }: { data: PanelData }) {
  const cov = coverageInfo(data);
  const trunc = truncationInfo(data);
  return (
    <div className="col gap2" data-testid="coverage-block">
      <KeyValues
        rows={[
          { k: 'Coverage', v: <Badge tone={cov.state === 'complete' ? 'ok' : 'warn'}>{cov.state}</Badge> },
          ...(cov.daysRequested !== null ? [{ k: 'Days with data', v: `${cov.daysWithData ?? '?'} of ${cov.daysRequested}` }] : []),
          { k: 'No coverage record (unknown, not zero)', v: <DayRuns days={cov.missing} /> },
          { k: 'Incomplete (counts are lower bounds)', v: <DayRuns days={cov.incomplete} /> },
          ...(trunc ? [{ k: 'Truncation', v: truncationLabel(trunc) }] : []),
        ]}
      />
      {cov.note && <div className="small dim">{cov.note}</div>}
      {data.gaps.length > 0 && (
        <div>
          <div className="label">Gaps reported by the source</div>
          <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {data.gaps.slice(0, 20).map((g, i) => (
              <li key={i}>
                <span className="mono">{g.from === g.to ? g.from : `${g.from} to ${g.to}`}</span> {g.reason}
              </li>
            ))}
            {data.gaps.length > 20 && <li>and {data.gaps.length - 20} more</li>}
          </ul>
        </div>
      )}
      {data.caveats.length > 0 && (
        <div>
          <div className="label">Caveats</div>
          <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {data.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Query tab: what was asked, exactly. */
export function QueryBlock({ panel, data }: { panel: CanvasPanel; data: PanelData }) {
  const p = data.provenance;
  return (
    <div className="col gap3" data-testid="query-block">
      <KeyValues
        rows={[
          { k: 'Query hash', v: <CopyHash value={data.queryHash} label="query-hash" /> },
          { k: 'Engine', v: data.kind === 'analytics' ? 'Analytics capability call' : 'Semantic layer (guarded gateway)' },
          ...(panel.queryRef ? [{ k: 'Panel binding', v: <span className="nxp-hash">{panel.queryRef.hash}</span> }] : []),
          { k: 'Snapshot policy', v: panel.queryRef?.snapshotPolicy ?? 'live' },
        ]}
      />
      <div>
        <div className="label">{data.kind === 'analytics' ? 'Call' : 'Query AST'}</div>
        <pre className="nxp-pre">{JSON.stringify(p?.ast ?? null, null, 2)}</pre>
      </div>
      {panel.encoding && (
        <div>
          <div className="label">Encoding</div>
          <pre className="nxp-pre">{JSON.stringify(panel.encoding, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

/** Provenance tab: query hash, metric version, source, snapshot, watermark, result hash, certification. */
export function ProvenanceBlock({ panel, data }: { panel: CanvasPanel; data: PanelData }) {
  const p = data.provenance;
  const cert = certificationOf(panel, data);
  const fr = freshnessInfo(data);
  const a = panel.analytics;
  const w = data.chart?.sourceWatermark ?? data.freshness.sourceWatermark;
  return (
    <div className="col gap3" data-testid="provenance-block">
      <div className="row gap2">
        <Badge tone={cert === 'certified' ? 'ok' : cert === 'analytics' ? 'info' : 'warn'}>{p?.sourceLabel ?? 'unknown source'}</Badge>
        <span className="nxp-cert" data-testid="cert-label">{CERT_LABEL[cert]}</span>
      </div>
      <KeyValues
        rows={[
          { k: 'Query hash', v: <CopyHash value={data.queryHash} label="query-hash-prov" /> },
          { k: 'Result hash', v: p ? <CopyHash value={p.resultHash} label="result-hash" /> : 'not available' },
          { k: 'Metric version', v: p?.semanticVersion ?? 'not available' },
          { k: 'Semantic model', v: p ? <span className="nxp-hash">{p.semanticModelHash}</span> : 'not available' },
          { k: 'Sources', v: p?.sources.length ? p.sources.join(', ') : 'not recorded' },
          { k: 'Snapshot', v: p?.sourceSnapshotId ?? 'none pinned: live read' },
          { k: 'Source watermark', v: w ? formatUtc(w) : 'unknown' },
          { k: 'Generated', v: data.freshness.generatedAt ? formatUtc(data.freshness.generatedAt) : 'unknown' },
          { k: 'Freshness', v: <Badge tone={fr.tone}>{fr.label}</Badge> },
          ...(data.rollupFreshness ? [{ k: 'Rollup', v: `${data.rollupFreshness.state}${data.rollupFreshness.lagSeconds !== null ? `, lag ${data.rollupFreshness.lagSeconds}s` : ''}` }] : []),
          ...(data.cost ? [{ k: 'Cost', v: `${data.cost.bytesEstimated.toLocaleString('en-US')} bytes estimated, ${data.cost.bytesBilled.toLocaleString('en-US')} billed` }] : []),
          ...(a ? [{ k: 'Capability', v: `${a.capability} (${a.analysis})` }, { k: 'Source tables', v: a.sourceTables.join(', ') }] : []),
          ...(data.metricStatus ? [{ k: 'Metric status', v: data.metricStatus }] : []),
        ]}
      />
      {data.freshness.sourceWatermarks && Object.keys(data.freshness.sourceWatermarks).length > 1 && (
        <KeyValues rows={Object.entries(data.freshness.sourceWatermarks).map(([k, v]) => ({ k: `Watermark: ${k}`, v: formatUtc(String(v)) }))} />
      )}
      <CoverageBlock data={data} />
    </div>
  );
}
