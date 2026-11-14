import { describe, expect, it } from 'vitest';
import { normalizeRefs, normalizeTask } from '@/lib/agent/thread';
import { taskThesisId } from '@/lib/agent/tasks';
import { STAGE_TITLE, buildStages, createdWithin, emphasiseNumbers, markerTitle, mergeStates, monitorSentence, proofPipeline, stageOfStep, thresholdOf, metricWords } from '@/lib/agent/storyboard';
import type { Proof } from '@/lib/near/api';

const step = (idx: number, key: string, state: string, extra: Record<string, unknown> = {}) => ({ idx, key, title: `T${idx}`, state, ...extra });
const task = (steps: unknown[], links: Record<string, unknown> = {}) => normalizeTask({ id: 't', threadId: 'th', title: 'x', state: 'running', steps, links });

describe('normalizeRefs', () => {
  it('keeps what is well typed and drops the rest', () => {
    const r = normalizeRefs({ workspaceId: 'w', runId: 3, markerIds: ['a', 5, 'b'], monitorIds: [], skipped: [{ kind: 'monitor', reason: 'no series' }, { kind: 9 }] });
    expect(r.workspaceId).toBe('w');
    expect(r.runId).toBeUndefined();
    expect(r.markerIds).toEqual(['a', 'b']);
    expect(r.monitorIds).toEqual([]);
    expect(r.skipped).toEqual([{ kind: 'monitor', reason: 'no series' }, { kind: 'item', reason: 'No reason was given.' }]);
  });
  it('is empty for garbage', () => {
    expect(normalizeRefs(null)).toEqual({});
    expect(normalizeRefs('x')).toEqual({});
  });
  it('is carried by a finished step and absent on an old one', () => {
    const t = task([step(0, 'capsule.build', 'done', { result: { summary: 's', items: [], refs: { capsuleId: 'c1' } } }), step(1, 'report.build', 'done', { result: { summary: 's', items: [] } })]);
    expect(t.steps[0]!.result!.refs.capsuleId).toBe('c1');
    expect(t.steps[1]!.result!.refs).toEqual({});
  });
});

describe('buildStages', () => {
  it('maps a full plan to stages in order, deriving findings and the three setup stages', () => {
    const t = task([
      step(0, 'workspace.create', 'done'),
      step(1, 'question.ask', 'done'),
      step(2, 'run.await', 'done'),
      step(3, 'setup.auto', 'done', { cost: { modelUsd: '0.01', creditsUsd: '0' } }),
      step(4, 'capsule.build', 'running'),
      step(5, 'report.build', 'pending'),
    ]);
    const s = buildStages(t);
    expect(s.map((x) => x.kind)).toEqual(['workspace', 'investigate', 'findings', 'markers', 'monitors', 'hypothesis', 'capsule', 'report']);
    expect(s[1]!.stepIdxs).toEqual([1, 2]);
    expect(s.map((x) => x.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'working', 'waiting']);
    // the setup step's cost is shown once, on its first stage
    expect(s[3]!.costUsd).toBe('0.010000');
    expect(s[4]!.costUsd).toBeNull();
    expect(stageOfStep(s, 3)!.kind).toBe('markers');
  });
  it('has only the stages a short task has', () => {
    const s = buildStages(task([step(0, 'workspace.use', 'done'), step(1, 'capsule.prove', 'done')]));
    expect(s.map((x) => x.kind)).toEqual(['workspace', 'proof']);
  });
  it('carries a failed step error and marks findings skipped after a failed run', () => {
    const s = buildStages(task([step(0, 'question.ask', 'done'), step(1, 'run.await', 'failed', { error: { reasonCode: 'RUN_BLOCKED', message: 'blocked', retryable: false } })]));
    expect(s[0]!.state).toBe('failed');
    expect(s[0]!.error?.reasonCode).toBe('RUN_BLOCKED');
    expect(s[1]!.kind).toBe('findings');
    expect(s[1]!.state).toBe('skipped');
  });
  it('falls back to task links and keeps skipped reasons from old items', () => {
    const t = task(
      [step(0, 'setup.auto', 'done', { result: { summary: '', items: [{ label: 'Skipped monitor', value: 'no series to watch' }, { label: 'Marker', value: 'm' }] } }), step(1, 'capsule.prove', 'done')],
      { workspaceId: 'w1', capsuleId: 'c1', proofId: 'p1' },
    );
    const s = buildStages(t);
    expect(s.find((x) => x.kind === 'monitors')!.skipped).toEqual([{ kind: 'monitor', reason: 'no series to watch' }]);
    expect(s.find((x) => x.kind === 'markers')!.skipped).toEqual([]);
    const proof = s.find((x) => x.kind === 'proof')!;
    expect(proof.refs.proofId).toBe('p1');
    expect(proof.refs.capsuleId).toBe('c1');
    expect(proof.refs.workspaceId).toBe('w1');
  });
  it('turns an unknown step into its own stage and an empty task into none', () => {
    const s = buildStages(task([step(0, 'something.new', 'pending')]));
    expect(s).toHaveLength(1);
    expect(s[0]!.kind).toBe('other');
    expect(buildStages(null)).toEqual([]);
    expect(buildStages(task([]))).toEqual([]);
  });
  it('marks a stage waiting for the user as working with an approval flag', () => {
    const s = buildStages(task([step(0, 'capsule.publish', 'waiting_user', { waiting: { kind: 'approval', runId: '', approvalId: 'a', approvalKind: 'publish', summary: 'Publish it', costLimit: null } })]));
    expect(s[0]!.state).toBe('working');
    expect(s[0]!.needsApproval).toBe(true);
    expect(s[0]!.progress).toBe('Publish it');
  });
});

