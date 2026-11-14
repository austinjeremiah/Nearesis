import { describe, it, expect } from 'vitest';
import { SSE_EVENT_NAMES } from '@/lib/contracts/generated';
import { qk } from '@/lib/api/keys';
import { invalidationsFor, invalidationsForCoalesced, invalidationsForReload } from '@/lib/sse/invalidation';

const W = 'w1';
describe('SSE invalidation mapping', () => {
  it('every catalogued event maps to at least one query', () => {
    for (const e of SSE_EVENT_NAMES) expect(invalidationsFor(e, W).length, e).toBeGreaterThan(0);
  });
  it('maps representative events', () => {
    expect(invalidationsFor('run.state_changed', W)).toContainEqual(qk.runs(W));
    expect(invalidationsFor('panel.updated', W)).toContainEqual(qk.canvas(W));
    expect(invalidationsFor('monitor.triggered', W)).toContainEqual(qk.monitors(W));
    expect(invalidationsFor('research.published', W)).toContainEqual(qk.capsules(W));
  });
  it('coalesced refetches what byType names, or everything when empty', () => {
    const k = invalidationsForCoalesced({ 'panel.updated': 3, 'run.state_changed': 1 }, W);
    expect(k).toContainEqual(qk.canvas(W));
    expect(k).toContainEqual(qk.runs(W));
    expect(invalidationsForCoalesced({}, W)).toContainEqual(qk.scope(W));
  });
  it('reload invalidates the whole workspace scope', () => {
    expect(invalidationsForReload(W)).toContainEqual(qk.scope(W));
  });
  it('workspace-scoped keys share the ws prefix so one call clears them all', () => {
    for (const k of [qk.runs(W), qk.canvas(W), qk.timeline(W), qk.monitors(W)]) expect(k.slice(0, 2)).toEqual(qk.scope(W));
  });
});
