import { describe, expect, it } from 'vitest';
import { normalizeDoc } from '@/lib/thesis/doc';
import { normalizeStrength } from '@/lib/thesis/strength';
import {
  COVER_NOTE,
  citeParts,
  coverFields,
  coverLabel,
  documentTiles,
  firstEvidence,
  lockLine,
  parseEvidence,
  planView,
  publicDocHref,
  sectionNumber,
  sectionPlan,
  shortClaim,
  shortThesisId,
  thesisDocHref,
  thesisFlowHref,
  thesisPdfFilename,
  whyVerdict,
  chartView,
  type DocMeta,
} from '@/lib/thesis/document';

const strength = normalizeStrength({ score: 72, band: 'solid', parts: [{ key: 'a', label: 'A', max: 10, points: 10, detail: 'ok' }] });
const meta = (o: Partial<DocMeta> = {}): DocMeta => ({ id: 'cd4dd63d-7969-4e91-9801-a287bbd4511f', kind: 'workspace', owner: 'me', strength, receipts: null, challenges: [], published: false, ...o });

const FOR = `- The correlation of changes 0.7 has the same sign. [1][2]
- The series share 90 aligned days. [3]
Findings are matched by shared words; this is a heuristic.`;
const AGAINST = `- Heuristic phrase match: 1 finding(s) say there is no association, which cuts against the verdict. [1]
- The level correlation 0.39 is below 0.5. [2]
> Finding (mixed, observation): A coincident spike, not a general association. [3]
- Cited value: 54920 swaps (a) [4]
- Cited value: 0.58 ratio (b) [5]
**Coverage**
> Skeptic note: The panel is partial. [6]
> Limitation recorded with a finding: Source current to 11-14. [7]
- 5 more coverage notes in the capsule (findings.json). [8]
**Causation**
> Skeptic note: Correlation is not causation. [9]`;