describe('mergeStates', () => {
  it('orders failed over working over done', () => {
    expect(mergeStates(['done', 'failed', 'running'])).toBe('failed');
    expect(mergeStates(['done', 'running'])).toBe('working');
    expect(mergeStates(['done', 'pending'])).toBe('working');
    expect(mergeStates(['skipped', 'skipped'])).toBe('skipped');
    expect(mergeStates(['done', 'skipped'])).toBe('done');
    expect(mergeStates(['pending'])).toBe('waiting');
  });
});

describe('monitorSentence', () => {
  it('writes a comparison in plain words', () => {
    expect(monitorSentence({ kind: 'compare', metricId: 'live.near_tx_count', op: 'lt', value: 626447 })).toBe('alerts when near tx count fall below 626,447'.replace('count fall', 'count fall'));
  });
  it('uses the caller’s metric name', () => {
    expect(monitorSentence({ kind: 'compare', metricId: 'm', op: 'gt', value: 1.5 }, () => 'daily swaps')).toBe('alerts when daily swaps rise above 1.5');
  });
  it('covers z-score, and, or and not', () => {
    expect(monitorSentence({ kind: 'zscore', metricId: 'live.x_y', windowDays: 14, absoluteGt: 3 })).toContain('3 standard deviations from its 14-day average');
    const a = { kind: 'compare', metricId: 'a', op: 'gt', value: 1 } as const;
    const b = { kind: 'compare', metricId: 'b', op: 'lte', value: 2 } as const;
    expect(monitorSentence({ kind: 'and', terms: [a, b] })).toBe('alerts when a rise above 1, and b fall to or below 2');
    expect(monitorSentence({ kind: 'or', terms: [a, b] })).toContain(', or ');
    expect(monitorSentence({ kind: 'not', term: a })).toContain('not true');
  });
  it('finds the line to draw', () => {
    expect(thresholdOf({ kind: 'or', terms: [{ kind: 'zscore', metricId: 'a', windowDays: 7, absoluteGt: 2 }, { kind: 'compare', metricId: 'b', op: 'gt', value: 9 }] })).toEqual({ metricId: 'b', op: 'gt', value: 9 });
    expect(thresholdOf({ kind: 'zscore', metricId: 'a', windowDays: 7, absoluteGt: 2 })).toBeNull();
    expect(metricWords('activeAccounts')).toBe('active accounts');
  });
});

const proof = (o: Omit<Partial<Proof>, 'verification'> & { verification?: Partial<Proof['verification']> }): Proof =>
  ({
    proofId: 'p', capsuleId: 'c', state: 'running', requestedBy: 'u', createdAt: '2026-01-01T00:00:00Z', finishedAt: null,
    job: { network: 'testnet', requestId: null, txHash: null, explorerUrl: null },
    wasmSha256: 'w', inputSha256: 'i', outputSha256: null, cost: {}, error: null,
    ...o,
    verification: { decision: null, reasons: [], mrTd: null, rtmr3: null, collateralChecked: false, ...(o.verification ?? {}) },
  }) as Proof;

