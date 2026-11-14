import { describe, expect, it } from 'vitest';
import { normalizeDoc, testRows, brief } from '@/lib/thesis/doc';
import { groupTheses, normalizeList, normalizeReceipts, receiptsShort, receiptsText, referenceSummary, REFERENCE_ID } from '@/lib/thesis/list';
import { checkLabel, verifyView } from '@/lib/thesis/verify';
import { safeNextPath } from '@/lib/auth/next-path';
import { keyTiles } from '@/components/nx/thesis-track/thesis-view';

// Shaped like thesis/build/thesis.json (schema nearesis.thesis.v1), trimmed.
const reference = {
  schema: 'nearesis.thesis.v1',
  version: 'v3-abc',
  generatedAt: '2026-11-14T05:56:17.206Z',
  hypothesis: 'Cross-chain volume through NEAR Intents leads usage better than price.',
  verdict: {
    status: 'INSUFFICIENT_DATA',
    headline: 'Not enough data to call it.',
    intentsVsPrice: { summary: 'Baseline versus candidates.', rows: [{ label: 'Baseline MAE, horizon 1 days', value: '0.0553293749', unit: 'MAE, log scale', ref: 'results/estimates.json#/x' }, { label: 'no value', value: null }] },
    whatWouldChangeOurMind: ['A longer window.'],
  },
  sections: [{ id: 'evidence-for', title: 'Evidence for', markdown: 'x' }, { notId: 1 }],
  claims: [{ id: 'c1', statement: 'S', verdict: 'MIXED' }, { statement: '' }],
  charts: [{ id: 'ch1', title: 'T', kind: 'line', x: ['d1', 'd2'], series: [{ name: 's', values: ['1', null] }], sha256: 'abc', queries: [{ sqlExecuted: 'SELECT 1' }] }],
  tables: [], sampleQuery: { title: 'q', sql: 'SELECT 1' }, unableToCompute: [{ what: 'w', why: 'y' }],
  reproduce: { command: 'pnpm thesis:build', check: 'pnpm thesis:verify', hashes: [{ path: 'a', sha256: 'b' }] }, files: [],
};

// Written from the contract: a workspace thesis with origin, test, verification, comparison, monitors, markers.
const workspace = {
  ...reference,
  origin: { kind: 'workspace', workspaceId: 'w1', runId: 'r1', capsuleId: 'c1', capsuleHash: 'h', hypothesisId: null },
  verdict: { status: 'MIXED', headline: 'Moves together on the same day.', comparison: { summary: 'S', rows: [{ label: 'n', value: 64 }] }, whatWouldChangeOurMind: [] },
  test: { rule: 'relationship-v1', x: { label: 'Intents volume' }, y: 'Active accounts', n: 64, window: { from: '2026-01-01', to: '2026-03-05' }, pearson: 0.52, lag: [{ days: 7, value: '0.31' }], thresholds: { minDays: 60, sameDay: 0.5, lag: { minAbs: 0.3 } } },
  verification: { capsule: { status: 'verified', checkedAt: '2026-11-14T00:00:00Z' }, outlayer: { status: 'proved', requestId: 'req', txHash: 'tx1' } },
  monitors: [{ name: 'Volume drop', threshold: 3 }], markers: ['Launch day'],
};

describe('thesis document normalizer', () => {
  it('reads the reference document and drops malformed items', () => {
    const d = normalizeDoc(reference)!;
    expect(d.verdict?.status).toBe('INSUFFICIENT_DATA');
    expect(d.verdict?.intentsVsPrice?.rows).toHaveLength(2);
    expect(d.verdict?.intentsVsPrice?.rows?.[1]?.value).toBeNull();
    expect(d.sections).toHaveLength(1);
    expect(d.claims).toHaveLength(1);
    expect(d.charts?.[0]?.series?.[0]?.values).toEqual(['1', null]);
    expect(d.origin).toBeNull();
  });
  it('reads a workspace thesis: test, verification, comparison, briefs', () => {
    const d = normalizeDoc(workspace)!;
    expect(d.verdict?.comparison?.rows?.[0]).toMatchObject({ label: 'n', value: '64' });
    expect(d.test).toMatchObject({ rule: 'relationship-v1', x: 'Intents volume', y: 'Active accounts', n: 64, pearson: '0.52' });
    expect(d.test?.thresholds).toEqual([{ key: 'min days', value: '60' }, { key: 'same day', value: '0.5' }, { key: 'lag min abs', value: '0.3' }]);
    expect(d.verification?.outlayer?.txHash).toBe('tx1');
    expect(d.monitors).toEqual([{ title: 'Volume drop', lines: ['threshold: 3'] }]);
    expect(d.markers).toEqual([{ title: 'Launch day', lines: [] }]);
    expect(testRows(d.test).map((r) => r.label)).toEqual(['Aligned days (n)', 'Window', 'Same-day correlation (Pearson)', 'Correlation at 7-day lag']);
    expect(keyTiles(d).map((t) => t.value)).toEqual(['64', '0.52', '0.31']);
  });
  it('rejects non-documents and keeps unknown as null', () => {
    expect(normalizeDoc(null)).toBeNull();
    expect(normalizeDoc({ schema: 'other' })).toBeNull();
    expect(testRows(normalizeDoc({ ...workspace, test: { rule: 'r' } })!.test)[0]).toEqual({ label: 'Same-day correlation (Pearson)', value: 'unknown' });
    expect(brief({})).toBeNull();
  });
  it('tiles for the reference come from the first comparison rows', () => {
    expect(keyTiles(normalizeDoc(reference)!)).toHaveLength(2);
  });
});

