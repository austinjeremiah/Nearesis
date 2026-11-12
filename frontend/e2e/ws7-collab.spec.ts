import { test, expect, type Page, type Browser } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { api, command, createWorkspace, signIn } from './research-helpers';

/**
 * Marker creation from chart selections and live collaborative editing, against the real stack.
 * Panels are real stored specs (reused by query hash from an existing research workspace); no response is mocked.
 * Both browser contexts sign in as the dev owner (the dev login only knows existing users).
 */
type P = Record<string, any>;
test.describe.configure({ mode: 'serial' });

let cookies: Awaited<ReturnType<ReturnType<Page['context']>['cookies']>> = [];
async function session(page: Page) {
  if (cookies.length) {
    await page.context().addCookies(cookies);
    await page.goto('/home');
    return;
  }
  await signIn(page);
  cookies = await page.context().cookies();
}

async function findSeriesSpec(page: Page): Promise<P> {
  const list = await api<{ workspaces: { id: string; objective: string }[] }>(page, 'GET', 'workspaces');
  for (const w of list.workspaces) {
    if (/e2e|probe/i.test(w.objective)) continue;
    const cv = await api<{ panels: P[] }>(page, 'GET', `workspaces/${w.id}/canvas`);
    for (const p of cv.panels) {
      if (p.kind !== 'timeSeries' || !p.queryRef?.hash) continue;
      const r = await page.request.get(`/api/k/workspaces/${w.id}/panels/${p.queryRef.hash}/data`);
      if (r.status() !== 200) continue;
      const d = (await r.json()) as P;
      if ((d.chart?.rows?.length ?? d.rows?.length ?? 0) > 5 || d.chart) return p;
    }
  }
  throw new Error('no time-series panel with data on this stack');
}

async function workspaceWithPanels(page: Page, n: number): Promise<{ wid: string; panelIds: string[] }> {
  const spec = await findSeriesSpec(page);
  const wid = await createWorkspace(page, 'WS7 collab');
  const panelIds: string[] = [];
  const operations = Array.from({ length: n }, (_, i) => {
    const panelId = randomUUID();
    panelIds.push(panelId);
    return { op: 'addPanel', panel: { ...spec, panelId, title: `${spec.title} ${i + 1}`, layout: { x: 0, y: i * 8, w: 12, h: 8 } } };
  });
  await command(page, wid, 'canvas.apply_patch', { schemaVersion: 1, type: 'workspace.patch', operationId: randomUUID(), expectedRevision: 0, operations });
  return { wid, panelIds };
}

async function second(browser: Browser, baseURL: string) {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  await session(page);
  return { ctx, page };
}

test('drag-select a range on a real chart, create a marker, see it on the chart and in the list', async ({ page }) => {
  await session(page);
  const { wid, panelIds } = await workspaceWithPanels(page, 1);
  await page.goto(`/w/${wid}/canvas`);
  const chart = page.locator('[data-testid=chart]').first();
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAttribute('data-markers', '0');
  const canvas = chart.locator('canvas').first();
  await canvas.scrollIntoViewIfNeeded();
  const b = (await canvas.boundingBox())!;
  await page.waitForTimeout(500);
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.4, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('selection-range')).toContainText('Z to');
  const range = await page.getByTestId('selection-range').innerText();

  await page.getByTestId('selection-create-marker').click();
  const form = page.getByTestId('marker-form');
  await expect(form).toBeVisible();
  // prefilled from the selection
  await expect(form.getByLabel('Panel')).toHaveValue(panelIds[0]!);
  await expect(form.getByLabel('Start')).not.toHaveValue('');
  await form.getByLabel('Question').fill('Why did this range move?');
  await page.getByTestId('create-marker').click();
  await expect(page.getByTestId('marker-created')).toBeVisible();

  // the chart now draws it
  await expect(chart).toHaveAttribute('data-markers', '1');
  const list = await api<{ markers: P[] }>(page, 'GET', `workspaces/${wid}/markers`);
  expect(list.markers).toHaveLength(1);
  const m = list.markers[0]!;
  expect(m.anchor.kind).toBe('time_range');
  expect(range.slice(0, 10)).toContain(String(m.anchor.start).slice(0, 10));

  await page.getByTestId('marker-created-link').click();
  await expect(page).toHaveURL(new RegExp(`/markers/${m.markerId}$`));
  await page.goto(`/w/${wid}/markers`);
  await expect(page.getByText('Why did this range move?')).toBeVisible();
});