describe('proofPipeline', () => {
  const states = (p: Proof | null) => proofPipeline(p).map((x) => x.state);
  it('is all pending before a proof exists', () => {
    expect(states(null)).toEqual(['pending', 'pending', 'pending', 'pending']);
  });
  it('shows the run as active while the job is running', () => {
    expect(states(proof({}))).toEqual(['done', 'active', 'pending', 'pending']);
  });
  it('moves to the attestation once the output hash is known', () => {
    expect(states(proof({ outputSha256: 'h' }))).toEqual(['done', 'done', 'active', 'pending']);
    expect(states(proof({ outputSha256: 'h', verification: { mrTd: 'm' } }))).toEqual(['done', 'done', 'done', 'active']);
  });
  it('fills all four for a verified proof', () => {
    expect(states(proof({ state: 'verified', outputSha256: 'h', verification: { decision: 'accept', mrTd: 'm', rtmr3: 'r' } }))).toEqual(['done', 'done', 'done', 'done']);
  });
  it('fails at the stage that stopped and leaves the later ones pending', () => {
    expect(states(proof({ state: 'failed', error: 'x' }))).toEqual(['done', 'failed', 'pending', 'pending']);
    expect(states(proof({ state: 'not_attested', outputSha256: 'h' }))).toEqual(['done', 'done', 'failed', 'pending']);
  });
});

describe('text helpers', () => {
  it('strips the lead-in of a marker question', () => {
    expect(markerTitle("From the assistant's investigation: Swaps hit a high.")).toBe('Swaps hit a high.');
    expect(markerTitle(null)).toBe('Marker');
  });
  it('splits numbers out of a sentence but not dates', () => {
    const p = emphasiseNumbers('rising from 626,447 on 2026-09-13 to 42.28% now');
    expect(p.filter((x) => x.num).map((x) => x.text)).toEqual(['626,447', '42.28%']);
    expect(p.map((x) => x.text).join('')).toBe('rising from 626,447 on 2026-09-13 to 42.28% now');
  });
  it('selects what was created inside a step window', () => {
    const items = [{ at: '2026-01-01T00:00:01Z' }, { at: '2026-01-01T00:05:00Z' }, { at: null }];
    expect(createdWithin(items, (x) => x.at, '2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z')).toHaveLength(1);
    expect(createdWithin(items, (x) => x.at, null, null)).toEqual([]);
  });
});

import { panelForMetric, plotRuns, seriesOf, xOfTime, yDomainOf } from '@/lib/agent/storyboard-series';

describe('series helpers', () => {
  const panel = { kind: 'timeSeries' as const, encoding: { x: 'd', y: ['m'] } };
  const data = { chart: { columns: [{ name: 'd', unit: null }, { name: 'm', unit: 'tx' }], rows: [['2026-01-02T00:00:00Z', 5], ['2026-01-01T00:00:00Z', '3'], ['2026-01-03T00:00:00Z', null]] } } as never;
  it('reads one column as sorted points and keeps a gap as null', () => {
    const s = seriesOf(panel, data)!;
    expect(s.unit).toBe('tx');
    expect(s.points.map((p) => p.v)).toEqual([3, 5, null]);
    expect(seriesOf(panel, { chart: null } as never)).toBeNull();
    expect(seriesOf({ encoding: { x: 'nope', y: ['zz'] } }, data)).toBeNull();
  });
  it('finds the panel that plots a metric', () => {
    expect(panelForMetric([panel], 'm')).toBe(panel);
    expect(panelForMetric([panel], 'other')).toBeNull();
  });
  it('splits runs at gaps and positions a marker inside the window only', () => {
    const pts = seriesOf(panel, data)!.points;
    expect(plotRuns(pts, 100, 50, { t: 0, b: 0, l: 0, r: 0 }, yDomainOf(pts))).toHaveLength(1);
    const withGap = [{ t: 0, v: 1 }, { t: 1, v: null }, { t: 2, v: 2 }];
    expect(plotRuns(withGap, 100, 50, { t: 0, b: 0, l: 0, r: 0 }, [0, 3])).toHaveLength(2);
    expect(xOfTime(pts, pts[0]!.t, 100, 0, 0)).toBe(0);
    expect(xOfTime(pts, pts[0]!.t - 1, 100, 0, 0)).toBeNull();
  });
});

