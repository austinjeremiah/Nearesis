import { describe, it, expect } from 'vitest';
import { normalizeTask } from '@/lib/agent/thread';
import { buildStages } from '@/lib/agent/storyboard';
import { diffDraft, draftErrors, fieldErrorsFrom, normalizeTestPlan, relationText, shortFingerprint, signText, toDraft, windowText } from '@/lib/agent/testplan';
import { markerReason, monitorReason, queryNoteFor, thresholdFromLine, whyLine } from '@/lib/agent/why';
import { agentFollowUpHref, createAndDigMessage, extractDates, followUpMessage, isFindingClaim, safeWorkspaceParam, COMPOSER_MAX } from '@/lib/agent/followups';
import { BAND_TONE, bandTone, normalizeStrength, partView, strengthView } from '@/lib/thesis/strength';
import { droppedText, groupNotes, needsAnswer, normalizeChallenge, normalizeChallenges } from '@/lib/thesis/challenge';
import { normalizeDoc } from '@/lib/thesis/doc';
import { normalizeList, normalizeReceipts, receiptParts, receiptsText } from '@/lib/thesis/list';

const PLAN = { statement: 'Daily swap volume moves with daily active wallets.', xLabel: 'Swap volume', yLabel: 'Active wallets', relation: 'leads', lagDays: 3, expectedSign: 'positive', windowDays: 90, wouldCountAsWrong: 'A correlation below zero over the window.', editedByUser: true, lockedAt: '2026-11-14T10:00:00.000Z', sha256: 'a'.repeat(64) };
const task = (over: Record<string, unknown> = {}) => normalizeTask({ id: 't', threadId: 'th', state: 'proposed', steps: [{ idx: 0, key: 'question.ask', title: 'Ask', why: 'It is the question you asked.' }], ...over });

describe('test plan normaliser', () => {
  it('reads a full plan', () => {
    const p = normalizeTestPlan(PLAN)!;
    expect(p).toMatchObject({ statement: PLAN.statement, relation: 'leads', lagDays: 3, expectedSign: 'positive', windowDays: 90, editedByUser: true, lockedAt: PLAN.lockedAt });
    expect(shortFingerprint(p.sha256)).toBe('aaaaaaaaaaaa');
  });
  it('keeps a plan with no statement (the user is asked to write it) and unknown fields as null', () => {
    const p = normalizeTestPlan({ statement: null, lockedAt: null })!;
    expect(p.statement).toBeNull();
    expect(p.xLabel).toBeNull();
    expect(p.lagDays).toBeNull();
    expect(p.editedByUser).toBe(false);
    expect(relationText(p)).toBe('unknown');
  });
  it('is null when the task has no test plan, and drops wrongly typed fields', () => {
    expect(normalizeTestPlan(undefined)).toBeNull();
    expect(normalizeTestPlan('x')).toBeNull();
    expect(task().testPlan).toBeNull();
    const p = normalizeTestPlan({ statement: 5, relation: 'bogus', lagDays: 'x', windowDays: '60', expectedSign: 'up' })!;
    expect(p).toMatchObject({ statement: null, relation: null, lagDays: null, windowDays: 60, expectedSign: null });
  });
  it('words the relation, direction and window', () => {
    expect(relationText({ relation: 'moves_with', lagDays: 0 })).toBe('moves with');
    expect(relationText({ relation: 'leads', lagDays: 1 })).toBe('leads by 1 day');
    expect(relationText({ relation: 'leads', lagDays: 7 })).toBe('leads by 7 days');
    expect(signText('either')).toBe('either direction');
    expect(signText(null)).toBe('unknown');
    expect(windowText(null)).toBe('unknown');
    expect(windowText(90)).toBe('90 days');
  });
  it('sends only the fields that changed, typed for the wire', () => {
    const p = normalizeTestPlan(PLAN)!;
    const d = toDraft(p);
    expect(diffDraft(p, d)).toEqual({});
    expect(diffDraft(p, { ...d, statement: ' A new sentence. ', windowDays: '120', relation: 'moves_with', expectedSign: 'either' })).toEqual({ statement: 'A new sentence.', windowDays: 120, relation: 'moves_with', expectedSign: 'either' });
    expect(diffDraft(p, { ...d, xLabel: '' })).toEqual({});
  });
  it('checks limits before sending and reads 422 field errors', () => {
    const p = normalizeTestPlan(PLAN)!;
    expect(draftErrors(toDraft(p))).toEqual({});
    expect(draftErrors({ ...toDraft(p), statement: 'x'.repeat(201) }).statement).toMatch(/200/);
    expect(draftErrors({ ...toDraft(p), statement: 'Up 5 percent' }).statement).toMatch(/numbers/);
    expect(draftErrors({ ...toDraft(p), windowDays: '10' }).windowDays).toMatch(/30 to 365/);
    expect(draftErrors({ ...toDraft(p), lagDays: '31' }).lagDays).toMatch(/0 to 30/);
    expect(fieldErrorsFrom([{ path: 'body.statement', issue: 'contains a causal word' }, { path: 'windowDays', issue: 'too short' }, { path: 'other', issue: 'x' }])).toEqual({ statement: 'contains a causal word', windowDays: 'too short' });
  });
  it('adds a first Test plan stage: pending until locked', () => {
    const open = buildStages(task({ testPlan: { ...PLAN, lockedAt: null, sha256: null } }));
    expect(open[0]).toMatchObject({ id: 'testplan', kind: 'testplan', state: 'waiting', stepIdxs: [] });
    const locked = buildStages(task({ state: 'running', testPlan: PLAN }));
    expect(locked[0]).toMatchObject({ kind: 'testplan', state: 'done' });
    expect(buildStages(task()).some((s) => s.kind === 'testplan')).toBe(false);
  });
  it('reads doc.test.plan of a thesis', () => {
    const doc = normalizeDoc({ schema: 'nearesis.thesis.v1', test: { n: 60, plan: { statement: 'S', relation: 'moves_with', lagDays: 0, expectedSign: 'either', lockedAt: '2026-11-14T10:00:00Z', sha256: 'f'.repeat(64), editedByUser: false, chosenBy: 'planner', resolved: { x: { panel: 'Swaps', column: 'n' }, y: 'Wallets' } } } })!;
    expect(doc.test?.plan).toMatchObject({ statement: 'S', chosenBy: 'planner', resolved: { x: 'Swaps (n)', y: 'Wallets' } });
    expect(normalizeDoc({ schema: 'nearesis.thesis.v1', test: { n: 3 } })!.test?.plan).toBeNull();
    expect(normalizeDoc({ schema: 'nearesis.thesis.v1', test: { plan: { chosenBy: 'x' } } })!.test?.plan?.chosenBy).toBeNull();
  });
});

