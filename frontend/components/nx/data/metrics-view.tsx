'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/nx/evidence';
import { DataTable } from '@/components/nx/table';
import { Button, Card, EmptyState, Field, Input, KeyValues, Notice, Segmented, Skeleton, Textarea } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { browserApi } from '@/lib/api/browser';
import { ApiRequestError } from '@/lib/api/errors';
import { formatUtc } from '@/lib/format';
import { ApiCard, useApiGet } from './kit';
import { SeriesChart } from './charts';

export type MetricRow = {
  metricKey: string; source: 'registry' | 'authored' | string; status: 'CERTIFIED' | 'VALIDATED' | 'DRAFT' | 'DEPRECATED' | string;
  version: string | number; displayName: string; unit: string; exploratory: boolean; authoredIn?: string[];
};
type Me = { subject: string; role: string | null; permissions?: { canWrite: boolean; canAdmin: boolean } };

export const statusTone = (s: string) => (s === 'CERTIFIED' ? 'ok' : s === 'VALIDATED' ? 'info' : s === 'DEPRECATED' ? 'bad' : 'warn');

export function StatusBadge({ status, exploratory }: { status: string; exploratory?: boolean }) {
  return (
    <span className="row gap1">
      <Badge tone={statusTone(status)}>{status.toLowerCase()}</Badge>
      {(exploratory || status !== 'CERTIFIED') && <Badge outline tone="warn" title="Not certified: cannot back a published claim">exploratory</Badge>}
    </span>
  );
}

function useMe() {
  return useQuery({ queryKey: ['me-data'], queryFn: async () => (await fetch('/api/me', { cache: 'no-store' })).json() as Promise<Me> });
}

function errText(e: unknown): string {
  if (e instanceof ApiRequestError) return `${e.message}${e.reasonCode ? ` (${e.reasonCode})` : ''}`;
  return e instanceof Error ? e.message : 'Request failed';
}

/* ------------------------------------------------------------------ catalogue */

