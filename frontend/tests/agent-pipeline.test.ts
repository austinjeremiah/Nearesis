import { describe, it, expect } from 'vitest';
import { isAutoApprovable, newPipeline, runPipeline, type ApprovalSnapshot, type PipelineDeps, type PipelineState, type RunSnapshot } from '@/lib/agent/pipeline';
import { normalizeSetup } from '@/lib/agent/types';

let n = 0;
const key = () => `k${++n}`;

/** Scripted API surface: each getRun call pops the next snapshot (the last one repeats). Time is virtual. */
function harness(script: RunSnapshot[], approvals: ApprovalSnapshot['approvals'] = [], over: Partial<PipelineDeps> = {}) {
  const calls: string[] = [];
  let clock = 0;
  let i = 0;
  const deps: PipelineDeps = {
    createWorkspace: async () => (calls.push('createWorkspace'), { workspaceId: 'w1' }),
    ask: async () => (calls.push('ask'), { runId: 'r1' }),
    getRun: async () => (calls.push('getRun'), script[Math.min(i++, script.length - 1)]),
    getApprovals: async (runId) => (calls.push('getApprovals'), { runId, approvals }),
    decide: async (_r, id) => void calls.push(`decide:${id}`),
    setup: async () => (calls.push('setup'), normalizeSetup({ markers: [{ id: 'm1', title: 'Peak', reason: 'r' }], hypothesis: { id: 'h1', title: 'T' } })),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    ...over,
  };
  return { deps, calls };
}
const run = (s: string, extra: Partial<RunSnapshot> = {}): RunSnapshot => ({ state: s, ...extra });
const ready = { state: 'ready', reason: null };
const patch = (over = {}) => ({ approvalId: 'a1', actionHash: 'h', status: 'pending', kind: 'canvas.apply_patch', costLimit: 0, ...over });
const fresh = () => newPipeline('study swaps', key, 0);

describe('approval rule', () => {
  it('approves only canvas.apply_patch with cost limit 0', () => {
    expect(isAutoApprovable({ kind: 'canvas.apply_patch', costLimit: 0 })).toBe(true);
    expect(isAutoApprovable({ kind: 'canvas.apply_patch', costLimit: 1 })).toBe(false);
    expect(isAutoApprovable({ kind: 'canvas.apply_patch', costLimit: null })).toBe(false);
    expect(isAutoApprovable({ kind: 'capsule.publish', costLimit: 0 })).toBe(false);
  });
});

