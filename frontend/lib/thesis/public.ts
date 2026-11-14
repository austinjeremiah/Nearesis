import 'server-only';
import { API_URL } from '@/lib/api/config';
import { normalizeDoc } from '@/lib/thesis/doc';
import { normalizeReceipts } from '@/lib/thesis/list';
import { normalizeStrength } from '@/lib/thesis/strength';
import { normalizeChallenges } from '@/lib/thesis/challenge';

export type PublicOutcome =
  | { kind: 'ok'; thesisId: string | null; published: boolean; doc: NonNullable<ReturnType<typeof normalizeDoc>>; receipts: ReturnType<typeof normalizeReceipts>; strength: ReturnType<typeof normalizeStrength>; challenges: ReturnType<typeof normalizeChallenges> }
  | { kind: 'not_found' }
  | { kind: 'rate_limited'; retryAfter: string | null }
  | { kind: 'unavailable'; message: string };

/** Anonymous server-to-server read: no cookie and no authorization header travel with it. */
export async function loadPublicThesis(slug: string): Promise<PublicOutcome> {
  let r: Response;
  try {
    r = await fetch(`${API_URL}/v1/public/theses/${encodeURIComponent(slug)}`, { cache: 'no-store', headers: { accept: 'application/json' } });
  } catch {
    return { kind: 'unavailable', message: 'The thesis service is not reachable.' };
  }
  if (r.ok) {
    const body = (await r.json().catch(() => null)) as { doc?: unknown; receipts?: unknown; strength?: unknown; challenges?: unknown; thesis?: { id?: unknown; strength?: unknown; challenges?: unknown; receipts?: unknown } } | null;
    const doc = normalizeDoc(body?.doc);
    if (!doc) return { kind: 'unavailable', message: 'The thesis could not be read.' };
    return { kind: 'ok', thesisId: typeof body?.thesis?.id === 'string' ? body.thesis.id : null, published: true, doc, receipts: normalizeReceipts(body?.receipts ?? body?.thesis?.receipts), strength: normalizeStrength(body?.strength ?? body?.thesis?.strength), challenges: normalizeChallenges(body?.challenges ?? body?.thesis?.challenges) };
  }
  if (r.status === 404 || r.status === 405) return { kind: 'not_found' };
  if (r.status === 429) return { kind: 'rate_limited', retryAfter: r.headers.get('retry-after') };
  const body = (await r.json().catch(() => ({}))) as { message?: string };
  return { kind: 'unavailable', message: body.message ?? `The thesis could not be read (HTTP ${r.status}).` };
}
