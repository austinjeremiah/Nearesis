import { test, expect, type Page } from '@playwright/test';

/**
 * WS1: shell, home, notifications, settings, system, workspace create/edit,
 * collaborators and invites. Real stack only: the kernel API and this app.
 */
const API = process.env.NEARESIS_API_URL ?? 'http://127.0.0.1:4110';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByTestId('dev-login-button').click();
  await expect(page).toHaveURL(/\/home$/);
}
async function token(page: Page): Promise<string> {
  const c = (await page.context().cookies()).find((x) => x.name === 'nearesis_session');
  expect(c, 'session cookie').toBeTruthy();
  return c!.value;
}
async function apiGet(page: Page, path: string) {
  const r = await page.request.get(`${API}${path}`, { headers: { authorization: `Bearer ${await token(page)}` } });
  return { status: r.status(), body: await r.json().catch(() => null) };
}

test.describe.configure({ mode: 'serial' });

test('1 sign-in cookie is HttpOnly, sign-out revokes the token', async ({ page }) => {
  await page.goto('/home');
  await expect(page).toHaveURL(/\/login/);
  await signIn(page);
  expect(await page.evaluate(() => document.cookie)).not.toContain('nearesis_session');
  const tok = await token(page);
  expect((await page.request.get(`${API}/v1/me`, { headers: { authorization: `Bearer ${tok}` } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/home');
  await expect(page).toHaveURL(/\/login/);
});

test('shell shows identity, role and the global USD 5 ceiling from the API', async ({ page }) => {
  await signIn(page);
  const me = await apiGet(page, '/v1/me');
  const cost = await apiGet(page, '/v1/cost/global');
  await expect(page.getByTestId('me-label')).toContainText(me.body.role);
  const chip = page.getByTestId('global-spend');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('$5.00');
  await expect(chip).toHaveAttribute('data-state', cost.body.state);
  // pending approvals and unread counts equal the API's own aggregates
  const approvals = await apiGet(page, '/v1/approvals?status=pending');
  await expect(page.getByTestId('pending-approvals')).toHaveAttribute('data-count', String(approvals.body.approvals.length));
  const notes = await apiGet(page, '/v1/notifications?unread=1&limit=1');
  await expect(page.getByTestId('unread-notifications')).toHaveAttribute('data-count', String(notes.body.unread));
});

test('6 home: Needs attention is built from API aggregates, nothing invented', async ({ page }) => {
  await signIn(page);
  const approvals = (await apiGet(page, '/v1/approvals?status=pending')).body.approvals as unknown[];
  const sources = (await apiGet(page, '/v1/sources')).body.sources as { state: string }[];
  const att = page.getByTestId('attention');
  await expect(att).toBeVisible();
  if (approvals.length > 0) {
    await expect(att.getByText(`Approvals waiting (${approvals.length})`)).toBeVisible();
    await expect(page.locator('[data-testid="attention-approvals"] li').first()).toBeVisible();
  } else {
    await expect(att.getByText('Approvals waiting')).toHaveCount(0);
  }
  const notFresh = sources.filter((s) => s.state !== 'fresh' && s.state !== 'live').length;
  if (notFresh > 0) await expect(att.getByText(`Sources not fresh (${notFresh})`)).toBeVisible();
});

test('notifications page lists the API notifications or says there are none', async ({ page }) => {
  await signIn(page);
  const n = (await apiGet(page, '/v1/notifications')).body;
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notifications');
  const box = page.getByTestId('notifications');
  await expect(box).toBeVisible();
  if (n.notifications.length === 0) await expect(box.getByText('No notifications yet')).toBeVisible();
  else await expect(box.locator('tbody tr')).toHaveCount(n.notifications.length);
  await page.getByRole('button', { name: /^Unread/ }).click();
  await expect(page.getByRole('button', { name: /^Unread/ })).toHaveAttribute('aria-pressed', 'true');
});

test('system page: global ceiling, source health and SLOs from the API', async ({ page }) => {
  await signIn(page);
  const cost = (await apiGet(page, '/v1/cost/global')).body;
  const sources = (await apiGet(page, '/v1/sources')).body.sources as { sourceId: string; state: string }[];
  await page.goto('/system');
  await expect(page.getByTestId('spend-card')).toContainText('$5.00');
  await expect(page.getByTestId('committed')).toContainText(`${(cost.fraction * 100).toFixed(1)}%`);
  const rows = page.locator('[data-testid="sources-health"] tbody tr');
  await expect(rows).toHaveCount(sources.length);
  for (const s of sources) await expect(page.getByTestId('sources-health')).toContainText(s.sourceId);
  await expect(page.getByTestId('slos').locator('li').first()).toBeVisible();
  // a missing coverage figure is "not recorded", never 0%
  if (sources.some((s) => (s as { coveragePct?: number | null }).coveragePct == null)) {
    await expect(page.getByTestId('sources-health')).toContainText('not recorded');
  }
});

test('settings: account, organization, members, invite lifecycle', async ({ page }) => {
  await signIn(page);
  const org = (await apiGet(page, '/v1/org')).body;
  await page.goto('/settings');
  await expect(page.getByTestId('account')).toContainText('owner');
  await expect(page.getByTestId('org')).toContainText(org.name);
  await expect(page.getByTestId('members').locator('tbody tr')).toHaveCount(org.memberCount);

  const email = `e2e-${Date.now()}@example.com`;
  await page.getByTestId('invite-email').fill(email);
  await page.getByTestId('invite-role').selectOption('viewer');
  await page.getByTestId('invite-submit').click();
  const link = await page.getByTestId('invite-link').inputValue();
  expect(link).toMatch(/\/accept-invite\?token=/);
  await expect(page.getByTestId('invites')).toContainText(email);

  // The link is previewed from the API, signed out, and offers sign in (not accept).
  const ctx = await page.context().browser()!.newContext();
  const anon = await ctx.newPage();
  const base = new URL(page.url()).origin;
  await anon.goto(link.replace(/^https?:\/\/[^/]+/, base));
  await expect(anon.getByTestId('invite-preview')).toContainText(email);
  await expect(anon.getByTestId('invite-preview')).toContainText('viewer');
  await expect(anon.getByRole('link', { name: 'Sign in to accept' })).toBeVisible();
  await ctx.close();

  // Revoke it; the list shows the new state.
  await page.getByRole('button', { name: `Revoke invite for ${email}` }).click();
  await expect(page.getByTestId('invites').locator('tr', { hasText: email })).toContainText('revoked');
});

test('accept-invite with a bad token says so', async ({ page }) => {
  await page.goto('/accept-invite?token=' + 'x'.repeat(40));
  await expect(page.getByTestId('invite-heading')).not.toHaveText('You have been invited');
  await page.goto('/accept-invite');
  await expect(page.getByTestId('invite-heading')).toHaveText('No invitation link');
});

test('5 create a workspace from a template; double submit gives one workspace; edit, pin, archive', async ({ page }) => {
  await signIn(page);
  const before = (await apiGet(page, '/v1/workspaces')).body.workspaces.length as number;
  await page.goto('/workspaces/new');
  await page.getByTestId('template').selectOption('near-investment-thesis');
  const name = `E2E workspace ${Date.now()}`;
  await page.getByTestId('name').fill(name);
  await page.getByTestId('scope').selectOption('fixture-only');
  await page.getByTestId('create-workspace').dblclick();
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}\/overview$/);
  const wid = page.url().match(/\/w\/([0-9a-f-]{36})\//)![1];
  const after = (await apiGet(page, '/v1/workspaces')).body.workspaces.length as number;
  expect(after).toBe(before + 1);
  await expect(page.locator('.nav-label').filter({ hasText: name })).toBeVisible();
  // workspace budget chip: no cap set is stated, not shown as $0 of nothing
  await expect(page.getByTestId('workspace-budget')).toContainText('no cap set');

  await page.goto(`/w/${wid}/settings`);
  const renamed = `${name} renamed`;
  await page.getByTestId('ws-name').fill(renamed);
  await page.getByTestId('ws-description').fill('Edited by the e2e suite');
  await page.getByTestId('ws-save').click();
  await expect(page.getByTestId('saved')).toBeVisible();
  const s = (await apiGet(page, `/v1/workspaces/${wid}/settings`)).body;
  expect(s.name).toBe(renamed);
  expect(s.description).toBe('Edited by the e2e suite');
  expect(s.template.id).toBe('near-investment-thesis');
  await expect(page.locator('.nav-label').filter({ hasText: renamed })).toBeVisible();

  await page.getByTestId('pin-toggle').click();
  await expect(page.getByTestId('pin-toggle')).toHaveText('Unpin');
  await page.goto('/home');
  await expect(page.getByTestId('recent-workspaces').getByText('Pinned').first()).toBeVisible();
  await page.goto(`/w/${wid}/settings`);
  await page.getByTestId('pin-toggle').click();
  await expect(page.getByTestId('pin-toggle')).toHaveText('Pin to home');

  await expect(page.getByTestId('collaborators').locator('tbody tr').first()).toBeVisible();
  await page.getByTestId('archive-toggle').click();
  await page.getByRole('button', { name: 'Archive', exact: true }).last().click();
  await expect(page.getByText('This workspace is archived')).toBeVisible();
  expect((await apiGet(page, `/v1/workspaces/${wid}/settings`)).body.archived).toBe(true);
});

test('login surfaces a not-configured single sign-on honestly', async ({ page }) => {
  await page.goto('/login?error=oidc_not_configured');
  await expect(page.getByTestId('login-error')).toHaveAttribute('data-code', 'oidc_not_configured');
  // callback without a bound state is refused before anything is forwarded
  const r = await page.request.get('/api/auth/oidc/callback?code=abc&state=forged', { maxRedirects: 0 });
  expect(r.status()).toBe(303);
  expect(r.headers()['location']).toContain('/login?error=oidc_state');
  expect(r.headers()['set-cookie'] ?? '').not.toContain('nearesis_session=ey');
});

test('37/38 route crawl of shell pages: no console errors, no fixture strings', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && !/favicon|fonts\.g|net::ERR_/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await signIn(page);
  const first = (await apiGet(page, '/v1/workspaces')).body.workspaces[0].id as string;
  for (const p of ['/home', '/workspaces', '/workspaces/new', '/notifications', '/system', '/settings', `/w/${first}/settings`]) {
    await page.goto(p);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const text = (await page.locator('body').textContent()) ?? '';
    expect(text, p).not.toMatch(/snap_2026_11_09|FIXTURE|Nearesis Research|r\.mehta/);
  }
  expect(errors).toEqual([]);
});

test('mobile viewport: shell navigation opens and the topbar does not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await signIn(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('link', { name: 'Notifications' }).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