describe('why and reasons', () => {
  it('reads why per step, null when absent', () => {
    const t = task({ steps: [{ idx: 0, key: 'a', title: 'A', why: 'Because.' }, { idx: 1, key: 'b', title: 'B' }, { idx: 2, key: 'c', title: 'C', why: '  ' }] });
    expect(t.steps.map((s) => s.why)).toEqual(['Because.', null, null]);
    expect(whyLine(t.steps[0]!)).toBe('Why: Because.');
    expect(whyLine(t.steps[1]!)).toBeNull();
  });
  const refsTask = task({
    steps: [{ idx: 0, key: 'setup.auto', title: 'S', state: 'done', result: { summary: '', items: [], refs: { markerReasons: [{ id: 'm1', reason: 'A jump.' }, { id: '', reason: 'x' }, { id: 'm2' }], monitorReasons: [{ id: 'r1', reason: 'Watches volume.', thresholdFrom: 'the 30-day mean' }, { id: 'r2', reason: 'Plain.' }], queryNotes: [{ panelTitle: 'Daily swaps', why: 'It is the series you named.' }, { panelTitle: 'x' }] } } }],
  });
  const refs = refsTask.steps[0]!.result!.refs;
  it('keeps only complete reasons and matches by id', () => {
    expect(refs.markerReasons).toEqual([{ id: 'm1', reason: 'A jump.' }]);
    expect(markerReason(refs, 'm1')).toBe('A jump.');
    expect(markerReason(refs, 'zz')).toBeNull();
    expect(monitorReason(refs, 'r1')).toEqual({ reason: 'Watches volume.', thresholdFrom: 'the 30-day mean' });
    expect(monitorReason(refs, 'r2')).toEqual({ reason: 'Plain.', thresholdFrom: null });
    expect(thresholdFromLine('the 30-day mean')).toBe('threshold taken from the 30-day mean');
    expect(thresholdFromLine(null)).toBeNull();
  });
  it('matches query notes on the panel title and gives nothing when there is none', () => {
    expect(queryNoteFor(refs, '  daily SWAPS ')).toBe('It is the series you named.');
    expect(queryNoteFor(refs, 'Other')).toBeNull();
    expect(queryNoteFor({}, 'Daily swaps')).toBeNull();
  });
  it('carries the reasons into the merged stage refs', () => {
    const st = buildStages(refsTask).find((s) => s.kind === 'markers')!;
    expect(markerReason(st.refs, 'm1')).toBe('A jump.');
    expect(st.why).toBeNull();
    expect(buildStages(task()).find((s) => s.kind === 'investigate')!.why).toBe('It is the question you asked.');
  });
});