describe('thesis list view model', () => {
  const items = normalizeList({
    items: [
      { id: 'a', hypothesis: 'A', verdict: { status: 'SUPPORTED', headline: 'h' }, kind: 'workspace', workspaceId: 'w1', version: 'v1', status: 'published', shareSlug: 's1', updatedAt: '2026-01-02', receipts: { verified: 4, reproduced: 2, drift: 1 } },
      { id: 'b', hypothesis: 'B', verdict: 'MIXED', kind: 'workspace', status: 'draft', shareSlug: null, updatedAt: '2026-01-03' },
      { id: 'c', kind: 'imported', hypothesis: 'C', updatedAt: '2026-01-01' },
      { id: REFERENCE_ID, kind: 'reference', hypothesis: 'R' },
      { nope: true },
    ],
  });
  it('groups reference, mine (newest first) and opened', () => {
    const g = groupTheses(items);
    expect(g.reference?.id).toBe(REFERENCE_ID);
    expect(g.mine.map((i) => i.id)).toEqual(['b', 'a']);
    expect(g.opened.map((i) => i.id)).toEqual(['c']);
    expect(items.find((i) => i.id === 'a')).toMatchObject({ published: true, verdictStatus: 'SUPPORTED', headline: 'h' });
    expect(items.find((i) => i.id === 'b')).toMatchObject({ published: false, verdictStatus: 'MIXED' });
  });
  it('uses the reference built from the legacy document when the list lacks it', () => {
    const ref = referenceSummary(normalizeDoc(reference)!);
    expect(groupTheses([], ref).reference?.hypothesis).toContain('NEAR Intents');
  });
});

describe('receipts text', () => {
  it('formats the strip and the card line', () => {
    expect(receiptsText({ verified: 4, reproduced: 2, drift: 1 })).toBe('verified 4 times · reproduced 2 · 1 drift');
    expect(receiptsText({ verified: 1, reproduced: 0, drift: 0 })).toBe('verified 1 time · reproduced 0 · 0 drift');
    expect(receiptsText({ verified: 0, reproduced: 0, drift: 0 })).toBe('Not verified or reproduced yet');
    expect(receiptsShort({ verified: 4, reproduced: 2, drift: 1 })).toBe('verified 4 · reproduced 2 · drift 1');
  });
  it('counts from records or reads the counts object', () => {
    expect(normalizeReceipts([{ kind: 'verify', outcome: 'verified' }, { kind: 'reproduce', outcome: 'drift' }])).toEqual({ verified: 1, reproduced: 1, drift: 1 });
    expect(normalizeReceipts({ verified: '3', reproduced: -1 })).toEqual({ verified: 3, reproduced: 0, drift: 0 });
    expect(normalizeReceipts(null)).toEqual({ verified: 0, reproduced: 0, drift: 0 });
  });
});

describe('verify result view model', () => {
  it('shows verified only when every check passed', () => {
    const v = verifyView({ outcome: 'verified', checks: [{ name: 'documentHash', ok: true, detail: 'abc' }, { name: 'chart_data_hash', ok: true }] });
    expect(v).toMatchObject({ outcome: 'verified', passed: 2, failed: 0 });
    expect(v.summary).toBe('Verified: all 2 checks passed.');
  });
  it('a mismatch lists the failures, and a lying verified is not trusted', () => {
    const v = verifyView({ outcome: 'verified', checks: [{ name: 'a', ok: true }, { name: 'b', ok: false, detail: 'hash differs' }] });
    expect(v.outcome).toBe('mismatch');
    expect(v.summary).toBe('Mismatch: 1 of 2 checks failed.');
    expect(v.checks[1]).toEqual({ name: 'b', ok: false, detail: 'hash differs' });
  });
  it('unreadable input is unknown', () => {
    expect(verifyView(null).outcome).toBe('unknown');
    expect(checkLabel('documentHash')).toBe('Document hash');
    expect(checkLabel('chart_data_hash')).toBe('Chart data hash');
  });
});

describe('safe next path', () => {
  it('keeps same-origin paths', () => {
    expect(safeNextPath('/thesis/import/abc')).toBe('/thesis/import/abc');
    expect(safeNextPath('/w/1/overview?x=1#y')).toBe('/w/1/overview?x=1#y');
  });
  it('refuses everything else', () => {
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '\\\\evil', 'javascript:alert(1)', '/a\nb', '', null, undefined, '/' + 'a'.repeat(700)]) {
      expect(safeNextPath(bad as string | null)).toBe('/home');
    }
    expect(safeNextPath('//x', '/thesis')).toBe('/thesis');
  });
});
