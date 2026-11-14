'use client';

import { useState } from 'react';
import { Badge } from '@/components/nx/evidence';
import { DataTable, type Column } from '@/components/nx/table';
import { Card, Input, KeyValues, Notice, Tabs } from '@/components/nx/ui';
import { ApiCard, WindowControl, useWindow, useApiGet } from './kit';
import { ApiErrorState } from '@/components/nx/states';
import { SeriesChart } from './charts';
import { fInt, fPct, fPctPoints, toNum } from '@/lib/data/num';

type Verification = 'verified' | 'inferred' | 'unverified' | string;
const vTone = (v: Verification) => (v === 'verified' ? 'ok' : v === 'inferred' ? 'info' : 'warn');
const VerificationBadge = ({ v }: { v: Verification }) => (
  <Badge tone={vTone(v)} title={v === 'verified' ? 'Confirmed by an on-chain or official source' : v === 'inferred' ? 'Inferred from an account-hierarchy or naming rule' : 'Not verified; not counted in named entities'}>
    {v}
  </Badge>
);

type Entity = { entityId: string; entityType: string; name: string; categoryId: string | null; parentEntityId: string | null; description: string; mappingCount: number };
type Cov = {
  totalInteractions: number; classifiedInteractions: number; verifiedInteractions: number; inferredInteractions: number; unverifiedInteractions: number;
  unclassifiedListedInteractions: number; belowThresholdInteractions: number; classifiedShare: number; verifiedShare: number; inferredShare: number; unverifiedShare: number;
  unclassifiedShare: number; belowThresholdShare: number; daysExpected: number; daysWithReceiverData: number; missingDays: string[];
};
type Mapping = { mappingId: string; matchType: string; account: string; role: string; effectiveFrom: string | null; effectiveTo: string | null; verification: string; confidence: string; evidenceKind: string; evidenceUrl: string | null; evidenceNote: string | null; methodology: string; limitations: string | null };

function EvidenceLink({ url }: { url: string | null }) {
  if (!url) return <span className="dim">no link</span>;
  return (
    <a className="link small" href={url} target="_blank" rel="noopener noreferrer">
      evidence
    </a>
  );
}