describe('follow-up messages', () => {
  const st = 'Transactions reached a high of 1217209 on 2026-09-27, followed by 1129793 on 2026-09-28.';
  it('uses the contract wording', () => {
    expect(followUpMessage('dig', st)).toBe(`In this workspace, investigate what happened around 2026-09-27 and 2026-09-28: ${st}`);
    expect(followUpMessage('opposite', st)).toBe(`In this workspace, look for evidence against: ${st}`);
    expect(followUpMessage('extend', st)).toBe(`In this workspace, repeat this over the last 365 days: ${st}`);
  });
  it('extracts dates in the forms a finding uses, once each, at most three', () => {
    expect(extractDates('No date here.')).toEqual([]);
    expect(extractDates('On 3 March 2026 and again on March 9, 2026, then 2026-04-01 and 2026-04-01 and 2026-05-01 and 2026-06-01')).toEqual(['3 March 2026', 'March 9, 2026', '2026-04-01']);
    expect(followUpMessage('dig', 'Volume rose steadily.')).toBe('In this workspace, investigate what happened: Volume rose steadily.');
    expect(followUpMessage('dig', 'Peak on 3 Mar 2026.')).toContain('around 3 Mar 2026:');
    expect(followUpMessage('dig', 'A on 2026-01-01 then B on 2026-01-02 then C on 2026-01-03')).toContain('around 2026-01-01, 2026-01-02 and 2026-01-03:');
  });
  it('always fits the composer and collapses whitespace', () => {
    const long = 'x '.repeat(3000);
    for (const k of ['dig', 'opposite', 'extend'] as const) expect(followUpMessage(k, long).length).toBeLessThanOrEqual(COMPOSER_MAX);
    expect(followUpMessage('opposite', 'a\n  b')).toBe('In this workspace, look for evidence against: a b');
    expect(createAndDigMessage('x'.repeat(5000)).length).toBeLessThanOrEqual(COMPOSER_MAX);
  });
  it('builds the create-and-investigate wording and the Agent link', () => {
    expect(createAndDigMessage('Swaps fell.', 'NEAR Intents swap volume.')).toBe('Create a workspace for this: NEAR Intents swap volume. Investigate it and build the thesis.');
    expect(createAndDigMessage('Swaps fell.', '')).toBe('Create a workspace for this: Swaps fell. Investigate it and build the thesis.');
    expect(agentFollowUpHref('w-1', 'In this workspace, a: b')).toBe('/agent?w=w-1&q=In%20this%20workspace%2C%20a%3A%20b');
  });
  it('accepts only id-shaped workspace params and only finding-like claims', () => {
    expect(safeWorkspaceParam('2e51e448-f16e-4212-9c9e-76dd29ae3547')).toBe('2e51e448-f16e-4212-9c9e-76dd29ae3547');
    expect(safeWorkspaceParam('../x')).toBeNull();
    expect(safeWorkspaceParam(undefined)).toBeNull();
    expect(safeWorkspaceParam(['a1', 'b'])).toBe('a1');
    expect(isFindingClaim('observed fact', 'Transactions rose.')).toBe(true);
    expect(isFindingClaim('observed fact', 'Observed: NEAR daily transactions')).toBe(false);
    expect(isFindingClaim('hypothesis', 'x')).toBe(false);
    expect(isFindingClaim(null, 'x')).toBe(false);
  });
});

describe('strength', () => {
  const raw = { score: 62.4, band: 'solid', parts: [{ key: 'plan', label: 'Plan locked in advance', points: 15, max: 15, detail: 'Locked before the run.' }, { key: 'days', label: 'Days of data', points: 10, max: 15, detail: '60 days: two thirds.' }, { key: 'repro', label: 'Reproduced', points: 0, max: 10, detail: null }, { label: 'bad', points: 'x', max: 5 }] };
  it('normalises present, partial and absent', () => {
    const s = normalizeStrength(raw)!;
    expect(s.score).toBe(62);
    expect(s.band).toBe('solid');
    expect(s.parts).toHaveLength(3);
    expect(normalizeStrength(undefined)).toBeNull();
    expect(normalizeStrength({ band: 'fair' })).toBeNull();
    expect(normalizeStrength({ score: 140, band: 'weird' })).toEqual({ score: 100, band: null, parts: [] });
    expect(normalizeStrength({ score: 50, band: 'fair', parts: [{ key: 'k', label: 'L', points: 9, max: 5 }] })!.parts[0]!.points).toBe(5);
  });
  it('maps bands to tones', () => {
    expect(BAND_TONE).toEqual({ thin: 'bad', fair: 'warn', solid: 'info', strong: 'ok' });
    expect(bandTone(null)).toBe('');
  });
  it('explains missing points from the part detail', () => {
    const v = strengthView(normalizeStrength(raw)!);
    expect(v.tone).toBe('info');
    expect(v.word).toBe('solid');
    expect(v.missingTotal).toBe(15);
    expect(v.parts[0]!.explain).toBe('Locked before the run.');
    expect(v.parts[1]!.explain).toBe('5 of 15 points missing: 60 days: two thirds.');
    expect(v.parts[2]!.explain).toBe('10 of 10 points missing: No reason was given.');
    expect(partView({ key: 'k', label: 'L', points: 4, max: 5, detail: 'x' }).explain).toBe('1 of 5 points missing: x');
    expect(v.summary).toBe('Strength 62 out of 100, solid. 15 points missing across 2 checks.');
  });
  it('reads strength on a thesis summary and is absent without it', () => {
    const [a, b] = normalizeList({ items: [{ id: 'a', strength: raw }, { id: 'b' }] });
    expect(a!.strength?.score).toBe(62);
    expect(b!.strength).toBeNull();
  });
});

