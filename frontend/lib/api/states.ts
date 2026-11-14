import type { ApiState } from '@/lib/contracts/generated';

/**
 * UI presentation of the 12 states (docs/api/STATES.md). Copy follows the
 * "Frontend" column of that table; tone picks the Notice colour.
 */
export type StateTone = 'ok' | 'warn' | 'bad' | 'info';

export const STATE_UI: Record<ApiState, { title: string; body: string; tone: StateTone; blocksContent: boolean }> = {
  loading: { title: 'Loading', body: 'Work is in progress and there is no usable result yet.', tone: 'info', blocksContent: true },
  partial: { title: 'Partial result', body: 'Some panels, sources or tasks finished; others are still running or failed. This is not a complete result.', tone: 'warn', blocksContent: false },
  complete: { title: 'Complete', body: 'Everything requested was produced from current data.', tone: 'ok', blocksContent: false },
  stale: { title: 'Stale data', body: 'This result is shown from the last finalized snapshot because its source is behind. Do not publish it as current.', tone: 'warn', blocksContent: false },
  truncated: { title: 'Truncated result', body: 'The row limit cut this result. Narrow the query to see all of it.', tone: 'warn', blocksContent: false },
  source_unavailable: { title: 'Source unavailable', body: 'The source or semantic layer is down and there is no snapshot to serve. Retrying with backoff.', tone: 'bad', blocksContent: true },
  permission_denied: { title: 'Permission denied', body: 'You are not signed in, not a member, or your role does not allow this. Retrying will not help.', tone: 'bad', blocksContent: true },
  rate_limited: { title: 'Rate limited', body: 'Too many requests. Wait and try again.', tone: 'warn', blocksContent: true },
  insufficient_data: { title: 'Insufficient data', body: 'The data cannot support this answer. Nothing has been filled in.', tone: 'info', blocksContent: true },
  metric_uncertified: { title: 'Metric not certified', body: 'This metric is a draft, validated-only or deprecated. Treat it as exploratory; it cannot back a published claim.', tone: 'warn', blocksContent: false },
  method_unvalidated: { title: 'Method not validated', body: 'The analysis method has not passed validation. The finding is descriptive only and needs acknowledgement to publish.', tone: 'warn', blocksContent: false },
  budget_exhausted: { title: 'Budget exhausted', body: 'A spend limit stopped paid work. Historical reads still work; the owner must raise a limit.', tone: 'bad', blocksContent: true },
  // keep Record exhaustive when the taxonomy changes: the generated type fails the build if a state is missing
};
