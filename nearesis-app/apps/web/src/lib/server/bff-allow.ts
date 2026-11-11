/**
 * Paths the same-origin BFF forwards to the kernel API (/v1/...). Ids follow the API's own formats: workspaces and runs
 * are UUIDs; approval ids are the numeric `runtime.run_events.id` (runs.ts approvalId).
 */
const UUID = "[0-9a-f-]{36}";
const CAPSULE = "[A-Za-z0-9][A-Za-z0-9._-]{0,119}";
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
  // Research capsules (apps/api capsule-routes.ts). Export paths are matched by the API against the manifest.
  /^capsules$/,
  new RegExp(`^capsules/${CAPSULE}(/verify)?$`),
  new RegExp(`^capsules/${CAPSULE}/exports/(?!.*\\.\\.)[A-Za-z0-9._/-]{1,300}$`),
  new RegExp(`^runs/${UUID}$`),
  new RegExp(`^runs/${UUID}/cancel$`),
  new RegExp(`^runs/${UUID}/approvals(/\\d{1,18})?$`),
];
export const isAllowed = (path: string): boolean => ALLOWED.some((r) => r.test(path));
