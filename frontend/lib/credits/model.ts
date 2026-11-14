import { CONTACT_EMAIL, formatUsdExact, isLow, isUsd } from './usd';

/**
 * View model of GET /v1/credits (unified USD credits). Normalised so a page never crashes on a missing field: anything the
 * server did not send is null ("unknown"), never 0. The old NEAR-credit shape normalises to all-unknown with `known: false`.
 */

export type CreditEntry = {
  id: string;
  kind: string;
  category: string | null;
  amountUsd: string | null;
  refKind: string | null;
  refId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string | null;
};

export type Credits = {
  /** True when the response carries the USD figures (the unified shape). */
  known: boolean;
  allowanceUsd: string | null;
  spentUsd: string | null;
  heldUsd: string | null;
  availableUsd: string | null;
  exhausted: boolean | null;
  contactEmail: string;
  byCategory: { modelUsd: string | null; outlayerUsd: string | null; anchorUsd: string | null };
  nearUsdRate: { rate: string; date: string | null } | null;
  proofEstimateUsd: string | null;
  entries: CreditEntry[];
};

type R = Record<string, unknown>;
const obj = (v: unknown): R => (v && typeof v === 'object' && !Array.isArray(v) ? (v as R) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const usd = (v: unknown): string | null => (isUsd(v) ? v : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : null);

export function normalizeCredits(raw: unknown): Credits {
  const r = obj(raw);
  const by = obj(r.byCategory);
  const rate = r.nearUsdRate && typeof r.nearUsdRate === 'object' ? obj(r.nearUsdRate) : null;
  const rateVal = rate ? (typeof rate.rate === 'number' && Number.isFinite(rate.rate) ? String(rate.rate) : str(rate.rate)) : null;
  const available = usd(r.availableUsd);
  return {
    known: available !== null,
    allowanceUsd: usd(r.allowanceUsd),
    spentUsd: usd(r.spentUsd),
    heldUsd: usd(r.heldUsd),
    availableUsd: available,
    exhausted: typeof r.exhausted === 'boolean' ? r.exhausted : null,
    contactEmail: str(r.contactEmail) ?? CONTACT_EMAIL,
    byCategory: { modelUsd: usd(by.modelUsd), outlayerUsd: usd(by.outlayerUsd), anchorUsd: usd(by.anchorUsd) },
    nearUsdRate: rateVal ? { rate: rateVal, date: str(rate?.date) } : null,
    proofEstimateUsd: usd(r.proofEstimateUsd),
    entries: (Array.isArray(r.entries) ? r.entries : []).map((e, i) => {
      const x = obj(e);
      return {
        id: str(x.id) ?? `e${i}`,
        kind: str(x.kind) ?? 'unknown',
        category: str(x.category),
        amountUsd: usd(x.amountUsd),
        refKind: str(x.refKind),
        refId: str(x.refId),
        detail: x.detail && typeof x.detail === 'object' && !Array.isArray(x.detail) ? (x.detail as R) : null,
        createdAt: str(x.createdAt),
      };
    }),
  };
}

/** Pill text and tone: "$2.97 / $3.00" with available rounded down, warn under 10% left, "unknown" when not loaded. */
export function pillState(c: Credits | undefined | null): { text: string; tone: '' | 'warn' | 'bad' } {
  if (!c || !c.known || c.allowanceUsd === null) return { text: 'unknown', tone: '' };
  const text = `${formatUsdExact(c.availableUsd)} / ${formatUsdExact(c.allowanceUsd)}`;
  if (c.exhausted === true) return { text, tone: 'bad' };
  return { text, tone: isLow(c.availableUsd, c.allowanceUsd) ? 'warn' : '' };
}

/** Category label for a ledger row. */
export const CATEGORY_LABEL: Record<string, string> = { model: 'AI model', outlayer: 'OutLayer proof', anchor: 'Publication anchor', grant: 'Allowance' };

const DIGITS = /^\d+$/;
/** Secondary NEAR detail of an on-chain entry: amount and the rate used, only what the entry carries. */
export function entryNearDetail(
  e: { detail: Record<string, unknown> | null },
  formatNear: (yocto: string) => string,
): { near: string | null; rate: string | null; rateDate: string | null } {
  const d = e.detail ?? {};
  const charged = typeof d.chargedYocto === 'string' && DIGITS.test(d.chargedYocto) ? BigInt(d.chargedYocto) : null;
  const burnt = typeof d.tokensBurntYocto === 'string' && DIGITS.test(d.tokensBurntYocto) ? BigInt(d.tokensBurntYocto) : null;
  const total = charged === null && burnt === null ? null : (charged ?? 0n) + (burnt ?? 0n);
  const rate = typeof d.nearUsdRate === 'number' && Number.isFinite(d.nearUsdRate) ? String(d.nearUsdRate) : str(d.nearUsdRate);
  return { near: total === null ? null : formatNear(total.toString()), rate, rateDate: str(d.rateDate) };
}