function EntityDetail({ id, days }: { id: string; days: number }) {
  const range = (() => {
    const to = new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10);
    const from = new Date(Date.now() - 86400000 * (days + 1)).toISOString().slice(0, 10);
    return { from, to };
  })();
  return (
    <div className="col gap3" data-testid="entity-detail">
      <ApiCard<{ entity: Entity; category: Entity | null; parent: Entity | null; children: Entity[]; relations: { relationId: string; fromEntityId: string; toEntityId: string; relation: string; verification: string; evidenceUrl: string | null; note: string }[]; mappings: Mapping[]; registryVersion: string }>
        id="entity" title="Entity" path={`/v1/entities/${encodeURIComponent(id)}`}
      >
        {(d) => (
          <div className="col gap3">
            <KeyValues
              rows={[
                { k: 'Name', v: d.entity.name },
                { k: 'Type', v: <Badge outline>{d.entity.entityType}</Badge> },
                { k: 'Category', v: d.category?.name ?? '—' },
                { k: 'Registry', v: <span className="mono">{d.registryVersion}</span> },
                { k: 'Description', v: d.entity.description },
              ]}
            />
            <DataTable<Mapping>
              caption="Account mappings with evidence"
              rows={d.mappings}
              rowKey={(m) => m.mappingId}
              columns={[
                { key: 'a', header: 'Account', render: (m) => <span className="mono">{m.account}</span> },
                { key: 't', header: 'Match', render: (m) => m.matchType },
                { key: 'v', header: 'Label', render: (m) => <VerificationBadge v={m.verification} /> },
                { key: 'c', header: 'Confidence', render: (m) => m.confidence },
                { key: 'k', header: 'Evidence kind', render: (m) => <span className="small">{m.evidenceKind}</span> },
                { key: 'e', header: 'Evidence', render: (m) => <EvidenceLink url={m.evidenceUrl} /> },
                { key: 'n', header: 'Note and limits', render: (m) => <span className="small dim">{m.evidenceNote} {m.limitations}</span> },
              ]}
            />
            {d.relations.length > 0 && (
              <DataTable
                caption="Relations"
                rows={d.relations}
                rowKey={(r) => r.relationId}
                columns={[
                  { key: 'r', header: 'Relation', render: (r) => <span className="mono small">{r.fromEntityId} {r.relation.replace(/_/g, ' ')} {r.toEntityId}</span> },
                  { key: 'v', header: 'Label', render: (r) => <VerificationBadge v={r.verification} /> },
                  { key: 'e', header: 'Evidence', render: (r) => <EvidenceLink url={r.evidenceUrl} /> },
                  { key: 'n', header: 'Note', render: (r) => <span className="small dim">{r.note}</span> },
                ]}
              />
            )}
          </div>
        )}
      </ApiCard>
      <ApiCard<{ state: string; basis: { unit: string; attribution: string; notAdditive: string }; coverage: { requestedDays: number; daysWithData: number; missingDays: string[] }; daily: { date: string; signers: number; transactions: number }[]; summary: { averageDailySigners: number; peakDailySigners: number; windowDistinctSigners: { state: string; message: string; lowerBound: number; upperBound: number } }; caveats: string[]; reasonCode?: string; message?: string }>
        id="signers" title="Unique signers per day" path={`/v1/entities/${encodeURIComponent(id)}/unique-users`} query={range}
        caveats={(d) => d.caveats}
      >
        {(d) =>
          d.state !== 'COMPUTED' ? (
            <Notice tone="info" title="Cannot compute">
              {d.message ?? 'The source cannot support unique users for this entity.'} {d.reasonCode}
            </Notice>
          ) : (
            <div className="col gap2">
              <p className="small">{d.basis.unit}. {d.basis.notAdditive}</p>
              <SeriesChart ariaLabel="Daily unique signers" unit="signer accounts" series={[{ name: 'signers', points: d.daily.map((x) => ({ x: x.date, y: x.signers })) }]} />
              <p className="small" data-testid="window-distinct">
                Average {toNum(d.summary.averageDailySigners)?.toFixed(1)} per day, peak {fInt(d.summary.peakDailySigners)}. Window-level distinct signers: cannot compute exactly ({d.summary.windowDistinctSigners.state}); bounds {fInt(d.summary.windowDistinctSigners.lowerBound)} to {fInt(d.summary.windowDistinctSigners.upperBound)}.
              </p>
              <p className="small dim">Coverage: {d.coverage.daysWithData} of {d.coverage.requestedDays} days{d.coverage.missingDays.length ? `, missing ${d.coverage.missingDays.join(', ')}` : ''}.</p>
            </div>
          )
        }
      </ApiCard>
    </div>
  );
}

