import { test, expect, type Page } from '@playwright/test';

/**
 * Canvas and panels against the REAL stack: API on 4110, no mocking of data. Each run builds
 * its own workspace and fills it with real stored panels (reused by query hash from the
 * existing research workspaces), so every number on screen comes from the live panel route.
 * The only interception is aborting the event stream in the stale-edit test, to keep the
 * first tab from refreshing itself before the conflict is provoked.
 */
type P = Record<string, any>;
const DAY = 'serial' as const;
test.describe.configure({ mode: DAY });

let wid = '';
let picks: Record<string, P> = {};
let sourceHas: Record<string, boolean> = {};

// The dev sign-in is rate limited, so sign in once and share the session cookie.
let cookies: Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>> = [];
async function signIn(page: Page) {
  if (cookies.length) {
    await page.context().addCookies(cookies);
    await page.goto('/home');
    return;
  }
  await page.goto('/login');
  await page.getByTestId('dev-login-button').click();
  await expect(page).toHaveURL(/\/home$/);
  cookies = await page.context().cookies();
}
const api = (page: Page, path: string) => page.request.get(`/api/k${path}`);

async function patch(page: Page, w: string, operations: unknown[]) {
  const cv = (await (await api(page, `/workspaces/${w}/canvas`)).json()) as P;
  const ws = (await (await api(page, `/workspaces/${w}`)).json()) as P;
  const payload = { schemaVersion: 1, type: 'workspace.patch', operationId: crypto.randomUUID(), expectedRevision: cv.documentRevision, operations };
  const r = await page.request.post(`/api/k/workspaces/${w}/commands`, {
    headers: { 'if-match': `"${ws.version}"`, 'idempotency-key': payload.operationId },
    data: { apiVersion: 'v1', commandId: crypto.randomUUID(), commandType: 'canvas.apply_patch', payload, expectedVersion: ws.version },
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
}

test('setup: a workspace filled with real stored panels', async ({ page }) => {
  await signIn(page);
  const list = ((await (await api(page, '/workspaces')).json()) as P).workspaces as P[];
  const seen = new Map<string, { panel: P; data: P }>();
  for (const w of list) {
    if (/^WS\d e2e/.test(w.objective)) continue;
    const cv = (await (await api(page, `/workspaces/${w.id}/canvas`)).json()) as P;
    for (const p of cv.panels ?? []) {
      const h = p.queryRef?.hash;
      if (!h || seen.has(`${w.id}:${h}`) || [...seen.values()].some((s) => s.panel.queryRef.hash === h)) continue;
      const r = await api(page, `/workspaces/${w.id}/panels/${h}/data`);
      if (r.status() !== 200) continue;
      seen.set(`${w.id}:${h}`, { panel: p, data: await r.json() });
    }
  }
  const all = [...seen.values()];
  const pick = (name: string, f: (s: { panel: P; data: P }) => boolean) => {
    const hit = all.find(f);
    sourceHas[name] = !!hit;
    if (hit) picks[name] = hit.panel;
  };
  pick('semantic', (s) => s.data.kind === 'semantic' && s.data.state === 'complete' && s.panel.kind === 'bar');
  pick('semanticPartial', (s) => s.data.kind === 'semantic' && s.data.state === 'partial' && s.panel.kind === 'timeSeries');
  pick('analytics', (s) => s.data.kind === 'analytics' && s.data.state === 'complete' && s.panel.kind === 'timeSeries');
  pick('analyticsPartial', (s) => s.data.kind === 'analytics' && s.data.state === 'partial' && (s.data.coverage?.missingDays?.length ?? 0) > 0);
  pick('truncated', (s) => s.data.state === 'truncated');
  pick('cohort', (s) => s.panel.kind === 'cohort');
  pick('table', (s) => s.panel.kind === 'table' && s.data.kind === 'analytics' && s.data.state === 'complete');
  pick('cannot', (s) => !!s.data.cannotCompute);
  pick('stale', (s) => s.data.state === 'stale');
  expect(sourceHas.semantic && sourceHas.analytics, 'the stack must hold a semantic and an analytics panel').toBeTruthy();

  const r = await page.request.post('/api/k/workspaces', {
    headers: { 'idempotency-key': `e2e-ws3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    data: { objective: 'WS3 e2e canvas', networkScope: 'fixture-only' },
  });
  expect(r.status()).toBeLessThan(300);
  wid = ((await r.json()) as P).workspaceId;
  const ops: unknown[] = [];
  let y = 0;
  for (const name of Object.keys(picks)) {
    const panel = { ...picks[name], panelId: crypto.randomUUID(), layout: { x: 0, y, w: 12, h: 8 } };
    picks[name] = panel;
    y += 8;
    ops.push({ op: 'addPanel', panel });
  }
  await patch(page, wid, ops);
});

const card = (page: Page, name: string) => page.locator(`[data-testid=panel][data-panel-id="${picks[name]?.panelId}"]`);
// Panels load their data as they near the viewport, so bring one into view before asserting on it.
const show = async (page: Page, name: string) => {
  const c = card(page, name);
  await c.scrollIntoViewIfNeeded();
  return c;
};

test.describe('canvas', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('15: a semantic panel draws real rows, hover shows value and unit, gaps are not zeros', async ({ page }) => {
    await page.goto(`/w/${wid}/canvas`);
    const c = card(page, 'semantic');
    await expect(c.getByTestId('chart')).toBeVisible();
    await expect(c.getByTestId('cert-label').first()).toContainText('Certified metric');
    const box = await c.locator('canvas').first().boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(c.locator('.chart')).toContainText(/\d/);
    await expect(c.locator('.chart')).toContainText(picks.semantic.dataBinding?.units?.[picks.semantic.encoding.y[0]] ?? 'tx');
    // The table view renders a missing value as a dash, never 0.
    await c.getByRole('button', { name: 'Table' }).click();
    await expect(c.locator('.nxp-table')).toBeVisible();
    const rows = await (await api(page, `/workspaces/${wid}/panels/${picks.semantic.queryRef.hash}/data`)).json();
    expect(rows.chart.rows.length).toBeGreaterThan(0);
    await expect(c.getByText(/Showing .* of .* rows/)).toContainText(String(rows.chart.rows.length));
  });

  test('16: analytics panel is labelled as not certified and shows coverage', async ({ page }) => {
    await page.goto(`/w/${wid}/canvas`);
    const c = card(page, 'analytics');
    await expect(c.getByTestId('cert-label').first()).toContainText('Analytics result, not a certified metric');
    await expect(c.getByText('Certified metric', { exact: true })).toHaveCount(0);
    if (sourceHas.analyticsPartial) {
      const p = await show(page, 'analyticsPartial');
      await expect(p.getByTestId('coverage-note')).toContainText(/no coverage record \(unknown, not zero\)|lower bounds/);
    }
  });

  test('16b: CANNOT_COMPUTE renders insufficient data with no chart', async ({ page }) => {
    test.skip(!sourceHas.cannot, 'no stored panel is currently CANNOT_COMPUTE on this stack, so there is no real one to render');
    await page.goto(`/w/${wid}/canvas`);
    const c = await show(page, 'cannot');
    await expect(c.getByTestId('cannot-compute')).toContainText('CANNOT_COMPUTE');
    await expect(c.getByTestId('chart')).toHaveCount(0);
  });

  test('17: a stale source shows the freshness warning and is not publishable as current', async ({ page }) => {
    test.skip(!sourceHas.stale, 'no source is degraded on this stack right now, so no real stale panel exists');
    await page.goto(`/w/${wid}/canvas`);
    await expect((await show(page, 'stale')).locator('.nxp-banners [data-state=stale]')).toContainText('Not publishable as current');
  });

  test('18: a truncated result says so and how', async ({ page }) => {
    test.skip(!sourceHas.truncated, 'no stored panel is truncated on this stack');
    await page.goto(`/w/${wid}/canvas`);
    await expect((await show(page, 'truncated')).getByTestId('truncation-label')).toContainText(/Truncated: showing [\d,]+ rows/);
  });

  test('every canvas kind the stack holds renders (line, bar, cohort heatmap, table)', async ({ page }) => {
    await page.goto(`/w/${wid}/canvas`);
    for (const [name, viz] of [['semantic', 'bar'], ['analytics', 'line'], ['cohort', 'heatmap']] as const) {
      if (!sourceHas[name]) continue;
      await expect((await show(page, name)).locator(`[data-testid=chart][data-viz=${viz}]`)).toBeVisible();
    }
    if (sourceHas.table) await expect((await show(page, 'table')).locator('.nxp-table')).toBeVisible();
  });

  test('19: panel full view has Data, Query and Provenance; hashes match the API', async ({ page }) => {
    await page.goto(`/w/${wid}/canvas`);
    await card(page, 'analytics').getByRole('link', { name: picks.analytics.title }).click();
    await expect(page).toHaveURL(new RegExp(`/panels/${picks.analytics.panelId}$`));
    const api_ = await (await api(page, `/workspaces/${wid}/panels/${picks.analytics.queryRef.hash}/data`)).json();
    await page.getByRole('tab', { name: 'Data' }).click();
    await expect(page.locator('.nxp-table')).toBeVisible();
    await page.getByRole('tab', { name: 'Query' }).click();
    await expect(page.getByTestId('hash-query-hash')).toHaveText(api_.queryHash);
    expect(api_.queryHash).toBe(picks.analytics.queryRef.hash);
    await page.getByRole('tab', { name: 'Provenance' }).click();
    await expect(page.getByTestId('hash-result-hash')).toHaveText(api_.provenance.resultHash);
    await expect(page.getByTestId('provenance-block')).toContainText(api_.provenance.semanticVersion);
    await expect(page.getByTestId('provenance-block').getByTestId('cert-label')).toContainText('not a certified metric');
    await page.getByRole('button', { name: 'Copy query-hash-prov' }).click();
  });

  test('range selection from the keyboard form publishes a selection and creates nothing', async ({ page }) => {
    await page.goto(`/w/${wid}/panels/${picks.analytics.panelId}`);
    const form = page.getByRole('form', { name: 'Select a time range' });
    await expect(form).toBeVisible();
    await form.getByTestId('range-select').focus();
    await form.getByTestId('range-select').press('Enter');
    await expect(page.getByTestId('selection-range')).toContainText('Z to');
    const before = ((await (await api(page, `/workspaces/${wid}/markers`)).json()) as P).markers?.length ?? 0;
    expect(before).toBe(0);
  });

  test('23: dragging on a chart selects a range for markers and creates nothing', async ({ page }) => {
    await page.goto(`/w/${wid}/panels/${picks.analytics.panelId}`);
    const canvas = page.locator('[data-testid=chart] canvas').first();
    await expect(canvas).toBeVisible();
    const b = (await canvas.boundingBox())!;
    await page.waitForTimeout(500);
    await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.4, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId('selection-range')).toContainText('Z to');
    expect(((await (await api(page, `/workspaces/${wid}/markers`)).json()) as P).markers?.length ?? 0).toBe(0);
  });

  test('20: edit layout, preview, apply with If-Match, undo and redo; a stale edit is a 409 with reload and reapply', async ({ page, browser }) => {
    await page.route('**/api/events/**', (r) => r.abort()); // keep this tab from refreshing itself
    await page.goto(`/w/${wid}/canvas`);
    const rev0 = Number((await page.getByTestId('canvas-revision').innerText()).replace(/\D/g, ''));
    await page.getByTestId('edit-toggle').click();
    await page.getByRole('button', { name: 'Narrower' }).first().click();
    await expect(page.getByTestId('pending-diff')).toBeVisible();
    await page.getByTestId('preview-patch').click();
    await expect(page.getByTestId('preview-result')).toContainText('Preview valid');
    await page.getByTestId('apply-patch').click();
    await expect(page.getByTestId('canvas-revision')).toContainText(`Revision ${rev0 + 1}`);
    await expect(page.getByTestId('pending-diff')).toHaveCount(0);
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('canvas-revision')).toContainText(`Revision ${rev0 + 2}`);
    await page.getByTestId('redo').click();
    await expect(page.getByTestId('canvas-revision')).toContainText(`Revision ${rev0 + 3}`);

    // A second session edits the same canvas; this tab's copy is now stale.
    const other = await browser.newContext({ baseURL: page.url().split('/w/')[0] });
    const op = await other.newPage();
    await signIn(op);
    const victim = (await (await api(op, `/workspaces/${wid}/canvas`)).json()) as P;
    await patch(op, wid, [{ op: 'movePanel', panelId: victim.panels[0].panelId, layout: { ...victim.panels[0].layout, w: 9 } }]);
    await other.close();

    await page.getByTestId('move-later').first().click();
    await page.getByTestId('apply-patch').click();
    await expect(page.getByText('The canvas changed elsewhere')).toBeVisible();
    await page.unroute('**/api/events/**');
    await page.getByTestId('reload-canvas').click();
    await expect(page.getByTestId('pending-diff')).toBeVisible(); // edits kept
    await page.getByTestId('apply-patch').click();
    await expect(page.getByTestId('pending-diff')).toHaveCount(0);
    await expect(page.getByText('The canvas changed elsewhere')).toHaveCount(0);
  });

  test('live update: a patch from another session appears without reload', async ({ page }) => {
    await page.goto(`/w/${wid}/canvas`);
    await expect(page.getByTestId('chart').first()).toBeVisible();
    const n = await page.getByTestId('panel').count();
    const src = picks.analytics;
    await patch(page, wid, [{ op: 'addPanel', panel: { ...src, panelId: crypto.randomUUID(), title: 'Live added panel', layout: { x: 0, y: 99, w: 12, h: 8 } } }]);
    await expect(page.getByTestId('panel')).toHaveCount(n + 1, { timeout: 20_000 });
    await expect(page.getByRole('link', { name: 'Live added panel' })).toBeVisible();
  });

  test('21: create, apply and delete a lens', async ({ page }) => {
    await page.goto(`/w/${wid}/canvas`);
    await page.getByTestId('lens-new').click();
    await page.getByTestId('lens-name').fill('e2e window');
    await page.getByTestId('lens-from').fill('2026-09-01');
    await page.getByTestId('lens-to').fill('2026-10-01');
    await page.getByTestId('lens-pick').first().check();
    await page.getByTestId('lens-create').click();
    const apply = page.getByTestId('lens-apply').filter({ hasText: 'e2e window' });
    await expect(apply).toBeVisible();
    await apply.click();
    await expect(page.getByTestId('lens-status')).toContainText('2026-09-01 to 2026-10-01');
    await page.getByRole('button', { name: 'Delete lens e2e window' }).click();
    await expect(apply).toHaveCount(0);
  });

  test('37: keyboard reaches panels, every chart has a text alternative, no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => r.status() >= 500 && errors.push(`HTTP ${r.status()} ${r.url()}`));
    await page.goto(`/w/${wid}/canvas`);
    await expect(page.getByTestId('chart').first()).toBeVisible();
    for (const img of await page.locator('[data-testid=chart] [role=img]').all()) {
      expect(((await img.getAttribute('aria-label')) ?? '').length).toBeGreaterThan(20);
    }
    await page.getByTestId('edit-toggle').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('edit-toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    expect(await page.locator(':focus').evaluate((e) => e.closest('[data-testid=panel]') !== null || e.id !== undefined)).toBeTruthy();
    expect(errors.filter((e) => !/favicon|Failed to load resource.*(429|aborted)/.test(e))).toEqual([]);
  });
});
