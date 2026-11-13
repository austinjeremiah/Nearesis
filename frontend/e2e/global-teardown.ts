import { archiveTestWorkspaces } from './cleanup';

export default async function globalTeardown() {
  const start = Number(process.env.E2E_RUN_START ?? Date.now());
  await archiveTestWorkspaces((created) => created >= start - 5_000);
}
