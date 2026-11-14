import { describe, expect, it } from 'vitest';
import { normalizeTask } from '@/lib/agent/thread';
import { approvalNeeded, approvalAnnouncement, consentAllowance, PLAN_LINE_CONSENT, PLAN_LINE_NONE } from '@/lib/agent/approval';
import { agentDescription, agentDisplay, agentLabel, firstOfRole } from '@/lib/agent/agents';

const task = (state: string, extra: Record<string, unknown> = {}) => normalizeTask({ id: 't1', threadId: 'th', title: 'x', state, steps: [], ...extra });
const consent = (keys: [string, string | null][]) => ({ required: keys.map(([key, maxUsd]) => ({ key, label: key, detail: '', maxUsd })), given: [] });

describe('approvalNeeded', () => {
  it('is null with no task and for tasks that wait on nothing', () => {
    expect(approvalNeeded(null)).toBeNull();
    for (const s of ['running', 'completed', 'failed', 'cancelled']) expect(approvalNeeded(task(s))).toBeNull();
  });
  it('a proposed plan with consents counts the unticked ones and names the first', () => {
    const t = task('proposed', { consent: consent([['spend_credits', '0.11'], ['publish_public', null]]) });
    const a = approvalNeeded(t);
    expect(a).toMatchObject({ kind: 'plan', consents: 2, missing: 2, firstMissingKey: 'spend_credits', line: PLAN_LINE_CONSENT });
    expect(approvalNeeded(t, new Set(['spend_credits']))).toMatchObject({ missing: 1, firstMissingKey: 'publish_public' });
    expect(approvalNeeded(t, new Set(['spend_credits', 'publish_public']))).toMatchObject({ missing: 0, firstMissingKey: null });
  });
  it('a plan that needs no consent says so and still needs the Start press', () => {
    expect(approvalNeeded(task('proposed'))).toMatchObject({ kind: 'plan', consents: 0, missing: 0, line: PLAN_LINE_NONE });
  });
  it('a task waiting on a run approval names the step', () => {
    const t = task('waiting_user', { steps: [{ idx: 0, key: 'a', title: 'Apply', state: 'done' }, { idx: 1, key: 'b', title: 'Approve the canvas', state: 'waiting_user', waiting: { kind: 'run', runId: 'r', approvalId: 'a', approvalKind: 'canvas', summary: 'Add 3 panels', costLimit: '0.10' } }] });
    expect(approvalNeeded(t)).toMatchObject({ kind: 'run', stepIdx: 1, summary: 'Add 3 panels', notice: 'The agent is waiting for you' });
  });
  it('waiting_user without a waiting step is not an approval', () => {
    expect(approvalNeeded(task('waiting_user', { steps: [{ idx: 0, key: 'a', title: 'A', state: 'running' }] }))).toBeNull();
  });
});

describe('consent wording and announcements', () => {
  it('says what each box allows with its limit', () => {
    expect(consentAllowance({ key: 'spend_credits', maxUsd: '0.11' })).toBe('Spend up to $0.11 of your credits');
    expect(consentAllowance({ key: 'spend_credits', maxUsd: null })).toMatch(/no limit was stated/);
    expect(consentAllowance({ key: 'publish_public', maxUsd: null })).toBe('Publish publicly');
  });
  it('announces the plan and the run approval', () => {
    expect(approvalAnnouncement(null)).toBe('');
    expect(approvalAnnouncement(approvalNeeded(task('proposed', { consent: consent([['spend_credits', '1']]) })))).toMatch(/1 permission to tick/);
    expect(approvalAnnouncement(approvalNeeded(task('proposed')))).toMatch(/Press Start/);
  });
});

describe('agent rows', () => {
  it('labels roles as "<Role> agent"', () => {
    expect(agentLabel('director')).toBe('Director agent');
    expect(agentLabel('composer')).toBe('Composer agent');
    expect(agentLabel('semantic_analyst')).toBe('Semantic analyst agent');
    expect(agentLabel('')).toBe('Unknown agent');
  });
  it('describes known roles and guesses nothing for others', () => {
    expect(agentDescription('director')).toBe('plans the investigation and checks the result');
    expect(agentDescription('composer')).toBe('writes the queries and builds the charts');
    expect(agentDescription('mystery')).toBeNull();
  });
  it('shows the first row of each role the description', () => {
    expect([...firstOfRole(['director', 'composer', 'composer', 'director'])]).toEqual([0, 1]);
  });
  it('a terminal run shows its agents finished, even the director the API leaves running', () => {
    expect(agentDisplay('RUNNING', true)).toEqual({ state: 'finished', word: 'finished' });
    expect(agentDisplay('DONE', true).state).toBe('finished');
    expect(agentDisplay('DONE', false).state).toBe('finished');
  });
  it('a live run keeps what the API says, and failures are never hidden', () => {
    expect(agentDisplay('RUNNING', false)).toEqual({ state: 'live', word: 'running' });
    expect(agentDisplay('QUEUED', false).state).toBe('pending');
    expect(agentDisplay('FAILED', true).state).toBe('failed');
    expect(agentDisplay('CANCELLED', true).state).toBe('failed');
  });
});
