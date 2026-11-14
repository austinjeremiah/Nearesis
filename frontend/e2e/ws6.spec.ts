import { execFileSync } from 'node:child_process';
import { appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { devSignIn } from './auth';

/**
 * History, branches, merges, capsules, publications, cost and presence, against the real stack.
 * Every test signs in through dev login and creates its own workspace. Capsules are built by the backend's
 * own rebuild CLI from its frozen synthetic snapshot and owned by the test workspace (no mocked responses).
 */
const APP = process.env.NEARESIS_APP_DIR ?? resolve(__dirname, '../../../nearesis-app');
const CAPSULE_ID = 'cap-synthetic-2026-11-10';
const CAPSULE_DIR = join(process.env.NEARESIS_CAPSULE_DIR ?? join(APP, '.data/capsules'), CAPSULE_ID);

const uuid = () => crypto.randomUUID();

async function login(page: Page) {
  await devSignIn(page);
}
async function api<T = any>(page: Page, method: 'get' | 'post' | 'put', path: string, data?: unknown): Promise<T> {
  const res = await page.request.fetch(`/api/k/${path}`, { method, data, headers: { 'idempotency-key': uuid() } });
  const body = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${body}`);
  return (body ? JSON.parse(body) : null) as T;
}
async function newWorkspace(page: Page, objective: string) {
  const key = uuid();
  const r = await page.request.post('/api/k/workspaces', {
    data: { objective, networkScope: 'fixture-only', idempotencyKey: key },
    headers: { 'idempotency-key': key },
  });
  expect(r.status()).toBeLessThan(300);
  return ((await r.json()) as { workspaceId: string }).workspaceId;
}
const version = async (page: Page, wid: string) => (await api(page, 'get', `workspaces/${wid}`)).version as number;
async function snapshot(page: Page, wid: string, label: string) {
  const r = await api(page, 'post', `workspaces/${wid}/snapshots`, { expectedVersion: await version(page, wid), label });
  return r.result.snapshotId as string;
}
async function mainBranch(page: Page, wid: string) {
  return (await api(page, 'get', `workspaces/${wid}/branches`)).branches.find((b: any) => b.isMain).id as string;
}

test.describe('time machine', () => {
  test('snapshots carry a data vintage, are labelled historical, compare and revision views work', async ({ page }) => {
    await login(page);
    const wid = await newWorkspace(page, `WS6 time machine ${Date.now()}`);
    await page.goto(`/w/${wid}/history`);
    await page.getByTestId('snapshot-label').fill('first');
    await page.getByTestId('snapshot-create').click();
    await expect(page.getByTestId('snapshot-view')).toHaveAttribute('data-historical', 'true');
    await expect(page.getByText('Historical view', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('snapshot-view').getByText('Data vintage')).toBeVisible();
    await expect(page.getByText('hash verified')).toBeVisible();
    const hash = await page.getByTestId('snapshot-hash').getAttribute('data-full');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    await page.getByTestId('snapshot-label').fill('second');
    await page.getByTestId('snapshot-create').click();
    await expect(page.locator('table', { hasText: 'Snapshots' }).first().locator('tbody tr')).toHaveCount(2);
    await page.getByTestId('compare-a').selectOption({ label: 'first' });
    await page.getByTestId('compare-b').selectOption({ label: 'second' });
    await page.getByTestId('compare-run').click();
    await expect(page.getByTestId('compare-result')).toBeVisible();

    // A revision is a journal sequence number; reconstruct revision 1.
    await page.locator('table', { hasText: 'Revision timeline' }).locator('tbody tr').last().click();
    await expect(page.getByTestId('revision-view')).toBeVisible();
    await expect(page.getByTestId('revision-view')).toHaveAttribute('data-exact', /true|false/);
  });

  test('a purged snapshot shows vintage_unavailable and never current data', async ({ page }) => {
    await login(page);
    const wid = await newWorkspace(page, `WS6 purge ${Date.now()}`);
    const sid = await snapshot(page, wid, 'to be purged');
    await api(page, 'post', `workspaces/${wid}/snapshots/purge`, { expectedVersion: await version(page, wid), snapshotId: sid, reason: 'e2e retention purge' });
    await page.goto(`/w/${wid}/history`);
    await page.locator('table', { hasText: 'Snapshots' }).first().locator('tbody tr', { hasText: 'to be purged' }).click();
    const note = page.getByTestId('vintage-unavailable');
    await expect(note).toBeVisible();
    await expect(note).toContainText('vintage_unavailable');
    await expect(note).toContainText('not shown in its place');
    await expect(page.getByTestId('snapshot-view')).toHaveCount(0);
  });
});

test.describe('branches and merges', () => {
  test('create a branch, record a change, diff, propose and accept a merge into main', async ({ page }) => {
    await login(page);
    const wid = await newWorkspace(page, `WS6 branches ${Date.now()}`);
    await snapshot(page, wid, 'base');
    await page.goto(`/w/${wid}/branches`);
    await page.getByTestId('branch-name').fill('alt-view');
    await page.getByTestId('branch-from').selectOption({ label: 'base' });
    await page.getByTestId('branch-create').click();
    await expect(page.getByTestId('branch-detail')).toBeVisible();
    await page.getByTestId('change-label').fill('alternative claim');
    await page.getByTestId('change-add').click();
    await expect(page.getByTestId('diff-list').first()).toContainText('alternative claim');
    await expect(page.getByTestId('diff-list').first()).toContainText('added');
    await page.getByTestId('propose-merge').click();
    const detail = page.getByTestId('proposal-detail');
    await expect(detail).toHaveAttribute('data-status', 'open');
    await expect(page.getByTestId('unresolved-count')).toHaveText('0');
    await page.getByTestId('merge-accept').click();
    await expect(detail).toHaveAttribute('data-status', 'accepted');
    await expect(page.getByText('Proposal accepted')).toBeVisible();
  });

  test('a conflicting merge needs every conflict resolved, takes reviewer comments, then merges', async ({ page }) => {
    await login(page);
    const wid = await newWorkspace(page, `WS6 conflict ${Date.now()}`);
    const sid = await snapshot(page, wid, 'base');
    const br = await api(page, 'post', `workspaces/${wid}/branches`, { expectedVersion: await version(page, wid), fromSnapshotId: sid, name: 'conflicting' });
    const bid = br.result.branchId as string;
    const node = uuid();
    await api(page, 'post', `workspaces/${wid}/graph/nodes`, { expectedVersion: await version(page, wid), nodeId: node, kind: 'claim', label: 'main version' });
    await api(page, 'post', `workspaces/${wid}/branches/${bid}/changes`, {
      expectedVersion: await version(page, wid),
      ops: [{ op: 'set', objectId: `node:${node}`, value: { kind: 'claim', label: 'branch version' } }],
    });
    await page.goto(`/w/${wid}/branches`);
    await page.locator('table', { hasText: 'Branches' }).locator('tbody tr', { hasText: 'conflicting' }).click();
    await page.getByTestId('propose-merge').click();
    await expect(page.getByTestId('unresolved-count')).toHaveText('1');
    const accept = page.getByTestId('merge-accept');
    await expect(accept).toBeDisabled();
    // reviewer comment on the conflicting node
    await page.getByTestId('comment-node').fill(node);
    await page.getByTestId('comment-body').fill('please justify the branch wording');
    await page.getByTestId('comment-add').click();
    await expect(page.getByTestId('comments')).toContainText('please justify the branch wording');
    await page.getByTestId('resolve-theirs').click();
    await expect(page.getByTestId('unresolved-count')).toHaveText('0');
    await expect(accept).toBeEnabled();
    await accept.click();
    await expect(page.getByTestId('proposal-detail')).toHaveAttribute('data-status', 'accepted');
  });
});

test.describe('capsules and publications', () => {
  test.describe.configure({ mode: 'serial' });
  let wid = '';
  let orgId = '';
  /** Rebuild the synthetic capsule with the backend's own CLI from its frozen snapshot, owned by the given workspace. */
  const rebuild = (org: string, workspaceId: string) => {
    rmSync(CAPSULE_DIR, { recursive: true, force: true });
    execFileSync('corepack', ['pnpm', 'exec', 'tsx', 'src/cli.ts', 'rebuild', '--snapshot', 'fixtures/snapshot-synthetic', '--out', CAPSULE_DIR, '--org', org, '--workspace', workspaceId, '--no-wasm'], {
      cwd: join(APP, 'packages/capsule'),
      stdio: 'pipe',
      timeout: 120_000,
    });
  };
  // The cautionary test tampers with an export; leave the shared capsule pristine for whoever runs next.
  test.afterAll(() => {
    if (orgId && wid) rebuild(orgId, wid);
  });

  test('list, detail with separate reproduced and attested claims, verify, publish, public page, unpublish', async ({ page }) => {
    await login(page);
    wid = await newWorkspace(page, `WS6 capsules ${Date.now()}`);
    const w = await api(page, 'get', `workspaces/${wid}`);
    orgId = w.orgId;
    rebuild(orgId, wid);
    await page.goto(`/w/${wid}/capsules`);
    await page.getByTestId('capsule-link').first().click();
    await expect(page).toHaveURL(new RegExp(`/capsules/${CAPSULE_ID}$`));
    const badges = page.getByTestId('capsule-badges');
    await expect(badges).toContainText('Reproduced (local recomputation)');
    await expect(badges).toContainText('Not attested: no OutLayer job submitted');
    await expect(badges).not.toContainText('Attested (OutLayer)');
    await expect(page.getByText('Input integrity')).toBeVisible();
    await expect(page.getByTestId('outlayer-detail')).toContainText('No OutLayer job');
    await expect(page.getByTestId('no-prereg')).toBeVisible();

    await page.getByTestId('verify-run').click();
    await expect(page.getByTestId('verify-report')).toHaveAttribute('data-status', 'reproduced');
    await expect(page.getByTestId('verify-report')).toContainText('not an OutLayer attestation');

    // an export download matches its listed hash and the x-capsule-sha256 header
    const row = page.getByTestId('export-row').first();
    await row.getByTestId('export-check').click();
    await expect(row.getByText('hash matches')).toBeVisible();

    // publish check: an unknown metric is METRIC_NOT_CERTIFIED
    const select = page.getByTestId('check-metric');
    const options = await select.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(1);

    await page.getByTestId('publish').click();
    await expect(page.getByTestId('unpublish')).toBeVisible();
    await page.getByTestId('export-bundle').click();
    await expect(page.getByTestId('bundle-result')).toBeVisible();
    await expect(page.getByTestId('bundle-result')).toContainText('valid');
    await expect(page.getByTestId('bundle-result')).toContainText('Signed with a hardened key');

    // global publications list shows it as published
    await page.goto('/publications');
    const pubRow = page.locator('table tbody tr', { hasText: 'SYNTHETIC' }).first();
    await expect(pubRow).toContainText('published');

    // public page
    await page.goto(`/public/${CAPSULE_ID}`);
    await expect(page.getByTestId('public-publication')).toBeVisible();
    await expect(page.getByTestId('public-limitations')).toContainText('SYNTHETIC');

    // signed out, the public page reads the publication anonymously (no cookie)
    const out = await page.context().browser()!.newContext();
    const anon = await out.newPage();
    await anon.goto(`http://127.0.0.1:${process.env.E2E_PORT ?? 3400}/public/${CAPSULE_ID}`);
    await expect(anon.getByTestId('public-publication')).toBeVisible();
    await out.close();

    // unpublish removes it from the public reader
    await page.goto(`/w/${wid}/capsules/${CAPSULE_ID}`);
    await page.getByTestId('unpublish').click();
    await expect(page.getByTestId('publish')).toBeVisible();
    await page.goto(`/public/${CAPSULE_ID}`);
    await expect(page.getByTestId('public-withdrawn')).toBeVisible();
  });

  test('cautionary statuses need acknowledgement; a failed verification is one of them', async ({ page }) => {
    await login(page);
    // tamper with an export so local verification no longer reproduces
    appendFileSync(join(CAPSULE_DIR, 'exports/DATA.md'), '\ntampered\n');
    await page.goto(`/w/${wid}/capsules/${CAPSULE_ID}`);
    await expect(page.getByTestId('capsule-badges')).toContainText(/Not reproduced/);
    await page.getByTestId('publish').click();
    const list = page.getByTestId('ack-checklist');
    await expect(list).toBeVisible();
    await expect(page.getByTestId('action-error').first()).toHaveAttribute('data-reason', 'ACKNOWLEDGEMENT_REQUIRED');
    await expect(page.getByTestId('ack-VERIFICATION_FAILED')).toBeVisible();
    await page.getByTestId('ack-VERIFICATION_FAILED').check();
    await page.getByTestId('publish').click();
    await expect(page.getByTestId('unpublish')).toBeVisible();
    await page.getByTestId('unpublish').click();
    await expect(page.getByTestId('publish')).toBeVisible();
  });

  test('publish-check refuses an uncertified metric with METRIC_NOT_CERTIFIED', async ({ page }) => {
    await login(page);
    const metrics = await api(page, 'get', 'metrics');
    const draft = metrics.metrics.find((m: any) => m.status !== 'CERTIFIED');
    test.skip(!draft, 'no non-certified metric exists on this stack');
    await page.goto(`/w/${wid}/capsules/${CAPSULE_ID}`);
    await page.getByTestId('check-metric').selectOption(draft.metricKey);
    await page.getByTestId('check-run').click();
    await expect(page.getByTestId('action-error')).toHaveAttribute('data-reason', 'METRIC_NOT_CERTIFIED');
  });
});