describe('challenges', () => {
  const raw = {
    challengeId: 'c1',
    outcome: 'weakened',
    notes: [
      { text: 'Window is short.', group: 'window', severity: 'minor', refs: ['/test/window'] },
      { text: 'Two days are missing.', group: 'coverage', severity: 'material', refs: [] },
      { text: 'Maybe a holiday.', group: 'alternative', severity: 'minor' },
      { text: 'Another coverage point.', group: 'coverage', severity: 'minor' },
      { text: 'No group.', severity: 'material' },
      { group: 'window' },
    ],
    droppedNotes: 2,
    cost: { usd: '0.000312', modelCalls: 1 },
    by: 'Kaushik',
    createdAt: '2026-11-14T11:00:00.000Z',
  };
  it('normalises present, partial and absent', () => {
    const c = normalizeChallenge(raw)!;
    expect(c).toMatchObject({ id: 'c1', outcome: 'weakened', droppedNotes: 2, by: 'Kaushik', answer: null, cost: { usd: '0.000312', modelCalls: 1 } });
    expect(c.notes).toHaveLength(5);
    const p = normalizeChallenge({ id: 'c2', outcome: 'nonsense' })!;
    expect(p).toMatchObject({ outcome: 'unavailable', notes: [], droppedNotes: null, by: null, createdAt: null, cost: { usd: null, modelCalls: null } });
    expect(normalizeChallenge({})).toBeNull();
    expect(normalizeChallenges(undefined)).toEqual([]);
    expect(normalizeChallenge({ id: 'c3', answer: 'My reply' })!.answer).toEqual({ text: 'My reply', by: null, at: null });
    expect(normalizeChallenge({ id: 'c4', answer: { text: 'T', by: 'Me', createdAt: '2026-11-14T12:00:00Z' } })!.answer).toEqual({ text: 'T', by: 'Me', at: '2026-11-14T12:00:00Z' });
  });
  it('sorts newest first and keeps at most ten', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, createdAt: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
    const out = normalizeChallenges(many);
    expect(out).toHaveLength(10);
    expect(out[0]!.id).toBe('c11');
  });
  it('groups notes in contract order, material first, ungrouped last', () => {
    const g = groupNotes(normalizeChallenge(raw)!.notes);
    expect(g.map((x) => x.label)).toEqual(['Coverage', 'Window', 'Alternative explanations', 'Other']);
    expect(g[0]!.notes.map((n) => n.text)).toEqual(['Two days are missing.', 'Another coverage point.']);
    expect(groupNotes([])).toEqual([]);
  });
  it('says how many notes were dropped, and when the owner still owes an answer', () => {
    expect(droppedText(0)).toBeNull();
    expect(droppedText(null)).toBeNull();
    expect(droppedText(1)).toBe('1 note was dropped because it cited numbers not in the thesis.');
    expect(droppedText(3)).toBe('3 notes were dropped because they cited numbers not in the thesis.');
    expect(needsAnswer(normalizeChallenge(raw)!)).toBe(true);
    expect(needsAnswer(normalizeChallenge({ ...raw, answer: 'ok' })!)).toBe(false);
    expect(needsAnswer(normalizeChallenge({ id: 'x', notes: [{ text: 't', severity: 'minor' }] })!)).toBe(false);
  });
  it('counts challenged in receipts without counting it as a check', () => {
    const r = normalizeReceipts({ verified: 1, challenged: 2 });
    expect(r.challenged).toBe(2);
    expect(receiptParts(r).map((p) => p.text)).toEqual(['verified 1', 'reproduced 0', 'challenged 2']);
    expect(receiptsText(normalizeReceipts({ challenged: 1 }))).toBe('Not verified or reproduced yet · challenged 1');
    expect(receiptsText(normalizeReceipts({}))).toBe('Not verified or reproduced yet');
    expect(normalizeReceipts([{ kind: 'challenge' }, { kind: 'verify' }]).challenged).toBe(1);
  });
});
