import { browserApi } from '@/lib/api/browser';
import { ApiRequestError } from '@/lib/api/errors';
import { THESIS_PATH } from '@/lib/thesis-track/model';
import { normalizeDoc } from './doc';
import { REFERENCE_ID, normalizeList, normalizeReceipts, normalizeSummary, referenceSummary, type Receipts, type ThesisSummary } from './list';
import type { Thesis } from '@/lib/thesis-track/model';

export const thesisKeys = {
  list: ['thesis', 'list'] as const,
  one: (id: string) => ['thesis', 'one', id] as const,
};

/** A 404 or 405 on a thesis route means this API does not serve it yet. */
export const isNotServed = (e: unknown) => e instanceof ApiRequestError && (e.status === 404 || e.status === 405);

export type ThesisBundle = {
  summary: ThesisSummary;
  doc: Thesis;
  /** null when receipts are not available (the new API is not serving this thesis yet). */
  receipts: Receipts | null;
  /** 'api' = GET /v1/theses/:id; 'legacy' = the reference read from GET /v1/thesis. */
  source: 'api' | 'legacy';
};

const enc = encodeURIComponent;

export async function fetchThesisList(): Promise<ThesisSummary[]> {
  return normalizeList(await browserApi.get<unknown>('/v1/theses'));
}

/** The one document for the reference thesis, from the legacy route. */
export async function fetchLegacyReference(): Promise<ThesisBundle> {
  const doc = normalizeDoc(await browserApi.get<unknown>(THESIS_PATH));
  if (!doc) throw new Error('The reference thesis is not a nearesis.thesis.v1 document.');
  return { summary: referenceSummary(doc), doc, receipts: null, source: 'legacy' };
}

export async function fetchThesis(id: string): Promise<ThesisBundle> {
  try {
    const raw = await browserApi.get<{ thesis?: unknown; doc?: unknown; receipts?: unknown }>(`/v1/theses/${enc(id)}`);
    const doc = normalizeDoc(raw?.doc);
    if (!doc) throw new Error('The API returned a thesis without a readable document.');
    const summary = normalizeSummary(raw.thesis) ?? { ...referenceSummary(doc), id, kind: id === REFERENCE_ID ? 'reference' : 'workspace' };
    const fromSummary = isRecord(raw.thesis) ? raw.thesis.receipts : undefined;
    return { summary, doc, receipts: normalizeReceipts(fromSummary ?? raw.receipts), source: 'api' };
  } catch (e) {
    if (id === REFERENCE_ID && isNotServed(e)) return fetchLegacyReference();
    throw e;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export const thesisFileHref = (id: string, file: string) => `/api/k/theses/${enc(id)}/files/${file}`;
export const pdfHref = (id: string) => `/api/thesis/${enc(id)}/pdf`;
