import { archiveTestWorkspaces } from './cleanup';

export default async function globalSetup() {
  const start = Date.now();
  process.env.E2E_RUN_START = String(start);
  // Opt-in: also archive test workspaces left by earlier or aborted runs (they can belong to someone else's live run,
  // so this never happens unless asked). E2E_ARCHIVE_STALE=1 playwright test ...
  if (process.env.E2E_ARCHIVE_STALE === '1') await archiveTestWorkspaces((created) => created < start);
}
