'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Button } from '@/components/nx/ui';
import { browserApi } from '@/lib/api/browser';
import { ApiRequestError } from '@/lib/api/errors';
import { fetchThesisList, pdfHref, thesisKeys } from '@/lib/thesis/api';

/**
 * Thesis buttons: "Open thesis" and "Download thesis PDF" when this workspace already has one, otherwise "Build thesis"
 * (POST /v1/workspaces/:id/theses, then the viewer). A refusal is said in words next to the button.
 */
export default function WorkspaceThesisButtons({ wid, thesisId = null, pdf = true }: { wid: string; thesisId?: string | null; pdf?: boolean }) {
  const router = useRouter();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: thesisKeys.list, queryFn: fetchThesisList, retry: false, staleTime: 15_000, enabled: !thesisId });
  const mine = (list.data ?? []).filter((t) => t.workspaceId === wid && t.kind === 'workspace');
  const found = mine.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))[0]?.id ?? null;
  const existing = thesisId ?? found;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function build() {
    setPending(true);
    setError(null);
    try {
      const r = await browserApi.send<{ thesisId?: string }>('POST', `/v1/workspaces/${encodeURIComponent(wid)}/theses`, {});
      if (!r.thesisId) throw new Error('The API did not return the thesis.');
      await qc.invalidateQueries({ queryKey: ['thesis'] });
      router.push(`/thesis/${encodeURIComponent(r.thesisId)}`);
    } catch (e) {
      setPending(false);
      setError(
        e instanceof ApiRequestError
          ? e.status === 404 || e.status === 405
            ? 'Building theses is not available on this server yet.'
            : e.reasonCode === 'RUN_NOT_CAPSULABLE'
              ? `This workspace has no finished run with two aligned series yet. ${e.message}`
              : e.message
          : 'The thesis could not be built.',
      );
    }
  }
  return (
    <>
      {existing ? (
        <>
          <Link className="btn primary" href={`/thesis/${encodeURIComponent(existing)}`} data-testid="open-thesis">Open thesis</Link>
          {pdf && <a className="btn" href={pdfHref(existing)} download data-testid="download-thesis-pdf">Download thesis PDF</a>}
        </>
      ) : (
        <Button variant="primary" pending={pending} onClick={build} data-testid="build-thesis">
          Build thesis
        </Button>
      )}
      {error && (
        <span className="small" role="alert" data-testid="build-thesis-error" style={{ flexBasis: '100%', color: 'var(--bad)' }}>
          {error}
        </span>
      )}
    </>
  );
}
