'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiErrorState } from '@/components/nx/states';
import { EmptyState, LinkButton, Skeleton } from '@/components/nx/ui';
import { browserApi } from '@/lib/api/browser';
import { isNotServed } from '@/lib/thesis/api';

/** `/thesis/import/[slug]`: add a published thesis to the signed-in reader's list, then open it. */
export default function ImportThesis({ slug }: { slug: string }) {
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    browserApi
      .send<{ thesisId?: string; id?: string; thesis?: { id?: string } }>('POST', '/v1/theses/import', { slug })
      .then((r) => {
        const id = r.thesisId ?? r.thesis?.id ?? r.id;
        if (!id) throw new Error('The API did not return the imported thesis.');
        router.replace(`/thesis/${encodeURIComponent(id)}`);
      })
      .catch(setError);
  }, [slug, router]);
  if (error) {
    return isNotServed(error) ? (
      <EmptyState title="This thesis cannot be opened" body="The link is wrong, the thesis was unpublished, or this server does not support opening shared theses yet." action={<LinkButton href="/thesis">Back to theses</LinkButton>} />
    ) : (
      <ApiErrorState error={error} />
    );
  }
  return (
    <div data-testid="thesis-importing" aria-busy="true">
      <Skeleton rows={2} />
      <p className="small dim">Adding the thesis to your account</p>
    </div>
  );
}
