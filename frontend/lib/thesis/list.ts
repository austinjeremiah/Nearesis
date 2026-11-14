import type { Thesis } from '@/lib/thesis-track/model';

/** View model for the thesis list. Tolerant of every optional field; unknown stays null. */

export const REFERENCE_ID = 'reference-near-intents';
export type ThesisKind = 'reference' | 'workspace' | 'imported';
export type Receipts = { verified: number; reproduced: number; drift: number };
export type ThesisSummary = {
  id: string;
  title: string | null;
  hypothesis: string | null;
  verdictStatus: string | null;
  headline: string | null;
  kind: ThesisKind;
  workspaceId: string | null;
  version: string | null;
  published: boolean;
  shareSlug: string | null;
  updatedAt: string | null;
  receipts: Receipts;
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const count = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export const ZERO_RECEIPTS: Receipts = { verified: 0, reproduced: 0, drift: 0 };

/** `{verified, reproduced, drift}` counts, or the same counted from an array of receipt records. */
export function normalizeReceipts(raw: unknown): Receipts {
  if (Array.isArray(raw)) {
    const r = { ...ZERO_RECEIPTS };
    for (const x of raw) {
      if (!isRec(x)) continue;
      const kind = String(x.kind ?? x.type ?? '').toLowerCase();
      const outcome = String(x.outcome ?? '').toLowerCase();
      if (outcome === 'drift') r.drift += 1;
      if (kind === 'reproduce' || kind === 'reproduced') r.reproduced += 1;
      else if (kind === 'verify' || kind === 'verified' || outcome === 'verified') r.verified += 1;
    }
    return r;
  }
  if (!isRec(raw)) return { ...ZERO_RECEIPTS };
  return { verified: count(raw.verified), reproduced: count(raw.reproduced), drift: count(raw.drift) };
}

const kindOf = (v: unknown, id: string): ThesisKind => (v === 'reference' || v === 'imported' || v === 'workspace' ? v : id === REFERENCE_ID ? 'reference' : 'workspace');

export function normalizeSummary(raw: unknown): ThesisSummary | null {
  if (!isRec(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const v = raw.verdict;
  const slug = str(raw.shareSlug);
  const status = str(raw.status);
  return {
    id,
    title: str(raw.title),
    hypothesis: str(raw.hypothesis),
    verdictStatus: typeof v === 'string' ? str(v) : isRec(v) ? str(v.status) : null,
    headline: isRec(v) ? str(v.headline) : str(raw.headline),
    kind: kindOf(raw.kind, id),
    workspaceId: str(raw.workspaceId),
    version: str(raw.version),
    published: slug !== null && status !== 'draft',
    shareSlug: slug,
    updatedAt: str(raw.updatedAt),
    receipts: normalizeReceipts(raw.receipts),
  };
}

export function normalizeList(raw: unknown): ThesisSummary[] {
  const items = isRec(raw) && Array.isArray(raw.items) ? raw.items : Array.isArray(raw) ? raw : [];
  return items.map(normalizeSummary).filter((s): s is ThesisSummary => s !== null);
}

/** The reference's summary built from its document, used until the list API serves it. */
export function referenceSummary(doc: Thesis): ThesisSummary {
  return {
    id: REFERENCE_ID,
    title: 'NEAR Intents thesis',
    hypothesis: doc.hypothesis ?? null,
    verdictStatus: doc.verdict?.status ?? null,
    headline: doc.verdict?.headline ?? null,
    kind: 'reference',
    workspaceId: null,
    version: doc.version ?? null,
    published: false,
    shareSlug: null,
    updatedAt: doc.generatedAt ?? null,
    receipts: { ...ZERO_RECEIPTS },
  };
}

export type ListGroups = { reference: ThesisSummary | null; mine: ThesisSummary[]; opened: ThesisSummary[] };

const byUpdated = (a: ThesisSummary, b: ThesisSummary) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');

/** Reference pinned first, then the caller's own, then the ones opened from a link; newest first inside a group. */
export function groupTheses(items: ThesisSummary[], fallbackReference?: ThesisSummary | null): ListGroups {
  const reference = items.find((i) => i.kind === 'reference' || i.id === REFERENCE_ID) ?? fallbackReference ?? null;
  return {
    reference,
    mine: items.filter((i) => i.kind === 'workspace' && i.id !== REFERENCE_ID).sort(byUpdated),
    opened: items.filter((i) => i.kind === 'imported').sort(byUpdated),
  };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Card line: "verified 4 · reproduced 2 · drift 1". */
export function receiptsShort(r: Receipts): string {
  return `verified ${r.verified} · reproduced ${r.reproduced} · drift ${r.drift}`;
}

/** Viewer strip: "verified 4 times · reproduced 2 · 1 drift", or the plain no-receipts line. */
export function receiptsText(r: Receipts): string {
  if (r.verified + r.reproduced + r.drift === 0) return 'Not verified or reproduced yet';
  const parts = [`verified ${r.verified} ${plural(r.verified, 'time', 'times')}`, `reproduced ${r.reproduced}`, `${r.drift} drift`];
  return parts.join(' · ');
}

export const kindLabel = (k: ThesisKind): string => (k === 'reference' ? 'reference' : k === 'imported' ? 'opened from a link' : 'mine');