export default function EcosystemView() {
  const { days, setDays } = useWindow(90);
  const [tab, setTab] = useState<'registry' | 'coverage' | 'changes'>('registry');
  const [sel, setSel] = useState<string | null>(null);
  const [text, setText] = useState('');
  const list = useApiGet<{ registryVersion: string; entities: Entity[] }>('/v1/entities', { limit: 100, q: text || undefined });
  const eCols: Column<Entity>[] = [
    { key: 'n', header: 'Entity', render: (e) => <button type="button" className="link strong" onClick={() => setSel(e.entityId)}>{e.name}</button> },
    { key: 'id', header: 'Id', render: (e) => <span className="mono small">{e.entityId}</span> },
    { key: 't', header: 'Type', render: (e) => <Badge outline>{e.entityType}</Badge> },
    { key: 'm', header: 'Mappings', numeric: true, render: (e) => e.mappingCount },
  ];
  return (
    <div className="col gap3" data-testid="ecosystem-view">
      <div className="row gap3" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Tabs ariaLabel="Ecosystem" value={tab} options={[{ value: 'registry', label: 'Registry' }, { value: 'coverage', label: 'Coverage' }, { value: 'changes', label: 'Changes' }]} onChange={(t) => { setTab(t); setSel(null); }} />
        {tab !== 'registry' && <WindowControl days={days} onChange={setDays} options={[30, 90]} />}
      </div>

      {tab === 'registry' && !sel && (
        <>
          <ApiCard<{ registryVersion: string; counts: { entities: number; mappings: number; relations: number }; entityTypes: Record<string, number>; mappingVerification: Record<string, number>; rules: { ruleId?: string; description?: string }[] }> id="registry" title="Registry snapshot" path="/v1/entities/registry">
            {(d) => (
              <div className="col gap2">
                <KeyValues
                  rows={[
                    { k: 'Registry version', v: <span className="mono">{d.registryVersion}</span> },
                    { k: 'Entities / mappings / relations', v: <span className="mono">{d.counts.entities} / {d.counts.mappings} / {d.counts.relations}</span> },
                    { k: 'Mapping labels', v: <span className="row gap1"><Badge tone="ok">{d.mappingVerification.verified ?? 0} verified</Badge><Badge tone="info">{d.mappingVerification.inferred ?? 0} inferred</Badge><Badge tone="warn">{d.mappingVerification.unverified ?? 0} unverified</Badge></span> },
                    { k: 'Types', v: <span className="small">{Object.entries(d.entityTypes).map(([k, v]) => `${k} ${v}`).join(' | ')}</span> },
                  ]}
                />
                <p className="small dim">Verified means confirmed by an on-chain or official source. Inferred means an account-hierarchy or naming rule. Unverified mappings are never counted inside named entities.</p>
              </div>
            )}
          </ApiCard>
          <Card title="Entities" actions={<Input aria-label="Search entities" placeholder="Search" value={text} onChange={(e) => setText(e.target.value)} />}>
            {list.isPending ? <p className="small dim">Loading</p> : list.isError ? <ApiErrorState error={list.error} onRetry={() => list.refetch()} /> : (
              <DataTable<Entity> caption="Registry entities" rows={list.data.entities} rowKey={(e) => e.entityId} columns={eCols} state={list.data.entities.length ? { status: 'ready' } : { status: 'no_results' }} />
            )}
          </Card>
        </>
      )}
      {tab === 'registry' && sel && (
        <>
          <div><button type="button" className="link small" onClick={() => setSel(null)}>Back to registry</button></div>
          <EntityDetail id={sel} days={Math.min(days, 90)} />
        </>
      )}

      {tab === 'coverage' && (
        <ApiCard<{ registryVersion: string; window: { from: string; to: string; days: number }; coverage: Cov; topUnclassifiedReceivers: { receiver: string; interactions: number }[] }> id="eco-coverage" title="Classified versus unclassified activity" path="/v1/entities/coverage" query={{ days }}>
          {(d) => (
            <div className="col gap3">
              <p className="small">Interactions are function-call receipts per contract-day, not unique users. Window {d.window.from} to {d.window.to} ({d.window.days} days), registry {d.registryVersion}.</p>
              <KeyValues
                rows={[
                  { k: 'Total interactions', v: <span className="mono">{fInt(d.coverage.totalInteractions)}</span> },
                  { k: 'Classified', v: <span className="mono" data-testid="classified-share">{fPct(d.coverage.classifiedShare)} ({fInt(d.coverage.classifiedInteractions)})</span> },
                  { k: 'of which verified', v: <span className="mono">{fPct(d.coverage.verifiedShare)}</span> },
                  { k: 'of which inferred', v: <span className="mono">{fPct(d.coverage.inferredShare)}</span> },
                  { k: 'Unverified (not in named entities)', v: <span className="mono">{fPct(d.coverage.unverifiedShare, 3)}</span> },
                  { k: 'Unclassified (listed receivers)', v: <span className="mono">{fPct(d.coverage.unclassifiedShare)}</span> },
                  { k: 'Below the 100/day threshold', v: <span className="mono">{fPct(d.coverage.belowThresholdShare)} (always unclassified)</span> },
                  { k: 'Days with receiver data', v: <span className="mono">{d.coverage.daysWithReceiverData} of {d.coverage.daysExpected}{d.coverage.missingDays.length ? `, missing ${d.coverage.missingDays.join(', ')}` : ''}</span> },
                ]}
              />
              <DataTable<{ receiver: string; interactions: number }> caption="Top unclassified receivers" rows={d.topUnclassifiedReceivers} rowKey={(r) => r.receiver} columns={[
                { key: 'r', header: 'Receiver', render: (r) => <span className="mono">{r.receiver}</span> },
                { key: 'i', header: 'Interactions', numeric: true, render: (r) => fInt(r.interactions) },
              ]} />
            </div>
          )}
        </ApiCard>
      )}

      {tab === 'changes' && (
        <ApiCard<{
          current: { from: string; to: string }; prior: { from: string; to: string };
          totals: { current: number; prior: number; change: number; changePct: number | null; classifiedChange: number; unclassifiedChange: number };
          entities: { entityId: string; name: string; entityType: string; current: { interactions: number; verifiedInteractions: number; inferredInteractions: number }; prior: { interactions: number }; change: number; changePct: number | null; shareOfGrowth: number; inferredShareOfEntity: number; uniqueSigners: { current: number; previous: number; complete: boolean } }[];
          unattributedGrowth: { receiver: string; state: string; current: number; prior: number; change: number }[];
          notes: string[]; attribution: string;
        }> id="changes" title="Largest changes versus the prior window" path="/v1/entities/changes" query={{ days, limit: 20 }} caveats={(d) => d.notes}>
          {(d) => (
            <div className="col gap3">
              <p className="small" data-testid="unattributed-note">
                Window {d.current.from} to {d.current.to} against {d.prior.from} to {d.prior.to}. Total change {fInt(d.totals.change)} ({d.totals.changePct === null ? '—' : fPctPoints(d.totals.changePct * 100)}): classified {fInt(d.totals.classifiedChange)}, <strong>unattributed {fInt(d.totals.unclassifiedChange)}</strong>.
              </p>
              <p className="small dim">{d.attribution}</p>
              <DataTable caption="Entities by change in interactions" rows={d.entities} rowKey={(e) => e.entityId} columns={[
                { key: 'n', header: 'Entity', render: (e) => <button type="button" className="link strong" onClick={() => { setTab('registry'); setSel(e.entityId); }}>{e.name}</button> },
                { key: 'c', header: 'Interactions', numeric: true, render: (e) => fInt(e.current.interactions) },
                { key: 'p', header: 'Prior', numeric: true, render: (e) => fInt(e.prior.interactions) },
                { key: 'ch', header: 'Change', numeric: true, render: (e) => `${e.change > 0 ? '+' : ''}${fInt(e.change)}` },
                { key: 'pc', header: 'Change %', numeric: true, render: (e) => (e.changePct === null ? 'new (no prior)' : fPctPoints(e.changePct)) },
                { key: 'sg', header: 'Share of growth', numeric: true, render: (e) => fPct(e.shareOfGrowth) },
                { key: 'inf', header: 'Inferred share', numeric: true, render: (e) => fPct(e.inferredShareOfEntity, 0) },
                { key: 'u', header: 'Signers/day', numeric: true, render: (e) => (e.uniqueSigners.complete ? `${fInt(e.uniqueSigners.current)} (prior ${fInt(e.uniqueSigners.previous)})` : 'incomplete') },
              ]} />
              <DataTable caption="Unattributed growth: receivers with no registry entity" rows={d.unattributedGrowth} rowKey={(r) => r.receiver} columns={[
                { key: 'r', header: 'Receiver', render: (r) => <span className="mono">{r.receiver}</span> },
                { key: 's', header: 'State', render: (r) => <Badge tone="warn">{r.state}</Badge> },
                { key: 'c', header: 'Current', numeric: true, render: (r) => fInt(r.current) },
                { key: 'p', header: 'Prior', numeric: true, render: (r) => fInt(r.prior) },
                { key: 'd', header: 'Change', numeric: true, render: (r) => `+${fInt(r.change)}` },
              ]} />
            </div>
          )}
        </ApiCard>
      )}
    </div>
  );
}
