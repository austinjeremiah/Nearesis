import type { Thesis } from '@/lib/thesis-track/model';
import { normalizeStrength, type Strength } from './strength';

/** View model for the thesis list. Tolerant of every optional field; unknown stays null. */

export const REFERENCE_ID = 'reference-near-intents';
export type ThesisKind = 'reference' | 'workspace' | 'imported';
export type Receipts = { verified: number; reproduced: number; drift: number; different: number; incomplete: number; mismatch: number; challenged: number };
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
  /** Server-computed strength; null when the API sent none (the meter is then hidden). */
  strength: Strength | null;
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const count = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export const ZERO_RECEIPTS: Receipts = { verified: 0, reproduced: 0, drift: 0, different: 0, incomplete: 0, mismatch: 0, challenged: 0 };

/** `{verified, reproduced, drift}` counts, or the same counted from an array of receipt records. */
export function normalizeReceipts(raw: unknown): Receipts {
  if (Array.isArray(raw)) {
    const r = { ...ZERO_RECEIPTS };
    for (const x of raw) {
      if (!isRec(x)) continue;
      const kind = String(x.kind ?? x.type ?? '').toLowerCase();
      const outcome = String(x.outcome ?? '').toLowerCase();
      if (outcome === 'drift') r.drift += 1;
      else if (outcome === 'different') r.different += 1;
      else if (outcome === 'incomplete') r.incomplete += 1;
      else if (outcome === 'mismatch') r.mismatch += 1;
      if (kind === 'reproduce' || kind === 'reproduced') r.reproduced += 1;
      else if (kind === 'verify' || kind === 'verified' || outcome === 'verified') r.verified += 1;
      else if (kind === 'challenge' || kind === 'challenged') r.challenged += 1;
    }
    return r;
  }
  if (!isRec(raw)) return { ...ZERO_RECEIPTS };
  return { verified: count(raw.verified), reproduced: count(raw.reproduced), drift: count(raw.drift), different: count(raw.different), incomplete: count(raw.incomplete), mismatch: count(raw.mismatch), challenged: count(raw.challenged) };
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
    strength: normalizeStrength(raw.strength),
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
    strength: null,
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

/** Verifications and reproductions only: a challenge is a review, not a check of the numbers. */
export const receiptTotal = (r: Receipts): number => r.verified + r.reproduced + r.drift + r.different + r.incomplete + r.mismatch;

export type ReceiptPart = { text: string; warn: boolean };

/** The buckets worth showing: verified and reproduced always, the others only when not zero; mismatch and different are warnings. */
export function receiptParts(r: Receipts): ReceiptPart[] {
  const out: ReceiptPart[] = [{ text: `verified ${r.verified}`, warn: false }, { text: `reproduced ${r.reproduced}`, warn: false }];
  if (r.drift > 0) out.push({ text: `drift ${r.drift}`, warn: false });
  if (r.incomplete > 0) out.push({ text: `incomplete ${r.incomplete}`, warn: false });
  if (r.different > 0) out.push({ text: `different ${r.different}`, warn: true });
  if (r.mismatch > 0) out.push({ text: `mismatch ${r.mismatch}`, warn: true });
  if (r.challenged > 0) out.push({ text: `challenged ${r.challenged}`, warn: false });
  return out;
}

/** Card line and viewer strip: "verified 2 · reproduced 1 · drift 1". */
export function receiptsShort(r: Receipts): string {
  return receiptParts(r).map((p) => p.text).join(' · ');
}

/** Viewer strip text, or the plain no-receipts line. */
export function receiptsText(r: Receipts): string {
  if (receiptTotal(r) === 0) return r.challenged > 0 ? `Not verified or reproduced yet · challenged ${r.challenged}` : 'Not verified or reproduced yet';
  return receiptsShort(r);
}

export const kindLabel = (k: ThesisKind): string => (k === 'reference' ? 'reference' : k === 'imported' ? 'opened from a link' : 'mine');
