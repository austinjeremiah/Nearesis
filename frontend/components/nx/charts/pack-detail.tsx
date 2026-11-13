'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Content, PageHeader } from '../shell';
import { DataModeIndicator, MaturityChip } from '../evidence';
import { Button, Card, KeyValues, LinkButton, Notice } from '../ui';
import { TabStrip } from '../landing';
import { packFixture, packRows, SYNTHETIC_LABEL } from '@/lib/fixtures/pack';
import { conversionTargets, validateViz, type VizKindName } from '@/lib/viz/spec';
import { VizRender } from './viz';
import { PackProvenance } from './pack-panel';
import { exact } from './options';
import { formatUtc, shortHash } from '@/lib/format';

/**
 * Spec 5.8 — panel full view, for a panel drawn from the fixture pack.
 *
 * Same tab set as a measure-backed panel, read from the record instead of the
 * catalog. The Data tab is the honest one: it shows the rows exactly as the
 * envelope carries them, so an exact decimal stays a string and an unavailable
 * cell stays an em dash rather than becoming a zero on its way to the screen.
 */

type Tab = 'data' | 'query' | 'provenance' | 'evidence' | 'history' | 'display';

export function PackPanelDetail({
  wid,
  workspaceName,
  panelId,
  fixtureId,
}: {
  wid: string;
  workspaceName: string;
  panelId: string;
  fixtureId: string;
}) {
  const [tab, setTab] = useState<Tab>('data');
  const [kind, setKind] = useState<VizKindName | null>(null);
  const fixture = packFixture(fixtureId);

  if (!fixture) {
    return (
      <Content>
        <Notice tone="bad" title="Fixture not found">
          No record with id {fixtureId} exists in the pack.
        </Notice>
      </Content>
    );
  }

  const rows = packRows(fixture);
  const spec = kind ? { ...fixture.chartSpec, kind } : fixture.chartSpec;
  const verdict = validateViz(spec, fixture.result.columns, rows);
  const src = fixture.result.source;
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];

  return (
    <>
      <PageHeader
        title={fixture.title}
        description={fixture.chartSpec.description}
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: workspaceName, href: `/w/${wid}/overview` },
          { label: 'Canvas', href: `/w/${wid}/canvas` },
          { label: 'Panel' },
        ]}
        context={
          <>
            {/* The origin mark below already says synthetic; one is enough. */}
            <MaturityChip maturity={src.maturity} />
            <DataModeIndicator mode={src.dataMode} origin={src.datasetOrigin} watermark={src.sourceWatermark} />
          </>
        }
        actions={
          <>
            <LinkButton href={`/w/${wid}/canvas`}>Back to canvas</LinkButton>
            <Button disabled disabledReason="Export carries the synthetic label and needs the authorized API.">
              Export
            </Button>
          </>
        }
      />
      <Content>
        <Notice tone="bad" title={SYNTHETIC_LABEL}>
          This panel is drawn from a fabricated test record. Any export, screenshot or citation of
          it carries the same warning.
        </Notice>

        <Card>
          <VizRender
            spec={spec}
            columns={fixture.result.columns}
            rows={rows}
            height={360}
            ariaLabel={`${fixture.title}. ${fixture.disclaimer}`}
            onConvert={(k) => setKind(k)}
          />
        </Card>

        <TabStrip
          ariaLabel="Panel detail sections"
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
          <Card
            title={`${fixture.result.rowCount} rows`}
            subtitle="Values exactly as the result carries them. A decimal that arrived as a string is not reparsed."
          >
            <div className="table-wrap">
              <table className="table" data-density="compact">
                <thead>
                  <tr>
                    {keys.map((k) => {
                      const c = fixture.result.columns.find((cc) => cc.id === k);
                      return (
                        <th key={k}>
                          {k}
                          {c?.unit && <span className="tiny dim"> · {c.unit}</span>}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 120).map((r, i) => (
                    <tr key={i}>
                      {keys.map((k) => (
                        <td key={k} className="mono">
                          {r[k] === null || r[k] === undefined ? (
                            <span className="unavailable" title="Unavailable, not zero" />
                          ) : typeof r[k] === 'object' ? (
                            JSON.stringify(r[k]).slice(0, 60)
                          ) : (
                            exact(r[k])
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 120 && (
              <p className="tiny dim">
                First 120 of {rows.length} rows. The real API pages this by reference rather than
                shipping the whole series.
              </p>
            )}
          </Card>
        )}

        {tab === 'query' && (
          <Card title="Query">
            <KeyValues
              rows={[
                { k: 'Result id', v: <span className="mono">{fixture.result.resultId}</span> },
                {
                  k: 'Canonical query hash',
                  v: <span className="mono">{fixture.result.query.canonicalQueryHash}</span>,
                },
                { k: 'Semantic version', v: <span className="mono">{fixture.result.query.semanticVersion}</span> },
                { k: 'Snapshot', v: <span className="mono">{fixture.result.query.snapshotId}</span> },
                {
                  k: 'Measures',
                  v: fixture.result.query.metricIds.map((m) => (
                    <div key={m} className="mono">
                      {m}
                    </div>
                  )),
                },
                { k: 'Result hash', v: <span className="mono">{shortHash(fixture.result.resultHash, 10, 6)}</span> },
              ]}
            />
            <Notice tone={verdict.ok ? 'ok' : 'bad'} title={verdict.ok ? 'Specification validated' : 'Specification refused'}>
              {verdict.ok ? verdict.notes.join(' ') || 'Encodings, roles and units check out.' : verdict.reason}
            </Notice>
            <Button disabled disabledReason="Re-running produces a new result id and needs the authorized API.">
              Re-run query
            </Button>
          </Card>
        )}

        {tab === 'provenance' && (
          <Card title="Provenance">
            <PackProvenance fixture={fixture} />
          </Card>
        )}

        {tab === 'evidence' && (
          <Card title="Evidence links">
            <p className="small dim">
              No claim cites this panel. A synthetic record cannot become evidence for a thesis, so
              linking one is refused rather than offered.
            </p>
            <Link className="link small" href={`/w/${wid}/evidence`}>
              Open the evidence graph
            </Link>
          </Card>
        )}

        {tab === 'history' && (
          <Card title="Revisions">
            <KeyValues
              rows={[
                { k: 'Retrieved at', v: <span className="mono">{formatUtc(src.retrievedAt)}</span> },
                { k: 'Source watermark', v: <span className="mono">{formatUtc(src.sourceWatermark)}</span> },
                { k: 'Revisions', v: <span className="mono">1</span> },
              ]}
            />
            <p className="tiny dim">
              A frozen record has one revision by construction. Changing the source data would
              create a new snapshot rather than rewrite this one.
            </p>
          </Card>
        )}

        {tab === 'display' && (
          <Card title="Display" subtitle="Only conversions this result actually supports are offered.">
            <div className="col gap2">
              {conversionTargets(fixture.chartSpec, fixture.result.columns, rows).map((c) => (
                <div key={c.kind} className="row gap3 wrap" style={{ alignItems: 'center' }}>
                  <Button
                    onClick={() => setKind(c.kind)}
                    disabled={Boolean(c.blocked)}
                    disabledReason={c.blocked}
                  >
                    Draw as {c.label}
                  </Button>
                  {c.blocked && <span className="tiny dim">{c.blocked}</span>}
                </div>
              ))}
              {kind && (
                <Button onClick={() => setKind(null)}>Back to {fixture.chartSpec.kind}</Button>
              )}
            </div>
            <p className="tiny dim">
              Panel {panelId}. A conversion that the columns, grain or semantics do not support is
              refused with its reason rather than drawn badly.
            </p>
          </Card>
        )}
      </Content>
    </>
  );
}
