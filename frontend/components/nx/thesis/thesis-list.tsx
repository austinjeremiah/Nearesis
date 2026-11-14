'use client';

import './thesis.css';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/nx/evidence';
import { SectionBar } from '@/components/nx/section';
import { LinkButton, Notice, Skeleton } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { browserApi } from '@/lib/api/browser';
import { qk } from '@/lib/api/keys';
import { formatAge } from '@/lib/format';
import { workspaceLabel } from '@/lib/workspace/label';
import { statusLabel, statusTone } from '@/lib/thesis-track/model';
import { stripStatusPrefix } from '@/lib/thesis/display';
import { fetchLegacyReference, fetchThesisList, isNotServed, thesisKeys } from '@/lib/thesis/api';
import { groupTheses, receiptTotal, receiptsShort, type ThesisSummary } from '@/lib/thesis/list';

function Card({ s, pinned, workspaces }: { s: ThesisSummary; pinned?: boolean; workspaces: Map<string, string> }) {
  const tone = statusTone(s.verdictStatus);
  const ws = s.workspaceId ? (workspaces.get(s.workspaceId) ?? `workspace ${s.workspaceId.slice(0, 8)}`) : null;
  return (
    <article className={`card th-card${pinned ? ' pinned' : ''}`} data-surface data-tone={tone} data-testid="thesis-card" data-thesis={s.id}>
      <div className="th-card-top">
        <Badge tone={tone}>{statusLabel(s.verdictStatus)}</Badge>
        {s.kind === 'reference' ? <Badge outline>reference</Badge> : s.kind === 'imported' ? <Badge outline>opened from a link</Badge> : null}
        {s.kind !== 'reference' && <Badge tone={s.published ? 'ok' : ''} outline>{s.published ? 'published' : 'draft'}</Badge>}
      </div>
      <h3>
        <Link href={`/thesis/${encodeURIComponent(s.id)}`}>{s.hypothesis ?? s.title ?? 'unknown'}</Link>
      </h3>
      {s.headline && <p className="th-headline">{stripStatusPrefix(s.headline, s.verdictStatus)}</p>}
      <div className="th-detail">
        {ws && <span>{workspaceLabel(ws, 70)}</span>}
        <span>
          {s.version ? `version ${s.version.slice(0, 12)}` : 'version unknown'}
          {s.updatedAt ? ` · updated ${formatAge(s.updatedAt)}` : ''}
        </span>
        {s.kind !== 'reference' || receiptTotal(s.receipts) > 0 ? (
          <span className="th-receipts" data-testid="thesis-receipts">{receiptsShort(s.receipts)}</span>
        ) : null}
      </div>
    </article>
  );
}

function Empty() {
  return (
    <div className="th-empty" data-surface data-testid="thesis-empty">
      <div className="h3">You have no theses yet</div>
      <p>Ask the Agent a question about your data and let it run to the end: the result becomes a thesis you can verify, share and reproduce. You can also press Build thesis on a workspace that has a finished run.</p>
      <div className="row gap2">
        <LinkButton href="/agent" variant="primary">Open the Agent</LinkButton>
        <LinkButton href="/workspaces">Choose a workspace</LinkButton>
      </div>
    </div>
  );
}

export default function ThesisList() {
  const list = useQuery({ queryKey: thesisKeys.list, queryFn: fetchThesisList, retry: false, staleTime: 15_000 });
  const served = list.isSuccess;
  const legacy = useQuery({
    queryKey: thesisKeys.one('reference-near-intents'),
    queryFn: fetchLegacyReference,
    enabled: !list.isPending && !(list.data ?? []).some((i) => i.kind === 'reference'),
    retry: false,
    staleTime: 30_000,
  });
  const wsq = useQuery({ queryKey: qk.workspaces, queryFn: () => browserApi.workspaces(), enabled: served });
  const workspaces = new Map<string, string>();
  for (const w of (wsq.data?.workspaces ?? []) as { workspaceId?: string; id?: string; objective?: string }[]) {
    const id = w.workspaceId ?? w.id;
    if (id && w.objective) workspaces.set(id, w.objective);
  }
  if (list.isPending) {
    return (
      <div className="th-list" data-testid="thesis-list-loading" aria-busy="true">
        <Skeleton rows={5} />
      </div>
    );
  }
  const notServed = list.isError && isNotServed(list.error);
  const groups = groupTheses(list.data ?? [], legacy.data?.summary ?? null);
  return (
    <div className="th-list" data-testid="thesis-list">
      <section className="th-group" aria-label="Reference thesis">
        {groups.reference ? (
          <div className="th-grid">
            <Card s={groups.reference} pinned workspaces={workspaces} />
          </div>
        ) : legacy.isError ? (
          <ApiErrorState error={legacy.error} onRetry={() => legacy.refetch()} />
        ) : (
          <Skeleton rows={3} />
        )}
      </section>

      {notServed ? (
        <section className="th-group" aria-label="My theses">
          <SectionBar title="My theses" />
          <Notice tone="info" title="Your theses are not available yet">
            <span data-testid="thesis-not-available">This server does not serve the thesis list yet. The reference thesis above still opens. Try again after the next update.</span>
          </Notice>
        </section>
      ) : list.isError ? (
        <ApiErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <>
          <section className="th-group" aria-label="My theses">
            <SectionBar title="My theses" number={String(groups.mine.length).padStart(3, '0')} />
            {groups.mine.length === 0 ? (
              <Empty />
            ) : (
              <div className="th-grid">
                {groups.mine.map((s) => (
                  <Card key={s.id} s={s} workspaces={workspaces} />
                ))}
              </div>
            )}
          </section>
          {groups.opened.length > 0 && (
            <section className="th-group" aria-label="Opened from a link">
              <SectionBar title="Opened from a link" number={String(groups.opened.length).padStart(3, '0')} />
              <div className="th-grid">
                {groups.opened.map((s) => (
                  <Card key={s.id} s={s} workspaces={workspaces} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