test('assigning an agent from the created marker page works', async ({ page }) => {
  await session(page);
  const { wid, panelIds } = await workspaceWithPanels(page, 1);
  await page.goto(`/w/${wid}/panels/${panelIds[0]}`);
  await page.getByTestId('range-select').click();
  await page.getByTestId('selection-create-marker').click();
  await page.getByLabel('Question').fill('Assign test');
  await page.getByTestId('create-marker').click();
  await page.getByTestId('marker-created-link').click();
  await expect(page).toHaveURL(/\/markers\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Assign test').first()).toBeVisible();
  await expect(page.getByTestId('marker-detail')).toHaveAttribute('data-status', 'DRAFT');
  await page.getByTestId('to-ACTIVE').click();
  await expect(page.getByTestId('marker-detail')).toHaveAttribute('data-status', 'ACTIVE');
  await page.getByTestId('assign-agent').click();
  const tasks = page.getByTestId('marker-tasks');
  await expect(tasks.locator('tbody tr')).toHaveCount(1);
});

test('shared panel notes: an edit in one browser appears in the other, and survives a reload', async ({ page, browser }) => {
  await session(page);
  const { wid, panelIds } = await workspaceWithPanels(page, 1);
  const url = `/w/${wid}/panels/${panelIds[0]}`;
  const base = new URL(page.url()).origin;
  await page.goto(url);
  const b = await second(browser, base);
  await b.page.goto(url);
  await expect(page.getByTestId('notes-status')).toHaveAttribute('data-status', 'open', { timeout: 20_000 });
  await expect(b.page.getByTestId('notes-status')).toHaveAttribute('data-status', 'open', { timeout: 20_000 });

  await page.getByTestId('shared-notes').click();
  await page.keyboard.type('hello from A');
  await expect(b.page.getByTestId('shared-notes')).toHaveValue('hello from A', { timeout: 15_000 });
  await b.page.getByTestId('shared-notes').click();
  await b.page.keyboard.press('End');
  await b.page.keyboard.type(' and B');
  await expect(page.getByTestId('shared-notes')).toHaveValue('hello from A and B', { timeout: 15_000 });

  // the server stored it: a fresh load shows it
  await page.reload();
  await expect(page.getByTestId('shared-notes')).toHaveValue('hello from A and B', { timeout: 20_000 });
  await b.ctx.close();
});

test('a collaborator sees queued layout moves as drafts; the canvas itself changes only on apply', async ({ page, browser }) => {
  await session(page);
  const { wid } = await workspaceWithPanels(page, 2);
  const base = new URL(page.url()).origin;
  await page.goto(`/w/${wid}/canvas`);
  const b = await second(browser, base);
  await b.page.goto(`/w/${wid}/canvas`);
  await expect(page.getByTestId('layout-live')).toHaveAttribute('data-status', 'open', { timeout: 20_000 });
  await expect(b.page.getByTestId('layout-live')).toHaveAttribute('data-status', 'open', { timeout: 20_000 });
  const rev = (await api<P>(page, 'GET', `workspaces/${wid}/canvas`)).documentRevision;

  await page.getByTestId('edit-toggle').click();
  await page.getByTestId('move-later').first().click();
  await expect(page.getByTestId('pending-diff')).toBeVisible();
  await expect(b.page.getByTestId('layout-draft').first()).toBeVisible({ timeout: 15_000 });
  // a draft is not a command: nothing was persisted
  expect((await api<P>(page, 'GET', `workspaces/${wid}/canvas`)).documentRevision).toBe(rev);

  await page.getByTestId('discard-patch').click();
  await expect(b.page.getByTestId('layout-draft')).toHaveCount(0, { timeout: 15_000 });
  await b.ctx.close();
});

test('a member whose access is revoked is disconnected', async ({ page, browser }) => {
  await session(page);
  const { wid, panelIds } = await workspaceWithPanels(page, 1);
  const base = new URL(page.url()).origin;
  const b = await second(browser, base);
  await b.page.goto(`/w/${wid}/panels/${panelIds[0]}`);
  await expect(b.page.getByTestId('notes-status')).toHaveAttribute('data-status', 'open', { timeout: 20_000 });
  // The dev login knows only existing users and removing one from the shared dev org would damage it, so access is
  // withdrawn at the workspace: the server's revalidation then fails for every open socket exactly as for a removed member.
  await api(page, 'POST', `workspaces/${wid}/archive`, {});
  await expect(b.page.getByTestId('notes-status')).toHaveAttribute('data-status', 'revoked', { timeout: 20_000 });
  await expect(b.page.getByText('Your access to this workspace was revoked')).toBeVisible();
  await b.ctx.close();
});