test.describe('cost', () => {
  test('burn, projection label, unknown prices, global ceiling', async ({ page }) => {
    await login(page);
    const wid = await newWorkspace(page, `WS6 cost ${Date.now()}`);
    await page.goto(`/w/${wid}/cost`);
    await expect(page.getByTestId('burn')).toBeVisible();
    await expect(page.getByTestId('no-cap')).toBeVisible();
    await expect(page.getByTestId('forecast').first()).toContainText('Projection, not a measurement');
    await expect(page.getByTestId('forecast-assumptions').first()).toBeVisible();
    // a resource that was never metered is "not metered", never 0
    await expect(page.getByText('not metered').first()).toBeVisible();
    await expect(page.getByTestId('global-cost')).toBeVisible();
    await expect(page.getByTestId('global-cost')).toContainText('Committed of ceiling');
    // set a cap
    await page.getByTestId('cap-input').fill('1.5');
    await page.getByTestId('cap-save').click();
    await expect(page.getByText('/ $1.50')).toBeVisible();
    await expect(page.getByTestId('no-cap')).toHaveCount(0);
  });
});

test.describe('collaboration presence', () => {
  test('the collaboration socket opens with a ticket and reports live presence', async ({ page, browser }) => {
    await login(page);
    const wid = await newWorkspace(page, `WS6 presence ${Date.now()}`);
    await page.goto(`/w/${wid}/history`);
    await expect(page.getByTestId('presence')).toHaveAttribute('data-status', 'open', { timeout: 20_000 });
    await expect(page.getByTestId('collaborator-count')).toContainText('member');
    // the ticket is single use: the bearer never reaches script
    expect(await page.evaluate(() => document.cookie)).not.toContain('nearesis_session');

    // a second signed-in context in the same workspace is seen as a peer
    const ctx2: BrowserContext = await browser.newContext();
    const p2 = await ctx2.newPage();
    await login(p2);
    await p2.goto(`/w/${wid}/history`);
    await expect(p2.getByTestId('presence')).toHaveAttribute('data-status', 'open', { timeout: 20_000 });
    await expect(page.getByTestId('presence')).not.toHaveAttribute('data-peers', '0', { timeout: 20_000 });
    await ctx2.close();
  });
});