import { quotedText } from '@/lib/agent/storyboard';
it('reads the quoted question out of a step detail', () => {
  expect(quotedText('Starts a live investigation of "How did swaps change?" with the minimum budget.')).toBe('How did swaps change?');
  expect(quotedText('No quotes here')).toBeNull();
});

import { compareOutcome, compareRows, thesisPathOf, thesisView } from '@/lib/agent/storyboard';

describe('thesis stages', () => {
  it('an older task with a report step and no thesis keeps that stage, titled as the older format', () => {
    const s = buildStages(task([step(0, 'capsule.build', 'done'), step(1, 'report.build', 'done')]));
    expect(s.map((x) => x.kind)).toEqual(['capsule', 'report']);
    expect(STAGE_TITLE.report).toBe('Workspace summary (older format)');
  });
  it('finds the thesis id from the task link or the thesis step', () => {
    expect(taskThesisId(task([], { thesisId: 'a' }))).toBe('a');
    expect(taskThesisId(task([step(0, 'thesis.build', 'done', { result: { summary: 's', items: [], refs: { thesisId: 'b' } } })]))).toBe('b');
    expect(taskThesisId(task([step(0, 'report.build', 'done')]))).toBeNull();
  });
  it('adds thesis, public link and comparison stages and places the thesis last, with no separate report stage', () => {
    const t = task(
      [
        step(0, 'capsule.build', 'done'),
        step(1, 'capsule.publish', 'done'),
        step(2, 'report.build', 'done'),
        step(3, 'thesis.build', 'done', { result: { summary: 'SUPPORTED', items: [], refs: { thesisId: 'th1' } } }),
        step(4, 'thesis.publish', 'pending'),
      ],
      { thesisId: 'th9' },
    );
    const s = buildStages(t);
    expect(s.map((x) => x.kind)).toEqual(['capsule', 'publish', 'thesis', 'thesislink']);
    expect(s[2]!.refs.thesisId).toBe('th1');
    expect(buildStages(task([step(0, 'thesis.build', 'running')], { thesisId: 'th9' }))[0]!.refs.thesisId).toBe('th9');
    expect(buildStages(task([step(0, 'thesis.compare', 'done')]))[0]!.kind).toBe('compare');
  });
  it('keeps thesisId in refs and links', () => {
    expect(normalizeRefs({ thesisId: 't' }).thesisId).toBe('t');
    expect(task([], { thesisId: 'x' }).links.thesisId).toBe('x');
  });
  it('reads the tile from a thesis document and leaves absent numbers unknown', () => {
    const v = thesisView({ hypothesis: 'H', verdict: { status: 'MIXED', headline: 'head' }, charts: [1, 2], claims: [], test: { n: 60, window: { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }, pearson: 0.29, lag: [{ days: 7, value: 0.17 }] } });
    expect(v).toMatchObject({ hypothesis: 'H', verdict: 'MIXED', headline: 'head', charts: 2, claims: 0, n: 60, window: '2026-01-01 to 2026-03-01', pearson: 0.29, lag7: 0.17 });
    expect(thesisView({ verdict: { status: 'SUPPORTED', headline: 'x' } })).toMatchObject({ n: null, pearson: null, lag7: null, charts: null });
    expect(thesisView(null).verdict).toBeNull();
  });
  it('reads comparison rows and the outcome', () => {
    const t = task([step(0, 'thesis.compare', 'done', { result: { summary: 'Reproduction: match', items: [{ label: 'n', original: '60', reproduced: '60', delta: '0' }, { label: 'r', value: '0.29 | 0.31 | 0.02' }, { label: 'x', value: 'only' }] } })]);
    const rows = compareRows(t.steps[0]!.result!.items);
    expect(rows[0]).toEqual({ what: 'n', original: '60', reproduced: '60', delta: '0' });
    expect(rows[1]).toEqual({ what: 'r', original: '0.29', reproduced: '0.31', delta: '0.02' });
    expect(rows[2]!.reproduced).toBe('only');
    expect(compareOutcome('Reproduction: match')).toBe('match');
    expect(compareOutcome('some drift')).toBe('drift');
    expect(compareOutcome('different results')).toBe('different');
    expect(compareOutcome(null)).toBe('unknown');
  });
  it('finds the public thesis path', () => {
    expect(thesisPathOf([{ href: null }, { href: '/t/abc' }], '/t/')).toBe('/t/abc');
    expect(thesisPathOf([], '/t/')).toBeNull();
  });
});
