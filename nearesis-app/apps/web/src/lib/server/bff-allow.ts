/**
 * Paths the same-origin BFF forwards to the kernel API (/v1/...). Ids follow the API's own formats: workspaces and runs
 * are UUIDs; approval ids are the numeric `runtime.run_events.id` (runs.ts approvalId).
 */
const UUID = "[0-9a-f-]{36}";
const CAPSULE = "[A-Za-z0-9][A-Za-z0-9._-]{0,119}";
/** Metric ids such as `prices.daily_close_price_usd`; no slashes, so no traversal. */
const METRIC = "[A-Za-z0-9][A-Za-z0-9._:-]{0,199}";
export const ALLOWED = [
  /^workspaces$/, // GET lists the caller's workspaces (sidebar); POST creates one
  new RegExp(`^workspaces/${UUID}$`),
  new RegExp(`^workspaces/${UUID}/canvas$`),
  new RegExp(`^workspaces/${UUID}/commands$`),
  new RegExp(`^workspaces/${UUID}/events$`),
  new RegExp(`^workspaces/${UUID}/graph$`),
  new RegExp(`^workspaces/${UUID}/questions$`),
  new RegExp(`^workspaces/${UUID}/runs$`),
  new RegExp(`^workspaces/${UUID}/sources$`),
  // P06 monitoring reads (commands go through /commands). Published by apps/api monitoring-routes.ts.
  new RegExp(`^workspaces/${UUID}/(markers|lenses|monitors|monitors/triggers|notifications|marker-tasks)$`),
  new RegExp(`^workspaces/${UUID}/lenses/${UUID}/resolution$`),
  // Monitoring read model additions: evaluations, counters, export, watermarks, delegation chain; PUT delegation scope.
  new RegExp(`^workspaces/${UUID}/monitors/(evaluations|counters|export|watermarks)$`),
  new RegExp(`^workspaces/${UUID}/markers/${UUID}/delegations$`),
  new RegExp(`^workspaces/${UUID}/delegation-scopes$`),
  // Evidence graph and time machine (apps/api history-routes.ts).
  new RegExp(`^workspaces/${UUID}/graph/rechecks(/resolve)?$`),
  new RegExp(`^workspaces/${UUID}/snapshots(/compare)?$`),
  new RegExp(`^workspaces/${UUID}/snapshots/${UUID}(/(canvas|graph|layout))?$`),
  new RegExp(`^workspaces/${UUID}/timeline$`),
  new RegExp(`^workspaces/${UUID}/comments$`), // reviewer comments on evidence nodes (GET ?nodeId=, POST)
  new RegExp(`^workspaces/${UUID}/branches$`),
  new RegExp(`^workspaces/${UUID}/branches/${UUID}(/(diff|changes))?$`),
  new RegExp(`^workspaces/${UUID}/merge-proposals$`),
  new RegExp(`^workspaces/${UUID}/merge-proposals/${UUID}(/(resolve|accept|reject))?$`),
  // Publication eligibility (W08), impact (W09), event-log reconstruction (W11), evidence dereference (W18).
  new RegExp(`^workspaces/${UUID}/(publication-eligibility|revalidation)$`),
  new RegExp(`^workspaces/${UUID}/impact/${METRIC}$`),
  new RegExp(`^workspaces/${UUID}/revisions/\\d{1,12}(/export)?$`),
  new RegExp(`^workspaces/${UUID}/evidence/${UUID}$`),
  // Scoped collaboration over HTTP (W15/W16): layout and notes only; PUT presence.
  new RegExp(`^workspaces/${UUID}/collab/(layout|notes)/(state|updates|presence)$`),
  new RegExp(`^workspaces/${UUID}/collab/layout/reconcile$`),
  // Research capsules (apps/api capsule-routes.ts). Export paths are matched by the API against the manifest.
  /^capsules$/,
  new RegExp(`^capsules/${CAPSULE}(/verify)?$`),
  new RegExp(`^capsules/${CAPSULE}/exports/(?!.*\\.\\.)[A-Za-z0-9._/-]{1,300}$`),
  new RegExp(`^runs/${UUID}$`),
  new RegExp(`^runs/${UUID}/cancel$`),
  new RegExp(`^runs/${UUID}/approvals(/\\d{1,18})?$`),
];
export const isAllowed = (path: string): boolean => ALLOWED.some((r) => r.test(path));