export function MetricCatalogue() {
  const q = useApiGet<{ metrics: MetricRow[]; counts?: Record<string, number>; truncated?: boolean; workspaceCount?: number }>('/v1/metrics');
  const [src, setSrc] = useState<'all' | 'registry' | 'authored'>('all');
  const [status, setStatus] = useState('all');
  const rows = useMemo(
    () => (q.data?.metrics ?? []).filter((m) => (src === 'all' || m.source === src) && (status === 'all' || m.status === status)),
    [q.data, src, status],
  );
  return (
    <div className="col gap3" data-testid="metric-catalogue">
      <Card
        title="Metric catalogue"
        subtitle="Platform registry metrics and metrics authored in your workspaces. Anything not certified is exploratory."
        actions={
          <div className="row gap2">
            <Segmented ariaLabel="Source" value={src} onChange={setSrc} options={[{ value: 'all', label: 'All' }, { value: 'registry', label: 'Registry' }, { value: 'authored', label: 'Authored' }]} />
            <select className="select" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">Any status</option>
              {['CERTIFIED', 'VALIDATED', 'DRAFT', 'DEPRECATED'].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
            </select>
          </div>
        }
      >
        {q.isPending ? <Skeleton rows={5} /> : q.isError ? <ApiErrorState error={q.error} onRetry={() => q.refetch()} /> : (
          <>
            {q.data.truncated && <Notice tone="warn" title="Truncated">The catalogue is longer than the response limit. Filter to narrow it.</Notice>}
            <DataTable<MetricRow>
              caption={`${rows.length} metrics`}
              rows={rows}
              rowKey={(m) => `${m.metricKey}@${m.version}`}
              state={rows.length ? { status: 'ready' } : { status: 'no_results' }}
              columns={[
                { key: 'k', header: 'Metric', render: (m) => <Link className="link strong" href={`/data/metrics/${encodeURIComponent(m.metricKey)}${m.authoredIn?.[0] ? `?w=${m.authoredIn[0]}` : ''}`}>{m.displayName}</Link> },
                { key: 'id', header: 'Key', render: (m) => <span className="mono small">{m.metricKey}</span> },
                { key: 's', header: 'Status', render: (m) => <StatusBadge status={m.status} exploratory={m.exploratory} /> },
                { key: 'v', header: 'Version', numeric: true, render: (m) => <span className="mono">{m.version}</span> },
                { key: 'u', header: 'Unit', render: (m) => <span className="mono small">{m.unit}</span> },
                { key: 'o', header: 'Origin', render: (m) => <Badge outline>{m.source}</Badge> },
              ]}
            />
            {q.data.counts && <p className="small dim">Counts: {Object.entries(q.data.counts).map(([k, v]) => `${k} ${v}`).join(' | ')}</p>}
          </>
        )}
      </Card>
      <ProposeMetric />
    </div>
  );
}

/* ------------------------------------------------------------------ propose */

const TIME_COLUMNS: Record<string, string> = {
  near_daily_tx: 'block_date', account_daily_activity: 'block_date', contract_interactions: 'block_date',
  near_economics_outcomes_daily: 'block_date', near_economics_conversion_daily: 'block_date', near_economics_gas_price_daily: 'block_date',
};

function ProposeMetric() {
  const me = useMe();
  const ws = useApiGet<{ workspaces: { id: string; objective: string }[] }>('/v1/workspaces');
  const qc = useQueryClient();
  const [wid, setWid] = useState('');
  const [f, setF] = useState({ name: '', displayName: '', description: '', unit: 'tx', table: 'near_daily_tx', column: 'tx_count', fn: 'sum', limitation: '' });
  const [json, setJson] = useState('');
  const [validate, setValidate] = useState(true);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const build = () => {
    const principalId = me.data?.subject ?? '';
    return {
      schemaVersion: 1, namespace: 'authored', name: f.name, displayName: f.displayName, description: f.description,
      sources: [f.table], joins: [], entityGrain: { kind: 'global' },
      timeGrain: { column: { table: f.table, column: TIME_COLUMNS[f.table] ?? 'block_date' }, grain: 'day' },
      dimensions: [], filters: [],
      aggregations: [{ id: f.fn === 'count' ? 'n' : 'v', fn: f.fn, column: f.fn === 'count' ? null : { table: f.table, column: f.column } }],
      unit: f.unit, precision: { decimals: 0, rounding: 'half_even' }, nullSemantics: { nullInput: 'ignore', emptyBucket: 'null' },
      dedup: { strategy: 'final' }, historicalValidity: { validFrom: '2025-11-10', validTo: null, restatement: 'may_restate' },
      costEstimate: { maxEstimatedRows: 100000 }, dependencies: [],
      tests: [{ kind: 'reconcile_raw', name: 'matches raw' }, { kind: 'non_negative', name: 'no negatives' }],
      limitations: [f.limitation || 'Describe what this metric cannot tell you.'], version: 1,
      author: { kind: 'human', principalId, tenantId: '' },
    };
  };

  const m = useMutation({
    mutationFn: async () => {
      let proposal: Record<string, unknown>;
      try {
        proposal = JSON.parse(json || JSON.stringify(build())) as Record<string, unknown>;
      } catch {
        throw new Error('The proposal is not valid JSON.');
      }
      return browserApi.send<{ record: { metricKey: string; version: number; status: string }; report: { ok: boolean; checks: { name: string; verdict: string; detail: string }[]; issues: { reason: string; message?: string }[] } }>(
        'POST', `/v1/workspaces/${wid}/metrics/proposals`, { proposal, validate },
      );
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['data', '/v1/metrics'] }); },
  });
  const canWrite = me.data?.permissions?.canWrite;
  return (
    <Card title="Propose a metric" subtitle="A proposal starts as a draft, then becomes validated when the gate passes. It stays exploratory until a human owner or admin certifies it.">
      <div className="col gap3" data-testid="propose-form">
        {!canWrite && me.data && <Notice tone="warn" title="Read only">Your role cannot propose metrics.</Notice>}
        <div className="grid c3">
          <Field label="Workspace">
            <select className="select" id="pm-ws" value={wid} onChange={(e) => setWid(e.target.value)} data-testid="pm-workspace">
              <option value="">Choose a workspace</option>
              {ws.data?.workspaces.map((w) => <option key={w.id} value={w.id}>{w.objective.slice(0, 60)}</option>)}
            </select>
          </Field>
          <Field label="Name (lowercase, underscores)"><Input id="pm-name" value={f.name} onChange={set('name')} placeholder="daily_tx_total" data-testid="pm-name" /></Field>
          <Field label="Display name"><Input id="pm-dn" value={f.displayName} onChange={set('displayName')} data-testid="pm-display" /></Field>
        </div>
        <Field label="Description (at least 10 characters)"><Textarea id="pm-desc" rows={2} value={f.description} onChange={set('description')} data-testid="pm-desc" /></Field>
        <div className="grid c4">
          <Field label="Source table">
            <select className="select" id="pm-table" value={f.table} onChange={set('table')}>
              {Object.keys(TIME_COLUMNS).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Value column"><Input id="pm-col" value={f.column} onChange={set('column')} /></Field>
          <Field label="Aggregation">
            <select className="select" id="pm-fn" value={f.fn} onChange={set('fn')}>
              {['sum', 'avg', 'min', 'max', 'count', 'count_distinct'].map((x) => <option key={x}>{x}</option>)}
            </select>
          </Field>
          <Field label="Unit"><Input id="pm-unit" value={f.unit} onChange={set('unit')} /></Field>
        </div>
        <Field label="Limitation (what this metric cannot tell you)"><Input id="pm-lim" value={f.limitation} onChange={set('limitation')} data-testid="pm-limit" /></Field>
        <details>
          <summary className="small dim" style={{ cursor: 'pointer' }}>Advanced: edit the full proposal JSON</summary>
          <div className="row gap2" style={{ margin: '6px 0' }}><Button onClick={() => setJson(JSON.stringify(build(), null, 2))}>Fill from the form</Button></div>
          <Textarea rows={12} className="mono" value={json} onChange={(e) => setJson(e.target.value)} aria-label="Proposal JSON" />
        </details>
        <label className="row gap2 small"><input type="checkbox" checked={validate} onChange={(e) => setValidate(e.target.checked)} /> Run the validation gate now</label>
        <div className="row gap2">
          <Button variant="primary" disabled={!wid || m.isPending || !canWrite} onClick={() => m.mutate()} data-testid="pm-submit">{m.isPending ? 'Proposing' : 'Propose'}</Button>
        </div>
        {m.isError && <ApiErrorState error={m.error} />}
        {m.isSuccess && (
          <Notice tone={m.data.report?.ok ? 'ok' : 'warn'} title={`Proposed ${m.data.record.metricKey} v${m.data.record.version}: ${m.data.record.status.toLowerCase()}`}>
            <span data-testid="pm-result">{m.data.report ? <Checks checks={m.data.report.checks} issues={m.data.report.issues} /> : null}</span>{' '}
            <Link className="link" href={`/data/metrics/${encodeURIComponent(m.data.record.metricKey)}?w=${wid}`}>Open metric</Link>
          </Notice>
        )}
      </div>
    </Card>
  );
}

