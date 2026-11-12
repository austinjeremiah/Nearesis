import { qk } from '@/lib/api/keys';
import type { SseEventName } from '@/lib/contracts/generated';

export type QueryKeyPrefix = readonly unknown[];

/**
 * Which cached queries an SSE event makes stale. Pure, so it is unit-tested.
 * Names come from the generated catalogue (docs/api/SSE.md).
 */
export function invalidationsFor(event: string, wid: string): QueryKeyPrefix[] {
  switch (event as SseEventName) {
    case 'workspace.created':
    case 'workspace.updated':
      return [qk.workspaces, qk.workspace(wid), qk.timeline(wid)];
    case 'panel.created':
    case 'panel.updated':
    case 'panel.removed':
    case 'canvas.patched':
    case 'query.completed':
    case 'lens.changed':
    case 'graph.layout_saved':
      return [qk.canvas(wid), qk.lenses(wid), qk.timeline(wid)];
    case 'run.state_changed':
    case 'agent.spawned':
    case 'task.started':
    case 'task.completed':
    case 'finding.created':
      return [qk.runs(wid), ['ws', wid, 'run'], qk.timeline(wid), qk.workspaces, ['global']];
    case 'approval.granted':
    case 'approval.rejected':
      return [qk.approvals(wid), qk.runs(wid), ['ws', wid, 'run'], qk.timeline(wid), ['global']];
    case 'marker.created':
    case 'marker.assigned':
    case 'marker.transitioned':
    case 'marker.evidence_linked':
      return [qk.markers(wid), qk.timeline(wid)];
    case 'monitor.rule_changed':
    case 'monitor.triggered':
      return [qk.monitors(wid), qk.notifications(wid), qk.timeline(wid), ['global']];
    case 'notification.created':
    case 'notification.read':
      return [qk.notifications(wid), ['global']];
    case 'claim.updated':
    case 'evidence.verified':
      return [qk.graph(wid), qk.eligibility(wid), qk.timeline(wid)];
    case 'snapshot.finalized':
      return [qk.snapshots(wid), qk.timeline(wid)];
    case 'research.published':
      return [qk.capsules(wid), qk.eligibility(wid), qk.timeline(wid)];
    case 'access.denied':
      return [qk.timeline(wid)];
    default:
      // plugin.* and unknown future events: refresh the timeline only
      return [qk.timeline(wid)];
  }
}

/** A `coalesced` frame replaces a backlog: refetch the views named in byType, or everything when unsure. */
export function invalidationsForCoalesced(byType: Record<string, number> | undefined, wid: string): QueryKeyPrefix[] {
  const types = Object.keys(byType ?? {});
  if (types.length === 0) return [qk.scope(wid), qk.workspace(wid)];
  return types.flatMap((t) => invalidationsFor(t, wid));
}

/** Everything scoped to a workspace (used after reload_required). */
export function invalidationsForReload(wid: string): QueryKeyPrefix[] {
  return [qk.scope(wid), qk.workspace(wid), qk.workspaces];
}
