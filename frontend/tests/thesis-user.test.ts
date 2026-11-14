import { describe, expect, it } from 'vitest';
import { normalizeDoc, testRows, brief } from '@/lib/thesis/doc';
import { groupTheses, normalizeList, normalizeReceipts, receiptParts, receiptsShort, receiptsText, referenceSummary, REFERENCE_ID } from '@/lib/thesis/list';
import { checkLabel, verifyView } from '@/lib/thesis/verify';
import { safeNextPath } from '@/lib/auth/next-path';
import { plainLabel, plainUnit, stripRefs, readableCorrelation, readableNumber, stripStatusPrefix } from '@/lib/thesis/display';
import { cell, rerunView } from '@/lib/thesis/rerun';
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
    expect(keyTiles(d).map((t) => t.value)).toEqual(['64', '0.520', '0.310', '2026-01-01 to 2026-03-05']);
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

const R0 = { verified: 0, reproduced: 0, drift: 0, different: 0, incomplete: 0, mismatch: 0 };
describe('receipts text', () => {
  it('formats the strip and the card line, hiding zero buckets except verified and reproduced', () => {
    expect(receiptsText({ ...R0, verified: 2, reproduced: 1, drift: 1 })).toBe('verified 2 · reproduced 1 · drift 1');
    expect(receiptsText({ ...R0, verified: 1 })).toBe('verified 1 · reproduced 0');
    expect(receiptsText(R0)).toBe('Not verified or reproduced yet');
    expect(receiptsShort({ ...R0, verified: 4, reproduced: 2, drift: 1 })).toBe('verified 4 · reproduced 2 · drift 1');
    expect(receiptsText({ ...R0, verified: 1, incomplete: 2, different: 1, mismatch: 3 })).toBe('verified 1 · reproduced 0 · incomplete 2 · different 1 · mismatch 3');
  });
  it('shows a non-zero mismatch or different in a warning tone', () => {
    const parts = receiptParts({ ...R0, verified: 1, drift: 1, different: 1, mismatch: 1 });
    expect(parts.filter((p) => p.warn).map((p) => p.text)).toEqual(['different 1', 'mismatch 1']);
    expect(receiptParts({ ...R0, verified: 1, drift: 2 }).some((p) => p.warn)).toBe(false);
  });
  it('counts from records or reads the counts object, tolerating missing keys', () => {
    expect(normalizeReceipts([{ kind: 'verify', outcome: 'verified' }, { kind: 'reproduce', outcome: 'drift' }])).toEqual({ ...R0, verified: 1, reproduced: 1, drift: 1 });
    expect(normalizeReceipts({ verified: '3', reproduced: -1 })).toEqual({ ...R0, verified: 3 });
    expect(normalizeReceipts({ verified: 2, reproduced: 1, drift: 1, different: 1, incomplete: 4, mismatch: 5 })).toEqual({ verified: 2, reproduced: 1, drift: 1, different: 1, incomplete: 4, mismatch: 5 });
    expect(normalizeReceipts(null)).toEqual(R0);
  });
});