function Checks({ checks, issues }: { checks?: { name: string; verdict: string; detail: string }[]; issues?: { reason: string; message?: string }[] }) {
  return (
    <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
      {checks?.map((c) => <li key={c.name}><Badge tone={c.verdict === 'pass' ? 'ok' : c.verdict === 'fail' ? 'bad' : ''}>{c.verdict}</Badge> <span className="mono small">{c.name}</span> <span className="small dim">{c.detail}</span></li>)}
      {issues?.map((c, i) => <li key={i}><Badge tone="bad">issue</Badge> <span className="mono small">{c.reason}</span> <span className="small">{c.message}</span></li>)}
    </ul>
  );
}

/* ------------------------------------------------------------------ detail */

type Version = {
  metricKey: string; version: number; status: string; proposal: Record<string, unknown> & { displayName?: string; description?: string; unit?: string; limitations?: string[]; sources?: string[] };
  proposalHash: string; validation: { ok: boolean; checks: { name: string; verdict: string; detail: string }[]; issues: { reason: string; message?: string }[]; validatedAt?: string; derivedUnit?: string } | null;
  authorId: string | null; certifiedBy: string | null; certifiedAt: string | null; deprecatedBy: string | null; deprecatedAt: string | null; deprecationReason: string | null; supersededBy: number | null; createdAt: string; updatedAt: string;
};
type Versions = { versions: Version[]; audit: { at: string; version: number; action: string; outcome: string; actorId: string; actorKind: string; actorRole: string; detail: unknown }[]; corrections: unknown[] };
type Explore = { envelope: { columns: { name: string; unit: string | null }[]; rows: (string | null)[][]; rowCoverage: string[]; gaps: unknown[]; exploratory?: { banner: string }; certification: string; generatedAt: string; queryHash: string; sourceWatermarks: Record<string, string> } };

