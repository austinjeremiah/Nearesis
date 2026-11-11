/**
 * Paths the same-origin BFF forwards to the kernel API (/v1/...). Ids follow the API's own formats: workspaces and runs
 * are UUIDs; approval ids are the numeric `runtime.run_events.id` (runs.ts approvalId).
 */
const UUID = "[0-9a-f-]{36}";
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
  new RegExp(`^runs/${UUID}$`),
  new RegExp(`^runs/${UUID}/cancel$`),
  new RegExp(`^runs/${UUID}/approvals(/\\d{1,18})?$`),
];
export const isAllowed = (path: string): boolean => ALLOWED.some((r) => r.test(path));
