import { test, expect, type Page } from '@playwright/test';

/** WS5: data area against the real API. No mocks, no page.route. */
async function login(page: Page) {
  await page.goto('/login');
  await page.getByTestId('dev-login-button').click();
  await expect(page).toHaveURL(/\/home$/);
}

test.describe('data area on the real stack', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('metric catalogue lists registry and authored metrics, uncertified are exploratory', async ({ page }) => {
    await page.goto('/data');
    const table = page.getByTestId('metric-catalogue').locator('table');
    await expect(table.locator('tbody tr').first()).toBeVisible();
    await expect(table.getByText('certified', { exact: true }).first()).toBeVisible();
    await expect(table.getByText('validated', { exact: true }).first()).toBeVisible();
    await expect(table.getByText('exploratory').first()).toBeVisible();
  });

  test('metric detail: authored version shows validation, exploratory banner, blocked publication', async ({ page }) => {
    await page.goto('/data');
    await page.getByRole('link', { name: 'Eval account activity' }).first().click();
    await expect(page.getByTestId('metric-detail')).toBeVisible();
    await expect(page.getByTestId('blocked')).toContainText('not certified');
    await expect(page.getByText('schema_allowlist_units').first()).toBeVisible();
    await page.getByTestId('act-explore').click();
    await expect(page.getByTestId('explore-result')).toContainText('EXPLORATORY');
  });

  test('metric authoring: propose with validation, then self-certification is refused or certify is gated', async ({ page }) => {
    await page.goto('/data');
    const ws = page.getByTestId('pm-workspace');
    await ws.selectOption({ index: 1 });
    const name = `ws5_probe_${Date.now()}`.slice(0, 40);
    await page.getByTestId('pm-name').fill(name);
    await page.getByTestId('pm-display').fill('WS5 probe daily transactions');
    await page.getByTestId('pm-desc').fill('Total NEAR transactions per UTC day from the daily table.');
    await page.getByTestId('pm-limit').fill('Counts transactions as delivered by the daily source.');
    await page.getByTestId('pm-submit').click();
    await expect(page.getByTestId('pm-result')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('link', { name: 'Open metric' }).click();
    await expect(page.getByTestId('metric-detail')).toBeVisible();
    await expect(page.getByText('exploratory').first()).toBeVisible();
    // dev owner authored it: the UI explains the API refuses self-certification
    const certify = page.getByTestId('act-certify');
    if (await certify.isEnabled()) {
      await certify.click();
      await expect(page.getByText(/self|different|author/i).first()).toBeVisible({ timeout: 30_000 });
    }
    // deprecate the probe so repeated runs do not pile up
    await page.getByTestId('dep-reason').fill('probe cleanup after e2e run');
    await page.getByTestId('act-deprecate').click();
    await expect(page.getByTestId('act-result')).toContainText('deprecated');
  });

  test('intents: summary numbers, unknown USD counted separately, CANNOT_COMPUTE solver metrics', async ({ page }) => {
    await page.goto('/data/intents');
    const summary = page.getByTestId('card-summary');
    await expect(summary).toContainText('swaps in the window', { timeout: 90_000 });
    await expect(page.getByTestId('usd-unknown')).toContainText('no USD value');
    await expect(page.getByTestId('card-trend').locator('table')).toBeVisible({ timeout: 90_000 });
    await page.getByRole('tab', { name: 'Settlement and solvers' }).click();
    await expect(page.getByTestId('card-solvers').getByTestId('cannot-compute')).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId('card-solvers')).toContainText('Missing inputs');
    await expect(page.getByTestId('settlement-caveat')).toBeVisible({ timeout: 90_000 });
    await page.getByRole('tab', { name: 'Chain flows' }).click();
    await expect(page.getByTestId('card-chain-flows').getByRole('img').first()).toBeVisible({ timeout: 90_000 });
  });

  test('quotes observatory: dry quotes only, no execute control, unsampled reads Not sampled', async ({ page }) => {
    await page.goto('/data/quotes');
    await expect(page.getByTestId('card-quotes')).toHaveAttribute('data-status', /OK|PARTIAL|CANNOT_COMPUTE/, { timeout: 90_000 });
    await expect(page.getByRole('button', { name: /execute|swap now|submit/i })).toHaveCount(0);
    await expect(page.getByTestId('quotes-view')).toContainText('no execute or swap control');
    const card = page.getByTestId('card-quotes');
    if ((await card.locator('table').count()) === 0) await expect(card).toContainText('Not sampled');
  });

  test('ecosystem: coverage, changes with unattributed growth, entity evidence labels', async ({ page }) => {
    await page.goto('/data/ecosystem');
    await expect(page.getByTestId('card-registry')).toContainText('verified', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Aurora (EVM on NEAR)' }).click();
    await expect(page.getByTestId('entity-detail')).toContainText('inferred', { timeout: 60_000 });
    await expect(page.getByRole('link', { name: 'evidence' }).first()).toHaveAttribute('href', /^https:/);
    await expect(page.getByTestId('window-distinct')).toContainText('cannot compute exactly', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Back to registry' }).click();
    await page.getByRole('tab', { name: 'Coverage' }).click();
    await expect(page.getByTestId('classified-share')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(page.getByTestId('unattributed-note')).toContainText('unattributed', { timeout: 90_000 });
  });

  test('accounts: window-start caveat and not-people notice', async ({ page }) => {
    await page.goto('/data/accounts');
    await expect(page.getByTestId('accounts-view')).toContainText('Accounts are not people');
    await expect(page.getByTestId('window-start-caveat')).toContainText('Window-start caveat', { timeout: 60_000 });
    await expect(page.getByTestId('card-highfreq').locator('table')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('card-highfreq')).toContainText('frequency');
  });

  test('economics: units not mixed, no invented USD', async ({ page }) => {
    await page.goto('/data/economics');
    await expect(page.getByTestId('gas-last-hour')).toContainText('Tgas', { timeout: 60_000 });
    await expect(page.getByTestId('economics-cannot-compute')).toHaveCount(0);
    await expect(page.getByTestId('card-eco-totals')).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
    await expect(page.getByTestId('card-eco-coverage')).toContainText('near_economics_gas_price_daily', { timeout: 60_000 });
    // USD only beside its dated price source
    const usd = page.getByTestId('eco-row-usd');
    for (let i = 0; i < (await usd.count()); i++) await expect(usd.nth(i)).toContainText('coingecko');
  });

  test('realtime: freshness, provisional kept apart from finalized', async ({ page }) => {
    await page.goto('/data/realtime');
    await expect(page.getByTestId('card-freshness')).toContainText('collector', { timeout: 60_000 });
    await expect(page.getByTestId('finalized')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('provisional')).toContainText('not in the finalized figure');
  });

  test('sources: health list, detail heatmap, errors and unrecorded rate limits', async ({ page }) => {
    await page.goto('/data/sources');
    const table = page.getByTestId('card-sources').locator('table');
    await expect(table.locator('tbody tr').first()).toBeVisible({ timeout: 60_000 });
    await expect(table).toContainText('near-bigquery');
    await page.getByRole('link', { name: 'near-bigquery' }).click();
    await expect(page.getByTestId('heatmap')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('card-errors')).toContainText('REFUND_SPLIT_IS_PROXY', { timeout: 60_000 });
    await expect(page.getByTestId('card-ratelimits')).toContainText('Not recorded', { timeout: 60_000 });
  });

  test('no fixture strings across data routes', async ({ page }) => {
    for (const r of ['/data', '/data/intents', '/data/quotes', '/data/ecosystem', '/data/accounts', '/data/economics', '/data/realtime', '/data/sources']) {
      await page.goto(r);
      const body = await page.locator('body').innerText();
      expect(body).not.toMatch(/snap_2026_11_09|FIXTURE|not connected/i);
    }
  });
});