export function MetricDetail({ metricKey, wid }: { metricKey: string; wid: string | null }) {
  const cat = useApiGet<{ metrics: MetricRow[] }>('/v1/metrics');
  const row = cat.data?.metrics.find((m) => m.metricKey === metricKey);
  const wsId = wid ?? row?.authoredIn?.[0] ?? null;
  if (cat.isPending) return <Skeleton rows={4} />;
  if (cat.isError) return <ApiErrorState error={cat.error} onRetry={() => cat.refetch()} />;
  if (!row) return <EmptyState title="Metric not found" body="No metric with this key is visible to you." />;
  return (
    <div className="col gap3" data-testid="metric-detail">
      <Card title={row.displayName} subtitle={<span className="mono">{row.metricKey}</span>} actions={<StatusBadge status={row.status} exploratory={row.exploratory} />}>
        <KeyValues rows={[
          { k: 'Origin', v: <Badge outline>{row.source}</Badge> },
          { k: 'Version', v: <span className="mono">{row.version}</span> },
          { k: 'Unit', v: <span className="mono">{row.unit}</span> },
          { k: 'Publication', v: row.status === 'CERTIFIED' ? 'May back a published claim' : <span data-testid="blocked">Blocked: not certified, exploratory only</span> },
        ]} />
      </Card>
      {row.source === 'registry' ? (
        <RegistryDetail metricKey={metricKey} />
      ) : wsId ? (
        <Lifecycle metricKey={metricKey} wid={wsId} />
      ) : (
        <Notice tone="warn" title="Workspace unknown">Open this metric from a workspace it was authored in.</Notice>
      )}
    </div>
  );
}

