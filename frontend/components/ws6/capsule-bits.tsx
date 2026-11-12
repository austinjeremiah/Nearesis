import { Badge } from '@/components/nx/evidence';
import type { VerificationEntry } from '@/lib/ws6/api';

export function PublicationBadge({ state }: { state: 'published' | 'unpublished' | 'never_published' }) {
  return state === 'published' ? <Badge tone="ok">published</Badge> : state === 'unpublished' ? <Badge tone="warn">withdrawn</Badge> : <Badge outline>never published</Badge>;
}

/**
 * The two verification claims never share a label. Local: recomputed by this repository's verifier from the
 * frozen bytes ("reproduced"). OutLayer: "attested" only when the proof policy and a quote verifier accepted
 * evidence; every other status is shown as what it is.
 */
export function LocalBadge({ v }: { v: VerificationEntry }) {
  const ok = v.status === 'reproduced';
  return (
    <Badge tone={ok ? 'ok' : 'bad'} title={v.method}>
      {ok ? 'Reproduced (local recomputation)' : `Not reproduced: ${v.status}`}
    </Badge>
  );
}

export function OutlayerBadge({ v }: { v: VerificationEntry }) {
  const s = v.status;
  if (s === 'verified' || s === 'attested' || s === 'outlayer_attested') return <Badge tone="ok">Attested (OutLayer)</Badge>;
  if (s === 'not_submitted') return <Badge outline>Not attested: no OutLayer job submitted</Badge>;
  return <Badge tone="warn">OutLayer: {s.replace(/_/g, ' ')}</Badge>;
}
