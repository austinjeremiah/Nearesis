'use client';

import { useQuery } from '@tanstack/react-query';
import { ApiErrorState } from '@/components/nx/states';
import { EmptyState, LinkButton } from '@/components/nx/ui';
import { ThesisDocView, ThesisLoading } from '@/components/nx/thesis-track/thesis-view';
import { fetchThesis, isNotServed, thesisKeys } from '@/lib/thesis/api';
import { isNotBuilt } from '@/lib/thesis-track/model';
import ThesisActions from './thesis-actions';

/** `/thesis/[id]`: the one viewer for every thesis the signed-in reader can open. */
export default function ThesisPage({ id }: { id: string }) {
  const q = useQuery({ queryKey: thesisKeys.one(id), queryFn: () => fetchThesis(id), retry: false, staleTime: 15_000 });
  if (q.isPending) return <ThesisLoading />;
  if (q.isError) {
    if (isNotServed(q.error)) {
      return (
        <div data-testid="thesis-not-found">
          <EmptyState
            title="Thesis not found"
            body="Either this thesis is not yours to open, or the server does not serve user theses yet."
            action={<LinkButton href="/thesis">Back to theses</LinkButton>}
          />
        </div>
      );
    }
    if (isNotBuilt(q.error)) {
      return <EmptyState title="The reference thesis has not been built yet" body="Build it from the repository root with pnpm thesis:build." />;
    }
    return <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  }
  return (
    <ThesisDocView
      doc={q.data.doc}
      isReference={q.data.summary.kind === 'reference'}
      publication={q.data.source === 'api' && q.data.summary.kind !== 'reference' ? (q.data.summary.published ? 'published' : 'draft') : null}
      actions={<ThesisActions b={q.data} />}
    />
  );
}