function Lifecycle({ metricKey, wid }: { metricKey: string; wid: string }) {
  const key = encodeURIComponent(metricKey);
  const base = `/v1/workspaces/${wid}/metrics/${key}`;
  const qc = useQueryClient();
  const me = useMe();
  const vs = useApiGet<Versions>(`${base}/versions`);
  const [sel, setSel] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [correction, setCorrection] = useState(false);
  const [revJson, setRevJson] = useState('');
  const [explore, setExplore] = useState<Explore | null>(null);
  const [out, setOut] = useState<{ title: string; body: React.ReactNode } | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['data', `${base}/versions`] }); void qc.invalidateQueries({ queryKey: ['data', '/v1/metrics'] }); };

  const act = useMutation({
    mutationFn: async (a: { kind: 'validate' | 'certify' | 'deprecate' | 'explore' | 'revise'; v: number }) => {
      const p = `${base}/versions/${a.v}`;
      switch (a.kind) {
        case 'validate': return { a, r: await browserApi.send<{ report: { ok: boolean; checks: { name: string; verdict: string; detail: string }[]; issues: { reason: string }[] } }>('POST', `${p}/validate`, {}) };
        case 'certify': return { a, r: await browserApi.send<Version>('POST', `${p}/certify`, {}) };
        case 'deprecate': return { a, r: await browserApi.send<unknown>('POST', `${p}/deprecate`, { reason, correction }) };
        case 'explore': return { a, r: await browserApi.send<Explore>('POST', `${p}/explore`, {}) };
        case 'revise': return { a, r: await browserApi.send<{ record: Version }>('POST', `${base}/revisions`, { proposal: JSON.parse(revJson) }) };
      }
    },
    onSuccess: ({ a, r }) => {
      if (a.kind === 'explore') setExplore(r as Explore);
      if (a.kind === 'validate') {
        const rep = (r as { report: { ok: boolean; checks: { name: string; verdict: string; detail: string }[]; issues: { reason: string }[] } }).report;
        setOut({ title: rep.ok ? 'Validation passed' : 'Validation failed', body: <Checks checks={rep.checks} issues={rep.issues} /> });
      }
      if (a.kind === 'certify') setOut({ title: 'Certified', body: 'This version is now certified.' });
      if (a.kind === 'deprecate') setOut({ title: 'Deprecated', body: correction ? 'Marked as a correction: dependents are invalidated.' : 'Marked deprecated.' });
      if (a.kind === 'revise') setOut({ title: 'New version proposed', body: 'The revision is a new draft.' });
      refresh();
    },
  });

  if (vs.isPending) return <Skeleton rows={4} />;
  if (vs.isError) return <ApiErrorState error={vs.error} onRetry={() => vs.refetch()} />;
  const versions = vs.data.versions;
  const cur = versions.find((v) => v.version === (sel ?? versions[versions.length - 1]?.version)) ?? versions[versions.length - 1];
  if (!cur) return <EmptyState title="No versions" />;
  const isOwnerAdmin = me.data?.role === 'owner' || me.data?.role === 'admin';
  const canCertify = isOwnerAdmin && cur.status === 'VALIDATED';
  const isSelf = !!me.data && cur.authorId === me.data.subject;
  const never = !cur.certifiedAt;
  const ex = explore?.envelope;

  return (
    <div className="col gap3">
      <Card title="Versions">
        <DataTable<Version> caption="Versions of this metric" rows={versions} rowKey={(v) => String(v.version)} onRowClick={(v) => setSel(v.version)} columns={[
          { key: 'v', header: 'Version', numeric: true, render: (v) => <span className="mono">{v.version}{v.version === cur.version ? ' (selected)' : ''}</span> },
          { key: 's', header: 'Status', render: (v) => <StatusBadge status={v.status} /> },
          { key: 'h', header: 'Proposal hash', render: (v) => <span className="mono small">{v.proposalHash.slice(0, 12)}</span> },
          { key: 'c', header: 'Certified', render: (v) => <span className="mono small">{v.certifiedAt ? formatUtc(v.certifiedAt) : '—'}</span> },
          { key: 'u', header: 'Updated', render: (v) => <span className="mono small">{formatUtc(v.updatedAt)}</span> },
        ]} />
      </Card>

      <Card title={`Version ${cur.version}`} actions={<StatusBadge status={cur.status} />}>
        <div className="col gap3">
          {cur.status !== 'CERTIFIED' && <Notice tone="warn" title="Exploratory">This version is {cur.status.toLowerCase()}. Results are labelled exploratory and cannot be published or cited as verified.</Notice>}
          <KeyValues rows={[
            { k: 'Description', v: cur.proposal.description ?? '—' },
            { k: 'Sources', v: <span className="mono">{cur.proposal.sources?.join(', ')}</span> },
            { k: 'Unit', v: <span className="mono">{cur.validation?.derivedUnit ?? cur.proposal.unit}</span> },
            { k: 'Limitations', v: <ul style={{ margin: 0, paddingLeft: 16 }}>{cur.proposal.limitations?.map((l, i) => <li key={i}>{l}</li>)}</ul> },
            { k: 'Author', v: <span className="mono small">{cur.authorId ?? '—'}</span> },
            { k: 'Certified by', v: <span className="mono small">{cur.certifiedBy ? `${cur.certifiedBy} at ${formatUtc(cur.certifiedAt)}` : 'not certified'}</span> },
            ...(cur.deprecatedAt ? [{ k: 'Deprecated', v: `${formatUtc(cur.deprecatedAt)}: ${cur.deprecationReason ?? ''}` }] : []),
          ]} />
          <div>
            <div className="label">Validation</div>
            {cur.validation ? (
              <>
                <p className="small"><Badge tone={cur.validation.ok ? 'ok' : 'bad'}>{cur.validation.ok ? 'passed' : 'failed'}</Badge> <span className="dim">validated {formatUtc(cur.validation.validatedAt ?? null)}</span></p>
                <Checks checks={cur.validation.checks} issues={cur.validation.issues} />
              </>
            ) : <p className="small dim">Not validated yet.</p>}
          </div>

          <div className="row gap2" style={{ flexWrap: 'wrap' }} data-testid="lifecycle-actions">
            <Button disabled={act.isPending || cur.status === 'DEPRECATED'} onClick={() => act.mutate({ kind: 'validate', v: cur.version })} data-testid="act-validate">Validate</Button>
            <Button disabled={act.isPending} onClick={() => act.mutate({ kind: 'explore', v: cur.version })} data-testid="act-explore">Explore (exploratory run)</Button>
            <Button variant="primary" disabled={act.isPending || !canCertify} onClick={() => act.mutate({ kind: 'certify', v: cur.version })} data-testid="act-certify" title={!isOwnerAdmin ? 'Only a human owner or admin can certify' : cur.status !== 'VALIDATED' ? 'Only a validated version can be certified' : undefined}>Certify</Button>
          </div>
          {!isOwnerAdmin && me.data && <p className="small dim" data-testid="certify-blocked">Certification is limited to a human owner or admin. Your role is {me.data.role ?? 'unknown'}.</p>}
          {canCertify && isSelf && <p className="small dim" data-testid="self-cert-note">You authored this version. The API refuses self-certification: a different owner or admin must certify it.</p>}

          {cur.status !== 'DEPRECATED' && (
            <div className="col gap2">
              <div className="label">Deprecate</div>
              <div className="row gap2" style={{ flexWrap: 'wrap' }}>
                <Input aria-label="Deprecation reason" placeholder="Reason (at least 5 characters)" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="dep-reason" style={{ minWidth: 280 }} />
                <label className="row gap1 small"><input type="checkbox" checked={correction} onChange={(e) => setCorrection(e.target.checked)} /> Correction (invalidates dependents)</label>
                <Button disabled={act.isPending || reason.trim().length < 5} onClick={() => act.mutate({ kind: 'deprecate', v: cur.version })} data-testid="act-deprecate">Deprecate</Button>
              </div>
            </div>
          )}

          {cur.status === 'CERTIFIED' && (
            <details>
              <summary className="small dim" style={{ cursor: 'pointer' }}>Propose a new version (revision)</summary>
              <Textarea rows={8} className="mono" value={revJson} onChange={(e) => setRevJson(e.target.value)} aria-label="Revision proposal JSON" placeholder="Paste the full proposal JSON" />
              <Button onClick={() => { setRevJson(JSON.stringify(cur.proposal, null, 2)); }}>Start from this version</Button>{' '}
              <Button disabled={act.isPending || !revJson} onClick={() => act.mutate({ kind: 'revise', v: cur.version })}>Propose revision</Button>
            </details>
          )}
          {act.isError && <ApiErrorState error={act.error} />}
          {out && !act.isError && <Notice tone="ok" title={out.title}><span data-testid="act-result">{out.body}</span></Notice>}
        </div>
      </Card>

      {ex && (
        <Card title="Exploratory run" subtitle={`Generated ${formatUtc(ex.generatedAt)} | query ${ex.queryHash.slice(0, 12)}`}>
          <div className="col gap2" data-testid="explore-result">
            {ex.exploratory && <Notice tone="warn" title="Exploratory">{ex.exploratory.banner}</Notice>}
            <SeriesChart ariaLabel="Exploratory metric values" unit={ex.columns[1]?.unit ?? undefined} series={[{ name: ex.columns[1]?.name ?? 'value', points: ex.rows.map((r) => ({ x: String(r[0]), y: r[1] })) }]} />
            <DataTable caption="Rows with coverage" rows={ex.rows.map((r, i) => ({ r, cov: ex.rowCoverage[i] }))} rowKey={(x) => String(x.r[0])} columns={[
              { key: 'b', header: 'Bucket (UTC)', render: (x) => <span className="mono">{x.r[0]}</span> },
              { key: 'v', header: `Value (${ex.columns[1]?.unit ?? 'unit'})`, numeric: true, render: (x) => (x.r[1] === null ? '—' : Number(x.r[1]).toLocaleString('en-US')) },
              { key: 'c', header: 'Coverage', render: (x) => <Badge tone={x.cov === 'complete' ? 'ok' : 'warn'}>{x.cov}</Badge> },
            ]} />
            {ex.gaps.length > 0 && <p className="small">{ex.gaps.length} gap(s) reported.</p>}
          </div>
        </Card>
      )}

      <ApiCard<unknown> id="audit-note" title="Audit trail" path={`${base}/versions`}>
        {() => (
          <DataTable caption="Lifecycle actions" rows={vs.data.audit} rowKey={(a) => `${a.at}-${a.action}-${a.version}`} columns={[
            { key: 'a', header: 'When', render: (a) => <span className="mono small">{formatUtc(a.at)}</span> },
            { key: 'v', header: 'Version', numeric: true, render: (a) => a.version },
            { key: 'x', header: 'Action', render: (a) => <span className="mono">{a.action}</span> },
            { key: 'o', header: 'Outcome', render: (a) => <Badge tone={a.outcome === 'ok' ? 'ok' : 'bad'}>{a.outcome}</Badge> },
            { key: 'w', header: 'Actor', render: (a) => <span className="small">{a.actorKind} {a.actorRole}</span> },
          ]} />
        )}
      </ApiCard>
    </div>
  );
}

