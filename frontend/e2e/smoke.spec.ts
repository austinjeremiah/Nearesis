import { test, expect } from '@playwright/test';
import { devSignIn } from './auth';

test.describe('real stack smoke: dev login, workspaces, overview', () => {
  test('signed-out visitors are sent to /login', async ({ page }) => {
    await page.goto('/workspaces');
    await expect(page).toHaveURL(/\/login\?next=%2Fworkspaces/);
    // the wallet is the only sign-in offered; the development sign-in needs ?dev=1
    await expect(page.getByTestId('dev-login-button')).toHaveCount(0);
  });

  test('dev login, workspaces list, workspace overview, sign out', async ({ page }) => {
    await devSignIn(page);
    await expect(page.getByTestId('me-label')).toBeVisible();

    // The session cookie is HttpOnly: script cannot read it.
    expect(await page.evaluate(() => document.cookie)).not.toContain('nearesis_session');

    await page.goto('/workspaces');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    const objective = (await rows.first().locator('.strong').first().innerText()).trim();
    expect(objective.length).toBeGreaterThan(0);

    await rows.first().click();
    await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}\/overview$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(objective.slice(0, 20));
    await expect(page.getByTestId('supported-count')).toBeVisible();
    await expect(page.getByTestId('timeline').or(page.getByText('No activity yet'))).toBeVisible();

    // SSE hub: one proxied stream reaches "open".
    await expect(page.getByTestId('stream-status')).toHaveAttribute('data-status', 'open');

    // The canvas is connected: it renders real panels or the honest empty state.
    const wid = page.url().match(/\/w\/([0-9a-f-]{36})\//)![1];
    await page.goto(`/w/${wid}/canvas`);
    // the revision badge is always shown; the body is either the panel grid or the empty state, never both
    await expect(page.getByTestId('canvas-revision')).toBeVisible();
    await expect(page.getByTestId('canvas-grid').or(page.getByText('No panels yet'))).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/home');
    await expect(page).toHaveURL(/\/login/);
  });

  test('an unknown workspace is the protected not-found', async ({ page }) => {
    await devSignIn(page);
    const res = await page.goto('/w/00000000-0000-4000-8000-000000000000/overview');
    expect(res?.status()).toBe(404);
    await expect(page.getByText('does not exist, or you do not have access')).toBeVisible();
  });

  test('BFF proxy: authenticated read works, path traversal and owned routes are refused', async ({ page, request }) => {
    expect((await request.get('/api/k/workspaces')).status()).toBe(401);
    await devSignIn(page);
    const ok = await page.request.get('/api/k/workspaces');
    expect(ok.status()).toBe(200);
    expect(ok.headers()['x-trace-id']).toBeTruthy();
    expect((await page.request.post('/api/k/dev/login', { data: {} })).status()).toBe(404);
    expect((await page.request.get('/api/k/workspaces/%2e%2e/x')).status()).toBe(404);
  });
});