const v2 = normalizeDoc({
  schema: 'nearesis.thesis.v1',
  version: 'v-abc',
  generatedAt: '2026-11-14T09:26:41Z',
  hypothesis: 'Days with more transactions have more active accounts.',
  verdict: { status: 'NOT_SUPPORTED', headline: 'NOT_SUPPORTED: over 120 days the correlation is 0.198', whatWouldChangeOurMind: ['A longer window.'] },
  test: {
    rule: 'relationship-v2',
    n: 120,
    window: { from: '2026-07-14', to: '2026-11-10' },
    level: { value: '0.198484' },
    change: { value: '0.013475' },
    spearman: { value: '0.1' },
    interval: { lo: '-0.175', hi: '0.452', levelPercent: 95, method: 'moving-block bootstrap' },
    reasons: ['LEVEL_BELOW_SUPPORT', 'INTERVAL_INCLUDES_ZERO'],
    plan: { statement: 'Days with more tx have more accounts.', lockedAt: '2026-11-14T09:25:00Z', sha256: 'abcdef0123456789ffff', chosenBy: 'rule', relation: 'moves_with', expectedSign: 'positive', x: { label: 'Daily tx' }, y: { label: 'Daily accounts' }, wouldCountAsWrong: 'If the interval is on the negative side.' },
  },
  sections: [
    { id: 'evidence-for', title: 'Evidence for', markdown: FOR, references: ['a', 'b', 'c'] },
    { id: 'evidence-against', title: 'Evidence against', markdown: AGAINST, references: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
  ],
  claims: [{ id: 'c1', statement: 'A claim', verdict: 'MIXED' }],
  charts: [{ id: 'p1', title: 'Chart', kind: 'line', x: ['d1', 'd2', 'd3'], series: [{ name: 'a', values: ['1', null, '3'] }, { name: 'b', values: ['5', '6', '7'] }], primary: 'b', source: 'LIVE', window: { from: 'd1', to: 'd3' } }],
  verification: { capsule: { status: 'reproduced' }, outlayer: { status: 'verified', requestId: '1', txHash: 'HASH' } },
});

const v1 = normalizeDoc({
  schema: 'nearesis.thesis.v1',
  hypothesis: 'v1 claim',
  verdict: { status: 'MIXED', headline: 'MIXED: x' },
  test: { rule: 'relationship-v1', n: 60, pearson: '0.294836', lag: [{ days: 7, value: '0.17' }], window: { from: '2026-09-13', to: '2026-11-11' } },
  sections: [],
});

const ref = normalizeDoc({
  schema: 'nearesis.thesis.v1',
  hypothesis: 'Reference claim',
  verdict: { status: 'INSUFFICIENT_DATA', headline: 'x', intentsVsPrice: { rows: [{ label: 'Baseline MAE', value: '0.0553', unit: 'MAE' }, { label: 'With Intents', value: '0.0570', unit: 'MAE' }] } },
  sections: [{ id: 'evidence-for', title: 'Evidence for', markdown: '- one' }],
});

describe('links and file names', () => {
  it('opens the document view, keeps the flow viewer, links the public pair', () => {
    expect(thesisDocHref('cd4dd63d-7969')).toBe('/thesis/cd4dd63d-7969/document');
    expect(thesisFlowHref('a b')).toBe('/thesis/a%20b');
    expect(publicDocHref('slug1')).toBe('/t/slug1/document');
  });
  it('names the pdf by short id and date', () => {
    expect(thesisPdfFilename('cd4dd63d-7969-4e91-9801-a287bbd4511f', new Date('2026-11-14T10:00:00Z'))).toBe('nearesis-thesis-cd4dd63d-2026-11-14.pdf');
    expect(shortThesisId('reference-near-intents')).toBe('reference-near-intents');
    expect(thesisPdfFilename('reference-near-intents', new Date('2026-11-14T00:00:00Z'))).toBe('nearesis-thesis-reference-near-intents-2026-11-14.pdf');
  });
  it('shortens the claim for the PDF header', () => {
    expect(shortClaim('x'.repeat(100)).length).toBe(70);
    expect(shortClaim(undefined)).toBe('Thesis');
  });
});

describe('cover', () => {
  it('has the six fields and the lock line with a short fingerprint', () => {
    const f = coverFields(v2!, meta());
    expect(f.map((x) => x.label)).toEqual(['Generated', 'Owner', 'Data window', 'Days compared', 'Version', 'Thesis id']);
    expect(f.find((x) => x.key === 'window')!.value).toBe('2026-07-14 to 2026-11-10');
    expect(f.find((x) => x.key === 'days')!.value).toBe('120');
    expect(lockLine(v2!)).toEqual({ text: 'Test plan locked 2026-11-14 09:25 UTC, before the data was seen', fingerprint: 'abcdef012345' });
    expect(lockLine(v1!)).toBeNull();
    expect(COVER_NOTE).toMatch(/stored result cell/);
  });
  it('says unknown, never zero, and labels the reference', () => {
    const f = coverFields(ref!, meta({ kind: 'reference', owner: null, id: 'reference-near-intents' }));
    expect(f.find((x) => x.key === 'days')!.value).toBe('unknown');
    expect(f.find((x) => x.key === 'window')!.value).toBe('unknown');
    expect(f.find((x) => x.key === 'owner')!.value).toBe('Nearesis (reference)');
    expect(coverLabel({ kind: 'reference' })).toBe('Reference thesis');
    expect(coverLabel({ kind: 'workspace' })).toBe('Thesis');
  });
});

describe('summary tiles', () => {
  it('v2: verdict, days, level with interval, change, rank, strength', () => {
    const t = documentTiles(v2!, strength);
    expect(t.map((x) => x.label)).toEqual(['Verdict', 'Days compared', 'Level correlation', 'Change correlation', 'Rank correlation', 'Strength']);
    expect(t[2]!.value).toBe('0.198');
    expect(t[2]!.exact).toBe('0.198484');
    expect(t[2]!.sub).toContain('95% interval -0.175 to 0.452');
    expect(t[5]!.value).toBe('72 / 100');
  });
  it('v1: the numbers that exist, no invented interval', () => {
    const t = documentTiles(v1!, null);
    expect(t.map((x) => x.label)).toEqual(['Verdict', 'Days compared', 'Same-day correlation', 'Correlation at 7-day lag', 'Window']);
    expect(t.some((x) => /interval|Change|Rank/.test(x.label))).toBe(false);
  });
  it('reference: its comparison rows', () => {
    const t = documentTiles(ref!, null);
    expect(t.map((x) => x.value)).toEqual(['INSUFFICIENT DATA', '0.0553', '0.057']);
  });
  it('explains the verdict in plain words', () => {
    expect(whyVerdict(v2!)).toBe('The level correlation is below the level needed for support; the interval around the level correlation includes zero.');
    expect(whyVerdict(ref!)).toBeNull();
  });
});

describe('evidence', () => {
  it('puts the quoted contradicting finding first and attaches cited values to it', () => {
    const ev = parseEvidence(AGAINST, 'against');
    expect(ev.intro).toHaveLength(1);
    expect(ev.cards[0]!.contradicting).toBe(true);
    expect(ev.cards[0]!.chips.map((c) => c.text)).toEqual(['mixed', 'observation']);
    expect(ev.cards[0]!.cited).toEqual(['54920 swaps (a) [4]', '0.58 ratio (b) [5]']);
    expect(ev.cards[1]!.contradicting).toBe(false);
    expect(ev.cards).toHaveLength(2);
  });
  it('groups skeptic notes and keeps the "n more notes" line', () => {
    const ev = parseEvidence(AGAINST, 'against');
    expect(ev.groups.map((g) => g.label)).toEqual(['Coverage', 'Causation']);
    expect(ev.groups[0]!.notes).toEqual(['The panel is partial. [6]', 'Limitation: Source current to 11-14. [7]']);
    expect(ev.groups[0]!.more[0]).toMatch(/^5 more coverage notes in the capsule/);
  });
  it('for-section: statements as cards, trailing sentence as a note', () => {
    const ev = parseEvidence(FOR, 'for');
    expect(ev.cards).toHaveLength(2);
    expect(ev.notes[0]).toMatch(/heuristic/);
    expect(firstEvidence(ev, 1)).toEqual(['The correlation of changes 0.7 has the same sign.']);
  });
  it('a missing section is empty, never invented', () => {
    expect(parseEvidence(null, 'for').cards).toEqual([]);
  });
  it('turns [n] into citations only when the section lists references', () => {
    expect(citeParts('A fact. [1][2]', true)).toEqual(['A fact.', 1, 2]);
    expect(citeParts('A fact [1].', false)).toEqual(['A fact [1].']);
  });
});

describe('sections', () => {
  it('numbers only the sections that are there', () => {
    const p = sectionPlan(v2!, meta());
    expect(p).toEqual(['summary', 'plan', 'for', 'against', 'charts', 'claims', 'mind', 'verification', 'reproduction', 'limits', 'sources']);
    expect(sectionNumber(p, 'summary')).toBe('01');
    expect(sectionNumber(p, 'sources')).toBe(String(p.length).padStart(2, '0'));
  });
  it('monitors, challenges and sources appear only with content', () => {
    const none = sectionPlan(v1!, meta());
    expect(none).not.toContain('monitors');
    expect(none).not.toContain('challenges');
    expect(none).not.toContain('sources');
    expect(none).not.toContain('plan');
    const withChallenge = sectionPlan(v1!, meta({ challenges: [{ id: 'c', outcome: 'holds', notes: [], droppedNotes: null, cost: { usd: null, modelCalls: null }, by: null, createdAt: null, answer: null }] }));
    expect(withChallenge).toContain('challenges');
    const withBriefs = sectionPlan({ ...v1!, monitors: [{ title: 'm', lines: [] }] }, meta());
    expect(withBriefs).toContain('monitors');
    expect(sectionPlan({ ...v1!, sections: [{ id: 'x', title: 'X', markdown: '', references: ['r'] }] }, meta())).toContain('sources');
  });
});

describe('plan and charts', () => {
  it('shows who chose the pair and warns when it was a rule', () => {
    const p = planView(v2!)!;
    expect(p.locked).toBe(true);
    expect(p.warnChosen).not.toBeNull();
    expect(p.lines.find((l) => l.label === 'First series')!.value).toBe('Daily tx');
    expect(p.lines.find((l) => l.label === 'Pair chosen by')!.value).toBe('a rule, not named in advance');
    expect(planView(ref!)).toBeNull();
  });
  it('draws the primary series and keeps a gap as null', () => {
    const c = chartView(v2!.charts![0]!);
    expect(c.series.map((s) => s.name)).toEqual(['b']);
    expect(c.hidden).toBe(1);
    const all = chartView({ ...v2!.charts![0]!, primary: undefined } as never);
    expect(all.series[0]!.points.map((p) => p.y)).toEqual([1, null, 3]);
    expect(c.tag.executed).toBe(false);
  });
});