/* ------------------------------------------------------------------ registry metric */

type RegistryMetric = {
  metricKey: string; source: 'registry'; status: string; version: string; displayName: string; unit: string; exploratory: boolean;
  definition: Record<string, unknown> & { kind?: string; grain?: string; aggregationLaw?: string; denominator?: string; zeroPolicy?: string; transformations?: string[]; expectedUpdateLag?: string; botProxyDefinition?: string; uncertainty?: string; cubeMember?: string | null };
  sources: string[]; visibility: string; owner: string; docUri: string | null;
  certification: { certified: boolean; certifiedVersion: string | null; registrySemanticVersion: string };
  semanticHash: string; registryContentHash: string;
};
type RegistryVersions = {
  metricKey: string;
  versions: { version: string; status: string; current: boolean; semanticHash: string; registrySemanticVersion: string; registryContentHash: string }[];
  note?: string;
};

/** Certified registry metric: definition, sources, hashes and certification from GET /v1/metrics/:key and /versions. */
function RegistryDetail({ metricKey }: { metricKey: string }) {
  const key = encodeURIComponent(metricKey);
  const m = useApiGet<RegistryMetric>(`/v1/metrics/${key}`);
  const v = useApiGet<RegistryVersions>(`/v1/metrics/${key}/versions`);
  if (m.isPending) return <Skeleton rows={4} />;
  if (m.isError) return <ApiErrorState error={m.error} onRetry={() => m.refetch()} />;
  const d = m.data;
  const def = d.definition;
  return (
    <div className="col gap3" data-testid="registry-metric">
      <Card title="Registry definition" subtitle="Certified with the platform. Revisions are made by authoring a new metric.">
        <KeyValues rows={[
          { k: 'Certification', v: <span data-testid="registry-certification"><Badge tone={d.certification.certified ? 'ok' : 'warn'}>{d.certification.certified ? 'certified' : 'not certified'}</Badge> <span className="mono small">version {d.certification.certifiedVersion ?? 'none'}, registry {d.certification.registrySemanticVersion}</span></span> },
          { k: 'Kind', v: <span className="mono">{def.kind ?? '—'}</span> },
          { k: 'Grain', v: <span className="mono">{def.grain ?? '—'}</span> },
          { k: 'Aggregation law', v: <span className="mono">{def.aggregationLaw ?? '—'}</span> },
          { k: 'Denominator', v: def.denominator ?? '—' },
          { k: 'Zero policy', v: <span className="mono">{def.zeroPolicy ?? '—'}</span> },
          { k: 'Expected update lag', v: <span className="mono">{def.expectedUpdateLag ?? '—'}</span> },
          { k: 'Bot and system traffic', v: def.botProxyDefinition ?? '—' },
          { k: 'Uncertainty', v: <span data-testid="registry-uncertainty">{def.uncertainty ?? '—'}</span> },
          { k: 'Sources', v: <span className="mono small" data-testid="registry-sources">{d.sources.join(', ')}</span> },
          { k: 'Transformations', v: <ul style={{ margin: 0, paddingLeft: 16 }}>{def.transformations?.map((t, i) => <li key={i}>{t}</li>)}</ul> },
          { k: 'Owner', v: <span className="mono small">{d.owner}</span> },
          { k: 'Visibility', v: d.visibility },
          ...(d.docUri ? [{ k: 'Documentation', v: <span className="mono small">{d.docUri}</span> }] : []),
          { k: 'Semantic hash', v: <span className="mono small" data-testid="registry-semantic-hash" title={d.semanticHash}>{d.semanticHash}</span> },
          { k: 'Registry content hash', v: <span className="mono small" data-testid="registry-content-hash" title={d.registryContentHash}>{d.registryContentHash}</span> },
        ]} />
      </Card>
      <Card title="Versions">
        {v.isPending ? <Skeleton rows={2} /> : v.isError ? <ApiErrorState error={v.error} onRetry={() => v.refetch()} /> : (
          <div className="col gap2" data-testid="registry-versions">
            <DataTable<RegistryVersions['versions'][number]>
              caption="Registry versions"
              rows={v.data.versions}
              rowKey={(x) => x.version}
              columns={[
                { key: 'v', header: 'Version', render: (x) => <span className="mono">{x.version}{x.current ? ' (current)' : ''}</span> },
                { key: 's', header: 'Status', render: (x) => <StatusBadge status={x.status} /> },
                { key: 'h', header: 'Semantic hash', render: (x) => <span className="mono small">{x.semanticHash.slice(0, 16)}</span> },
                { key: 'c', header: 'Content hash', render: (x) => <span className="mono small">{x.registryContentHash.slice(0, 16)}</span> },
              ]}
            />
            {v.data.note && <p className="small dim">{v.data.note}</p>}
          </div>
        )}
      </Card>
    </div>
  );
}