describe('readable numbers and plain labels', () => {
  it('rounds to 4 significant digits below 1, 2 decimals above, separators for large values', () => {
    expect(readableNumber('0.0553293749')).toBe('0.05533');
    expect(readableNumber('0.98924266')).toBe('0.9892');
    expect(readableNumber('42.2817')).toBe('42.28');
    expect(readableNumber('1234567.891')).toBe('1,234,567.89');
    expect(readableNumber('-0.000123456')).toBe('-0.0001235');
  });
  it('never changes integers, dates, hashes or ids', () => {
    expect(readableNumber('64')).toBe('64');
    expect(readableNumber(1217209)).toBe('1,217,209');
    expect(readableNumber('2026-09-13')).toBe('2026-09-13');
    expect(readableNumber('8c81e652babba8da5106bf2910ad11a2')).toBe('8c81e652babba8da5106bf2910ad11a2');
    expect(readableNumber('b1afae0d-67c3-445f-ae16-6f162d77d6f5')).toBe('b1afae0d-67c3-445f-ae16-6f162d77d6f5');
    expect(readableNumber(null)).toBe('unknown');
  });
  it('shows correlations to 3 decimals', () => {
    expect(readableCorrelation('0.294836')).toBe('0.295');
    expect(readableCorrelation('-0.1')).toBe('-0.100');
    expect(readableCorrelation('0.5')).toBe('0.500');
  });
  it('maps technical labels to plain ones and keeps the technical name', () => {
    expect(plainLabel('Baseline MAE, horizon 1 days', 'MAE, log scale').label).toBe('Baseline MAE, horizon 1 days');
    expect(stripRefs('Rule [rule.json#/a][rule.json#/b] holds.')).toBe('Rule holds.');
    expect(plainUnit('MAE, log scale')).toEqual({ label: 'Forecast error (lower is better)', technical: 'MAE, log scale' });
    expect(plainLabel('Same-day Pearson correlation').label).toBe('How closely they move together on the same day (−1 to 1)');
    expect(plainLabel('Pearson correlation at a lag of 7 days')).toEqual({ label: "How closely this week's first series tracks next week's second (−1 to 1)", technical: 'Pearson correlation at a lag of 7 days' });
    expect(plainLabel('Origins scored, horizon 1 days')).toEqual({ label: 'Origins scored, horizon 1 days', technical: null });
  });
  it('strips a duplicated status prefix from the headline', () => {
    expect(stripStatusPrefix('SUPPORTED: SUPPORTED: they move together.', 'SUPPORTED')).toBe('they move together.');
    expect(stripStatusPrefix('INSUFFICIENT_DATA: the frozen results', 'INSUFFICIENT_DATA')).toBe('the frozen results');
    expect(stripStatusPrefix('Note: something', 'MIXED')).toBe('Note: something');
    expect(stripStatusPrefix(null)).toBeNull();
  });
  it('workspace tiles carry plain labels and exact values for tooltips', () => {
    const t = keyTiles(normalizeDoc(workspace)!);
    expect(t[1]).toMatchObject({ label: 'How closely they move together on the same day (−1 to 1)', value: '0.520', exact: '0.52' });
    expect(t[3]).toMatchObject({ label: 'Window' });
  });
  it('reference tiles read as forecast error, not raw decimals', () => {
    const t = keyTiles(normalizeDoc(reference)!);
    expect(t[0]).toMatchObject({ value: '0.05533', exact: '0.0553293749', hint: 'Forecast error (lower is better)', sub: 'MAE, log scale' });
  });
});

describe('rerun result view model', () => {
  const rows = [
    { what: 'Same-day correlation', original: '0.294836', reproduced: '0.294836', delta: '0' },
    { what: 'Aligned days', original: '60', reproduced: '61', delta: '1' },
    { what: 'Verdict', original: 'MIXED', reproduced: 'SUPPORTED', delta: null },
    { what: 'Row without delta', original: '5', reproduced: '5', delta: null },
  ];
  const base = { rows, reran: { charts: 4, queries: 5, at: '2026-11-14T10:00:00Z', window: { from: '2026-09-13', to: '2026-11-11' } }, unavailable: [], receiptId: 'r1' };
  it('says each of the four outcomes in plain words', () => {
    expect(rerunView({ ...base, outcome: 'match' })).toMatchObject({ banner: 'Every number came out the same', tone: 'ok' });
    expect(rerunView({ ...base, outcome: 'drift' })).toMatchObject({ banner: 'Same verdict, some numbers moved since this was frozen', tone: 'warn' });
    expect(rerunView({ ...base, outcome: 'different' })).toMatchObject({ banner: 'The verdict or the sample changed', tone: 'bad' });
    expect(rerunView({ ...base, outcome: 'incomplete' })).toMatchObject({ banner: 'Some queries could not be re-run', tone: 'warn' });
    expect(rerunView({ ...base, outcome: 'weird' }).outcome).toBe('unknown');
  });
  it('folds unchanged rows away from the changed ones', () => {
    const v = rerunView({ ...base, outcome: 'drift' });
    expect(v.changed.map((r) => r.what)).toEqual(['Aligned days', 'Verdict']);
    expect(v.unchanged.map((r) => r.what)).toEqual(['Same-day correlation', 'Row without delta']);
  });
  it('keeps unavailable queries with reasons, when and the window', () => {
    const v = rerunView({ ...base, outcome: 'incomplete', unavailable: [{ chart: 'Swaps', reason: 'table missing' }, { chart: 'Other' }] });
    expect(v.unavailable).toEqual([{ chart: 'Swaps', reason: 'table missing' }, { chart: 'Other', reason: null }]);
    expect(v).toMatchObject({ ranAt: '2026-11-14T10:00:00Z', window: { from: '2026-09-13', to: '2026-11-11' }, charts: 4, queries: 5, receiptId: 'r1' });
  });
  it('shows cells readably with the exact value kept, correlations to 3 decimals', () => {
    expect(cell('0.0553293749')).toEqual({ text: '0.05533', exact: '0.0553293749' });
    expect(cell('0.294836', 'Same-day Pearson correlation').text).toBe('0.295');
    expect(cell(null)).toEqual({ text: 'unknown', exact: undefined });
  });
  it('an unreadable result is unknown, not a match', () => {
    expect(rerunView(null)).toMatchObject({ outcome: 'unknown', changed: [], unchanged: [], ranAt: null });
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
