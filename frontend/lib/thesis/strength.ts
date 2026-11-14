/**
 * Thesis strength: a deterministic score the server computes (`strength` on the thesis summary). The client only reads
 * and presents it. Missing points are explained from each part's own detail; nothing is estimated here.
 */

export type Band = 'thin' | 'fair' | 'solid' | 'strong';
export type StrengthPart = { key: string; label: string; points: number; max: number; detail: string | null };
export type Strength = { score: number; band: Band | null; parts: StrengthPart[] };

type R = Record<string, unknown>;
const isRec = (v: unknown): v is R => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const BANDS: readonly Band[] = ['thin', 'fair', 'solid', 'strong'];

/** Null when the API sent no usable score: the meter is then hidden. A score without a band is kept with an unknown band. */
export function normalizeStrength(raw: unknown): Strength | null {
  if (!isRec(raw)) return null;
  const score = finite(raw.score);
  if (score === null) return null;
  const parts: StrengthPart[] = [];
  if (Array.isArray(raw.parts)) {
    for (const p of raw.parts) {
      if (!isRec(p)) continue;
      const points = finite(p.points);
      const max = finite(p.max);
      const label = typeof p.label === 'string' && p.label.trim() ? p.label.trim() : typeof p.key === 'string' ? p.key : null;
      if (points === null || max === null || max < 0 || !label) continue;
      parts.push({ key: typeof p.key === 'string' ? p.key : label, label, points: Math.max(0, Math.min(points, max)), max, detail: typeof p.detail === 'string' && p.detail.trim() ? p.detail.trim() : null });
    }
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), band: BANDS.find((b) => b === raw.band) ?? null, parts };
}

export type Tone = 'bad' | 'warn' | 'info' | 'ok' | '';
export const BAND_TONE: Record<Band, Tone> = { thin: 'bad', fair: 'warn', solid: 'info', strong: 'ok' };
export const bandTone = (b: Band | null): Tone => (b ? BAND_TONE[b] : '');
export const bandWord = (b: Band | null): string => b ?? 'unknown';

export type PartView = StrengthPart & { full: boolean; missing: number; explain: string };

/** A part as a checklist row: full points say so, missing points say how many and why. */
export function partView(p: StrengthPart): PartView {
  const missing = Math.max(0, p.max - p.points);
  const full = missing === 0;
  const why = p.detail ?? 'No reason was given.';
  return { ...p, full, missing, explain: full ? (p.detail ?? 'Full points.') : `${missing} of ${p.max} ${p.max === 1 ? 'point' : 'points'} missing: ${why}` };
}

export type StrengthView = { score: number; band: Band | null; word: string; tone: Tone; parts: PartView[]; missingTotal: number; summary: string };

export function strengthView(s: Strength): StrengthView {
  const parts = s.parts.map(partView);
  const missingTotal = parts.reduce((n, p) => n + p.missing, 0);
  return {
    score: s.score,
    band: s.band,
    word: bandWord(s.band),
    tone: bandTone(s.band),
    parts,
    missingTotal,
    summary: `Strength ${s.score} out of 100, ${bandWord(s.band)}${parts.length ? `. ${missingTotal === 0 ? 'Every check passed.' : `${missingTotal} points missing across ${parts.filter((p) => !p.full).length} checks.`}` : '.'}`,
  };
}
