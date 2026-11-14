/** View model for the result of `POST /v1/theses/:id/verify`. */
export type VerifyCheck = { name: string; ok: boolean; detail: string | null };
export type VerifyView = {
  outcome: 'verified' | 'mismatch' | 'unknown';
  passed: number;
  failed: number;
  checks: VerifyCheck[];
  summary: string;
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

export function verifyView(raw: unknown): VerifyView {
  const checks: VerifyCheck[] = [];
  if (isRec(raw) && Array.isArray(raw.checks)) {
    for (const c of raw.checks) {
      if (!isRec(c) || typeof c.name !== 'string') continue;
      checks.push({ name: c.name, ok: c.ok === true, detail: typeof c.detail === 'string' && c.detail ? c.detail : null });
    }
  }
  const failed = checks.filter((c) => !c.ok).length;
  const passed = checks.length - failed;
  const o = isRec(raw) ? raw.outcome : null;
  // The outcome is the API's word; a "verified" with a failed check is not shown as verified.
  const outcome: VerifyView['outcome'] = o === 'verified' && failed === 0 ? 'verified' : o === 'mismatch' || (o === 'verified' && failed > 0) ? 'mismatch' : 'unknown';
  const summary =
    outcome === 'verified'
      ? `Verified: all ${passed} ${passed === 1 ? 'check' : 'checks'} passed.`
      : outcome === 'mismatch'
        ? `Mismatch: ${failed} of ${checks.length} ${checks.length === 1 ? 'check' : 'checks'} failed.`
        : 'The result could not be read (unknown).';
  return { outcome, passed, failed, checks, summary };
}

/** Readable check names: "documentHash" and "chart_data_hash" become words. */
export function checkLabel(name: string): string {
  const s = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').trim().toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : 'Check';
}