describe('runPipeline', () => {
  it('runs all steps in order and ends with a summary', async () => {
    const { deps, calls } = harness([run('PLANNING'), run('APPROVAL_NEEDED'), run('EXECUTING'), run('COMPLETE', { interpretation: ready, findings: [{ statement: 's', basis: 'observation', status: 'supported', facts: [1, 2], skepticNotes: [] }] })], [patch()]);
    const states: PipelineState[] = [];
    const end = await runPipeline(fresh(), deps, (s) => states.push(s));
    expect(end.phase).toBe('done');
    expect(calls.filter((c) => !c.startsWith('getRun'))).toEqual(['createWorkspace', 'ask', 'getApprovals', 'decide:a1', 'setup']);
    expect(Object.values(end.steps).every((s) => s.status === 'done')).toBe(true);
    expect(end.workspaceId).toBe('w1');
    expect(end.runId).toBe('r1');
    expect(end.setup?.markers).toHaveLength(1);
    expect(end.findings[0].facts).toBe(2);
    // exactly one step is active at any time
    expect(states.every((s) => Object.values(s.steps).filter((x) => x.status === 'active').length <= 1)).toBe(true);
  });

  it('stops and approves nothing when the approval is not a zero-cost canvas patch', async () => {
    const { deps, calls } = harness([run('APPROVAL_NEEDED')], [patch(), patch({ approvalId: 'a2', kind: 'capsule.publish' })]);
    const end = await runPipeline(fresh(), deps, () => {});
    expect(end.phase).toBe('stopped');
    expect(end.stoppedOn?.approvalId).toBe('a2');
    expect(end.steps.approve.status).toBe('stopped');
    expect(calls.some((c) => c.startsWith('decide'))).toBe(false);
    expect(calls).not.toContain('setup');
  });

  it('refuses a canvas patch with a non-zero cost limit', async () => {
    const { deps, calls } = harness([run('APPROVAL_NEEDED')], [patch({ costLimit: 0.5 })]);
    const end = await runPipeline(fresh(), deps, () => {});
    expect(end.phase).toBe('stopped');
    expect(calls.some((c) => c.startsWith('decide'))).toBe(false);
  });

  it('refuses approvals reported for a different run', async () => {
    const { deps, calls } = harness([run('APPROVAL_NEEDED')], [patch()], { getApprovals: async () => ({ runId: 'other', approvals: [patch()] }) });
    const end = await runPipeline(fresh(), deps, () => {});
    expect(end.phase).toBe('stopped');
    expect(calls.some((c) => c.startsWith('decide'))).toBe(false);
  });

  it('skips the approval steps when the run completes without one', async () => {
    const { deps } = harness([run('COMPLETE', { interpretation: ready })]);
    const end = await runPipeline(fresh(), deps, () => {});
    expect(end.steps.approval_wait.status).toBe('skipped');
    expect(end.steps.approve.status).toBe('skipped');
    expect(end.phase).toBe('done');
  });

  it('continues without setup when the interpretation failed, and says so', async () => {
    const { deps, calls } = harness([run('COMPLETE', { interpretation: { state: 'unavailable', reason: 'model refused' } })]);
    const end = await runPipeline(fresh(), deps, () => {});
    expect(end.phase).toBe('done');
    expect(end.steps.run.detail).toContain('model refused');
    expect(end.steps.setup.status).toBe('skipped');
    expect(calls).not.toContain('setup');
  });

  it('fails with the run failure reason when the run is blocked', async () => {
    const { deps } = harness([run('BLOCKED_SOURCE', { failure: { reason: 'source is stale' } })]);
    const end = await runPipeline(fresh(), deps, () => {});
    expect(end.phase).toBe('failed');
    expect(end.error?.message).toContain('BLOCKED_SOURCE');
    expect(end.error?.message).toContain('source is stale');
  });

  it('times out after about 5 minutes and keeps the run id for the fallback link', async () => {
    const { deps } = harness([run('EXECUTING')]);
    const end = await runPipeline({ ...fresh(), steps: { ...fresh().steps, approval_wait: { status: 'done' }, approve: { status: 'done' } } }, deps, () => {});
    expect(end.phase).toBe('timeout');
    expect(end.runId).toBe('r1');
  });

  it('a failed step shows the API reason and a retry resumes there without repeating earlier steps', async () => {
    let fail = true;
    const h = harness([run('COMPLETE', { interpretation: ready })], [], {
      setup: async () => {
        if (fail) throw new Error('setup refused: viewer role');
        return normalizeSetup({});
      },
    });
    const first = await runPipeline(fresh(), h.deps, () => {});
    expect(first.phase).toBe('failed');
    expect(first.error).toEqual({ step: 'setup', message: 'setup refused: viewer role' });
    fail = false;
    h.calls.length = 0;
    const second = await runPipeline(first, h.deps, () => {});
    expect(second.phase).toBe('done');
    expect(h.calls).not.toContain('createWorkspace');
    expect(h.calls).not.toContain('ask');
    expect(h.calls).not.toContain('getRun');
    expect(second.keys.setup).toBe(first.keys.setup);
  });

  it('a failure creating the workspace retries the same idempotency key', async () => {
    const seen: string[] = [];
    let fail = true;
    const h = harness([run('COMPLETE', { interpretation: ready })], [], {
      createWorkspace: async (_o, k) => {
        seen.push(k);
        if (fail) throw new Error('network');
        return { workspaceId: 'w1' };
      },
    });
    const first = await runPipeline(fresh(), h.deps, () => {});
    expect(first.error?.step).toBe('workspace');
    fail = false;
    const second = await runPipeline(first, h.deps, () => {});
    expect(second.phase).toBe('done');
    expect(seen[0]).toBe(seen[1]);
  });
});
