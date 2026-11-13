'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { MoreHorizontal } from 'lucide-react';
import { packFixture, packRows, SYNTHETIC_LABEL, type PackFixture } from '@/lib/fixtures/pack';
import { conversionTargets, validateViz, type VizKindName } from '@/lib/viz/spec';
import { Badge, DataModeIndicator, MaturityChip, PanelStatusChip } from '../evidence';
import { IconButton, KeyValues, Notice } from '../ui';
import { Menu } from '../overlays';
import { VizRender, StateLegend } from './viz';
import { formatUtc, shortHash } from '@/lib/format';

/**
 * A panel drawn from the synthetic fixture pack.
 *
 * Everything on screen comes from the record: the chart from its validated IR,
 * the header marks from its source envelope, the provenance from its hashes.
 * The synthetic label is not optional and is not a tooltip, because a reader
 * who screenshots this panel must carry the warning with them.
 */

const STATE_KINDS = new Set(['observed', 'partial', 'missing', 'unobservable', 'not_sampled', 'provider_error', 'zero_success']);

export function PackPanelFrame({
  fixtureId,
  panelId,
  workspaceId,
  height = 240,
  compactHeader,
  onSelectRange,
  onOpenProvenance,
}: {
  fixtureId: string;
  /** The canvas panel that holds this record, for the expand route. */
  panelId?: string;
  workspaceId: string;
  height?: number;
  compactHeader?: boolean;
  onSelectRange?: (r: { start: string; end: string }) => void;
  onOpenProvenance?: () => void;
}) {
  const fixture = packFixture(fixtureId);
  const [showProvenance, setShowProvenance] = useState(false);
  const [kindOverride, setKindOverride] = useState<VizKindName | null>(null);

  const spec = useMemo(() => {
    if (!fixture) return null;
    return kindOverride ? { ...fixture.chartSpec, kind: kindOverride } : fixture.chartSpec;
  }, [fixture, kindOverride]);

  if (!fixture || !spec) {
    return (
      <section className="card" aria-label="Unknown panel">
        <div className="card-body">
          <Notice tone="bad" title="Fixture not found">
            No record with id {fixtureId} exists in the pack. Nothing is drawn in its place.
          </Notice>
        </div>
      </section>
    );
  }

  const rows = packRows(fixture);
  const src = fixture.result.source;
  const verdict = validateViz(spec, fixture.result.columns, rows);
  const measures = fixture.result.columns.filter((c) => c.role === 'measure');
  const units = [...new Set(measures.map((m) => m.unit))];
  const statusValues = [
    ...new Set(rows.map((r) => String(r.status ?? '')).filter((s) => STATE_KINDS.has(s))),
  ];

  return (
    <section className="card panel" aria-label={fixture.title}>
      <header className="card-head">
        <div className="grow col gap1" style={{ minWidth: 0 }}>
          <div className="row gap2 wrap" style={{ minWidth: 0 }}>
            <span className="h3" style={{ fontSize: compactHeader ? 14 : undefined }}>
              {fixture.title}
            </span>
            <PanelStatusChip status={rows.length === 0 ? 'ready' : 'ready'} />
            <Badge tone="bad" title={fixture.disclaimer}>
              synthetic
            </Badge>
          </div>
          <div className="row gap2 wrap tiny dim">
            <span className="mono">{units.join(' · ') || fixture.kind}</span>
            <MaturityChip maturity={src.maturity} />
            <DataModeIndicator
              mode={src.dataMode}
              origin={src.datasetOrigin}
              watermark={src.sourceWatermark}
            />
            {fixture.result.partialReasonCodes.map((c) => (
              <Badge key={c} tone="warn" title="Reported by the result envelope">
                {c.replace(/_/g, ' ').toLowerCase()}
              </Badge>
            ))}
          </div>
        </div>
        <div className="actions">
          <Menu
            align="end"
            trigger={
              <IconButton label={`Panel actions for ${fixture.title}`}>
                <MoreHorizontal size={15} />
              </IconButton>
            }
            items={[
              { label: 'Expand', href: `/w/${workspaceId}/panels/${panelId ?? fixture.id}` },
              {
                label: showProvenance ? 'Hide provenance' : 'Inspect provenance',
                onSelect: () => {
                  setShowProvenance((v) => !v);
                  onOpenProvenance?.();
                },
              },
              { kind: 'separator' },
              ...conversionTargets(spec, fixture.result.columns, rows)
                .slice(0, 4)
                .map((c) => ({
                  label: `Change visualization: ${c.label}`,
                  disabledReason: c.blocked,
                  onSelect: c.blocked ? undefined : () => setKindOverride(c.kind),
                })),
              { kind: 'separator' },
              { label: 'Add marker', disabledReason: 'Select a range on the chart first.' },
              { label: 'Create monitor from selection', disabledReason: 'Monitors never run on synthetic fixtures.' },
              { label: 'Pin to overview', disabledReason: 'Pinning a synthetic panel to a thesis is refused.' },
              { kind: 'separator' },
              {
                label: 'Copy query hash',
                onSelect: () => navigator.clipboard?.writeText(fixture.result.query.canonicalQueryHash),
              },
              { label: 'Export data', disabledReason: 'Export carries provenance and needs the authorized API.' },
              { label: 'Archive panel', danger: true, disabledReason: 'Read-only until the API is connected.' },
            ]}
          />
        </div>
      </header>

      <div className="card-body" style={{ paddingTop: 8 }}>
        <VizRender
          spec={spec}
          columns={fixture.result.columns}
          rows={rows}
          height={height}
          ariaLabel={`${fixture.title}. ${fixture.disclaimer}`}
          onBrushEnd={onSelectRange}
          onConvert={(k) => setKindOverride(k)}
        />

        {statusValues.length > 0 && <StateLegend states={statusValues} />}

        {kindOverride && (
          <div className="row gap2 wrap tiny dim">
            <span>Drawn as {kindOverride} from the same result. No new query was run.</span>
            <button type="button" className="link small" onClick={() => setKindOverride(null)}>
              Back to {fixture.chartSpec.kind}
            </button>
          </div>
        )}

        {verdict.ok && verdict.notes.length > 0 && (
          <ul className="tiny dim col gap1" style={{ paddingLeft: 14, listStyle: 'disc' }}>
            {verdict.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        <span className="synthetic-stamp">{SYNTHETIC_LABEL}</span>

        {showProvenance && (
          <div style={{ borderTop: '1px dashed var(--line-strong)', paddingTop: 12 }}>
            <PackProvenance fixture={fixture} />
          </div>
        )}
      </div>
    </section>
  );
}

/** Everything a reader needs to check the record without trusting the chart. */
export function PackProvenance({ fixture }: { fixture: PackFixture }) {
  const r = fixture.result;
  const src = r.source;
  return (
    <div className="col gap4">
      <KeyValues
        rows={[
          { k: 'Fixture id', v: <span className="mono">{fixture.id}</span> },
          { k: 'Measures', v: r.query.metricIds.map((m) => <div key={m} className="mono">{m}</div>) },
          { k: 'Semantic version', v: <span className="mono">{r.query.semanticVersion}</span> },
          {
            k: 'Query hash',
            v: <span className="mono" title={r.query.canonicalQueryHash}>{shortHash(r.query.canonicalQueryHash)}</span>,
          },
          { k: 'Result hash', v: <span className="mono" title={r.resultHash}>{shortHash(r.resultHash)}</span> },
          { k: 'Rows reference', v: <span className="mono">{r.rowsRef}</span> },
          { k: 'Snapshot', v: <span className="mono">{src.snapshotId}</span> },
          {
            k: 'Raw manifest',
            v: <span className="mono" title={src.rawManifestHash}>{shortHash(src.rawManifestHash)}</span>,
          },
          { k: 'Rows', v: <span className="mono">{r.rowCount}</span> },
          {
            k: 'Coverage',
            v: (
              <span className="mono">
                {src.coverage.observed} of {src.coverage.expected} observed, {src.coverage.unknown} unknown
              </span>
            ),
          },
          { k: 'Gaps', v: src.coverage.gaps.length ? <span className="mono">{src.coverage.gaps.join(', ')}</span> : <span className="unavailable" /> },
          { k: 'Source watermark', v: <span className="mono">{formatUtc(src.sourceWatermark)}</span> },
          { k: 'Retrieved at', v: <span className="mono">{formatUtc(src.retrievedAt)}</span> },
        ]}
      />

      <div className="col gap2">
        <span className="label">Columns</span>
        <KeyValues
          rows={r.columns.map((c) => ({
            k: c.id,
            v: (
              <span className="small">
                {c.role} · <span className="mono">{c.unit}</span>
                {c.nullable ? ' · nullable' : ''}
              </span>
            ),
          }))}
        />
      </div>

      {Object.keys(fixture.expected ?? {}).length > 0 && (
        <div className="col gap2">
          <span className="label">Invariants this record asserts</span>
          <KeyValues
            rows={Object.entries(fixture.expected).map(([k, v]) => ({
              k: k.replace(/([A-Z])/g, ' $1').toLowerCase(),
              v: <span className="mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>,
            }))}
          />
        </div>
      )}

      <Notice tone="bad" title={SYNTHETIC_LABEL}>
        {src.visibilityNotes.join(' ')} This record is fabricated for interface testing. It is not a
        NEAR, NEAR Intents, 1Click or provider observation, and it must never be published as one.
      </Notice>

      <div className="row gap2 wrap">
        <Link className="link small" href="/data">
          Open measure catalog
        </Link>
      </div>
    </div>
  );
}
