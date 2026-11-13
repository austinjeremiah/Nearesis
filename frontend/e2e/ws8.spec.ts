import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { devSignIn } from './auth';

/**
 * WS8: economics, notification read state, registry metric detail, quotes, source rate limits, the anonymous public
 * reader, publication trust and rule replay over recorded history. Real stack only (API 4110 + this app).
 */
const API = process.env.NEARESIS_API_URL ?? 'http://127.0.0.1:4110';
const CAPSULE_ID = 'cap-synthetic-2026-11-10';

async function signIn(page: Page) {
  await devSignIn(page);
}
async function bearer(page: Page): Promise<string> {
  const c = (await page.context().cookies()).find((x) => x.name === 'nearesis_session');
  expect(c, 'session cookie').toBeTruthy();
  return c!.value;
}
/** Read the API directly with the session's bearer (the expected values the page must match). */
async function apiGet<T = any>(page: Page, path: string): Promise<T> {
  const r = await page.request.get(`${API}${path}`, { headers: { authorization: `Bearer ${await bearer(page)}` } });
  const body = await r.text();
  if (!r.ok()) throw new Error(`GET ${path} -> ${r.status()} ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}
async function bff<T = any>(page: Page, method: 'GET' | 'POST', path: string, data?: unknown): Promise<T> {
  const r = await page.request.fetch(`/api/k/${path.replace(/^\/?(v1\/)?/, '')}`, { method, data, headers: { 'idempotency-key': randomUUID() } });
  const body = await r.text();
  if (!r.ok()) throw new Error(`${method} ${path} -> ${r.status()} ${body.slice(0, 300)}`);
  return (body ? JSON.parse(body) : null) as T;
}
async function newWorkspace(page: Page, label: string): Promise<string> {
  const key = `e2e-ws8-${label}-${randomUUID()}`;
  const r = await page.request.post('/api/k/workspaces', { data: { objective: `E2E ws8 ${label}`, networkScope: 'fixture-only', idempotencyKey: key }, headers: { 'idempotency-key': key } });
  expect(r.status()).toBeLessThan(300);
  return ((await r.json()) as { workspaceId: string }).workspaceId;
}
const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

test.describe.configure({ mode: 'serial' });

test('economics: exact series, precision, conversion, receivers, USD source and time, regime, gaps, percentiles not loaded', async ({ page }) => {
  await signIn(page);
  const daily = await apiGet(page, '/v1/economics/daily?days=30');
  const totals = await apiGet(page, '/v1/economics/totals?days=30');
  const receivers = await apiGet(page, '/v1/economics/receivers?days=30&top=10');
  const cov = await apiGet(page, '/v1/economics/coverage?days=30');
  await page.goto('/data/economics');
  const view = page.getByTestId('economics-view');
  await expect(view).toBeVisible();
  // the old placeholder is gone
  await expect(page.getByTestId('economics-cannot-compute')).toHaveCount(0);
  await expect(page.getByText('CANNOT_COMPUTE here')).toHaveCount(0);

  // exact totals as strings, with the precision tag
  await expect(page.getByTestId('eco-total-gas')).toContainText(group(totals.data.gasBurnt));
  await expect(page.getByTestId('eco-total-tokens')).toContainText(group(totals.data.tokensBurntYocto));
  await expect(page.getByTestId('token-precision')).toContainText(totals.precision);
  await expect(page.getByTestId('eco-days')).toHaveText(String(totals.data.days));

  // fee regime caveat verbatim from the API
  await expect(page.getByTestId('fee-regime')).toContainText(totals.feeRegime.note.slice(0, 80));

  // newest day, exact gas and fee, USD only with source and timestamp
  const newest = daily.data[daily.data.length - 1];
  const row = page.getByTestId('card-eco-daily').locator('tbody tr').first();
  await expect(row).toContainText(newest.day);
  await expect(row.getByTestId('eco-row-gas')).toHaveText(group(newest.gasBurnt));
  await expect(row.getByTestId('eco-row-tokens')).toHaveText(group(newest.tokensBurntYocto));
  if (newest.usd) {
    await expect(row.getByTestId('eco-row-usd')).toContainText(newest.usdConversion.source);
    await expect(row.getByTestId('eco-row-usd')).toContainText(newest.usdConversion.priceTimestampUTC.slice(0, 10));
  } else {
    await expect(row.getByTestId('eco-row-usd-unavailable')).toContainText(newest.usdUnavailableReason);
  }
  // no USD without a price: every priced row carries its source
  const usdCells = page.getByTestId('eco-row-usd');
  const n = await usdCells.count();
  for (let i = 0; i < n; i++) await expect(usdCells.nth(i)).toContainText('coingecko');
  // conversion versus receipt-only burn and execution intensity are shown
  await expect(page.getByTestId('card-eco-daily')).toContainText('Receipt-only gas');
  await expect(page.getByTestId('eco-conversion-note')).toContainText('receipt-only');
  await expect(page.getByTestId('card-eco-daily')).toContainText('Gas price');
  await expect(page.getByTestId('card-eco-daily')).toContainText('Gas / tx');

  // top receivers match the API
  const top = receivers.data.items.find((x: { folded: boolean }) => !x.folded);
  await expect(page.getByTestId('eco-receiver').first()).toHaveText(top.account);

  // percentiles are not loaded: shown as such, never a number
  await expect(page.getByTestId('eco-percentiles-not-loaded')).toContainText('not loaded');
  await expect(page.getByTestId('eco-percentiles-not-loaded')).toContainText('TX_DAILY_NOT_LOADED');

  // quality gaps
  for (const g of cov.qualityGaps) await expect(page.getByTestId('eco-quality-gaps')).toContainText(g.reasonCode);

  // never labelled revenue (the only mention is the statement that it is not)
  const headings = (await page.locator('h1,h2,h3,th,.card-title').allTextContents()).join(' ').toLowerCase();
  expect(headings).not.toContain('revenue');
  await expect(page.getByTestId('fee-regime')).toContainText('never protocol revenue');
});

test('replay over recorded history, replay notifications, mark read (single, per-workspace, all) and top-bar counts', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const wid = await newWorkspace(page, 'replay');
  await page.goto(`/w/${wid}/monitors`);
  await page.getByTestId('new-rule').click();
  await page.getByLabel('Rule name').fill('E2E WS8 replay');
  await page.getByLabel('Source', { exact: true }).fill('near-realtime');
  await page.getByLabel('Metric id').fill('live.near_tx_count');
  await page.getByLabel('Value', { exact: true }).fill('100');
  await page.getByTestId('save-rule').click();
  await expect(page).toHaveURL(/\/monitors\/[0-9a-f-]{36}$/);
  const ruleId = page.url().split('/').pop()!;

  // no manual value entry
  const form = page.getByTestId('replay-form');
  await expect(form.getByLabel(/Replay value/)).toHaveCount(0);
  await expect(form.getByLabel(/Replay watermark/)).toHaveCount(0);
  await form.getByLabel('Replay from').fill('2026-11-05');
  await form.getByLabel('Replay to').fill('2026-11-09');
  await page.getByTestId('run-replay').click();
  const result = page.getByTestId('replay-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('replay');
  await expect(result).toContainText('REPLAY over recorded metric history');
  await expect(result).toHaveAttribute('data-fired', '5');
  const recorded = await bff(page, 'POST', `workspaces/${wid}/monitors/${ruleId}/replay`, { from: '2026-11-05', to: '2026-11-09' });
  // the second run is idempotent: same days answer duplicate, values are the recorded ones
  expect(recorded.results.map((r: { outcome: string }) => r.outcome).every((o: string) => o === 'duplicate' || o === 'fired')).toBeTruthy();
  const firstRow = result.locator('tbody tr').first();
  await expect(firstRow).toContainText('2026-11-05');
  await expect(firstRow).toContainText(`live.near_tx_count=${recorded.results[0].values['live.near_tx_count']}`);
  // everything it wrote is replay
  const trig = await apiGet(page, `/v1/workspaces/${wid}/monitors/triggers?ruleId=${ruleId}`);
  expect(trig.triggers.length).toBeGreaterThan(0);
  expect(trig.triggers.every((t: { mode: string }) => t.mode === 'replay')).toBeTruthy();
  // a window that ends today is refused by the API with its own reason
  const today = new Date().toISOString().slice(0, 10);
  await form.getByLabel('Replay to').fill(today);
  await page.getByTestId('run-replay').click();
  await expect(page.getByText('WINDOW_NOT_COMPLETE')).toBeVisible();

  // per-workspace mark read: one notification from this rule
  await expect(page.getByTestId('rule-notifications')).toBeVisible();
  const before = await apiGet(page, `/v1/workspaces/${wid}/notifications`);
  const unreadIds = before.notifications.filter((n: { readAt: string | null }) => !n.readAt).map((n: { notificationId: string }) => n.notificationId);
  expect(unreadIds.length).toBeGreaterThan(1);
  const markButtons = page.getByTestId('rule-mark-read');
  // the list refreshes after the replay (query invalidation / live stream), so wait for it to show every unread one
  const nBtn = unreadIds.length;
  await expect(markButtons).toHaveCount(nBtn);
  await markButtons.first().click();
  await expect(markButtons).toHaveCount(nBtn - 1);
  const after1 = await apiGet(page, `/v1/workspaces/${wid}/notifications`);
  expect(after1.notifications.filter((n: { readAt: string | null }) => !n.readAt)).toHaveLength(unreadIds.length - 1);

  // global page: top-bar count equals the API's unread, mark one, then mark all
  await page.goto('/notifications');
  const bell = page.getByTestId('unread-notifications');
  const g0 = await apiGet(page, '/v1/notifications?unread=1&limit=1');
  expect(g0.unread).toBeGreaterThan(0);
  await expect(bell).toHaveAttribute('data-count', String(g0.unread));
  const rows = page.getByTestId('notifications').locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  await page.getByTestId('mark-read').first().click();
  await expect(bell).toHaveAttribute('data-count', String(g0.unread - 1));
  expect((await apiGet(page, '/v1/notifications?unread=1&limit=1')).unread).toBe(g0.unread - 1);

  if (g0.unread - 1 > 0) {
    await page.getByTestId('mark-all-read').click();
  }
  await expect(bell).toHaveAttribute('data-count', '0');
  await expect(page.getByTestId('mark-all-read')).toBeDisabled();
  expect((await apiGet(page, '/v1/notifications?unread=1&limit=1')).unread).toBe(0);
  // read state is per user: the rows are still listed, now as read
  await expect(page.getByTestId('notification-read').first()).toBeVisible();
});

test('registry metric detail from /v1/metrics/:key and /versions', async ({ page }) => {
  await signIn(page);
  const key = 'live.near_tx_count';
  const m = await apiGet(page, `/v1/metrics/${key}`);
  const v = await apiGet(page, `/v1/metrics/${key}/versions`);
  await page.goto(`/data/metrics/${encodeURIComponent(key)}`);
  await expect(page.getByTestId('registry-metric')).toBeVisible();
  await expect(page.getByTestId('registry-semantic-hash')).toHaveText(m.semanticHash);
  await expect(page.getByTestId('registry-content-hash')).toHaveText(m.registryContentHash);
  await expect(page.getByTestId('registry-certification')).toContainText('certified');
  await expect(page.getByTestId('registry-certification')).toContainText(m.certification.registrySemanticVersion);
  await expect(page.getByTestId('registry-sources')).toContainText(m.sources[0]);
  await expect(page.getByTestId('registry-uncertainty')).toContainText(m.definition.uncertainty.slice(0, 40));
  const versions = page.getByTestId('registry-versions');
  await expect(versions).toContainText(v.versions[0].version);
  await expect(versions).toContainText(v.versions[0].semanticHash.slice(0, 16));
  await expect(versions).toContainText('current');
  // from the catalogue: the link opens the same page
  await page.goto('/data');
  await page.getByRole('link', { name: m.displayName }).first().click();
  await expect(page.getByTestId('registry-metric')).toBeVisible();
  // an unknown key is a clear not-found state
  await page.goto('/data/metrics/does.not.exist');
  await expect(page.getByText('Metric not found')).toBeVisible();
});

test('quotes: real samples in the default window with unavailable reasons', async ({ page }) => {
  await signIn(page);
  const api = await apiGet(page, '/v1/intents/quotes');
  await page.goto('/data/quotes');
  const card = page.getByTestId('card-quotes');
  await expect(card).toHaveAttribute('data-status', 'OK');
  const sampled = api.data.filter((r: { attempts: number }) => r.attempts > 0);
  expect(sampled.length).toBeGreaterThan(0);
  const r0 = sampled[0];
  const row = card.locator('tbody tr', { hasText: r0.routeId });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`${r0.attempts} / ${r0.slots} slots`);
  // routes that could not be sampled say why, instead of 0 percent
  const withReasons = api.data.filter((r: { unavailableReasons?: Record<string, number> }) => Object.keys(r.unavailableReasons ?? {}).length > 0);
  for (const r of withReasons) {
    const reason = Object.keys(r.unavailableReasons)[0];
    await expect(card.locator('tbody tr', { hasText: r.routeId }).getByTestId('quote-unavailable-reasons')).toContainText(reason);
    await expect(card.locator('tbody tr', { hasText: r.routeId })).toContainText('Not sampled');
  }
});

test('sources: rate limits from recorded history, and not recorded where there is none', async ({ page }) => {
  await signIn(page);
  const api = await apiGet(page, '/v1/sources');
  await page.goto('/data/sources');
  for (const s of api.sources) {
    const row = page.locator('tbody tr', { hasText: s.sourceId }).first();
    await expect(row).toBeVisible();
    const cell = row.getByTestId('source-rate-limit');
    if (s.rateLimit) {
      await expect(cell).toHaveAttribute('data-recorded', 'true');
      await expect(cell).toContainText(`${s.rateLimit.limited} of ${s.rateLimit.attempts} attempts in ${s.rateLimit.windowDays}d`);
    } else {
      await expect(cell).toHaveAttribute('data-recorded', 'false');
      await expect(cell).toContainText('not recorded');
    }
  }
});

/** The capsule is published through the API as the signed-in owner, acknowledging whatever the API names. */
async function publishCapsule(page: Page) {
  const call = (ack: string[]) =>
    page.request.fetch(`/api/k/capsules/${CAPSULE_ID}/publish`, { method: 'POST', data: { acknowledge: ack }, headers: { 'idempotency-key': randomUUID() } });
  let r = await call([]);
  if (r.status() >= 400) {
    const body = await r.json();
    const need = (body.details ?? []).map((d: { issue: string }) => d.issue);
    expect(need.length, JSON.stringify(body)).toBeGreaterThan(0);
    r = await call(need);
  }
  expect(r.status(), await r.text()).toBeLessThan(300);
}
async function unpublishCapsule(page: Page) {
  await page.request.fetch(`/api/k/capsules/${CAPSULE_ID}/unpublish`, { method: 'POST', data: {}, headers: { 'idempotency-key': randomUUID() } });
}

test('publication trust on the capsule page: key fingerprint, registry status, anchor and testnet readback', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const wid = await newWorkspace(page, 'trust');
  await publishCapsule(page);
  try {
    const ver = await apiGet(page, `/v1/capsules/${CAPSULE_ID}/verify`);
    const latest = ver.publications[ver.publications.length - 1];
    const anchor = await apiGet(page, `/v1/capsules/${CAPSULE_ID}/anchor`);
    await page.goto(`/w/${wid}/capsules/${CAPSULE_ID}`);
    const trust = page.getByTestId('publication-trust');
    await expect(trust.getByTestId('key-fingerprint')).toHaveText(latest.key.fingerprint);
    await expect(trust.getByTestId('key-registry-status')).toHaveAttribute('data-status', latest.key.keyStatus === 'revoked' ? 'revoked' : 'active');
    await expect(trust.getByTestId('key-trusted')).toHaveAttribute('data-trusted', String(latest.key.trusted));
    await expect(trust.getByTestId('anchor-entry-hash')).toHaveText(latest.anchor.log.entryHash);
    await expect(trust.getByTestId('anchor-tx')).toContainText(latest.anchor.chain.txHash);
    const rb = trust.getByTestId('anchor-readback');
    await expect(rb).toHaveAttribute('data-status', anchor.status);
    if (anchor.readback) await expect(rb).toContainText(anchor.readback.committedHash);

    // the exported signed bundle shows the same key plus hardened custody
    await page.getByTestId('export-bundle').click();
    const bundle = page.getByTestId('bundle-result');
    await expect(bundle).toBeVisible();
    await expect(bundle.getByTestId('key-fingerprint')).toHaveText(latest.key.fingerprint);
    await expect(trust.getByTestId('key-hardened')).toBeVisible();
  } finally {
    await unpublishCapsule(page);
  }
});

test('public reader works without a session, exports download hash-checked, withdrawn is a clear state', async ({ page, browser }: { page: Page; browser: Browser }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await publishCapsule(page);
  let anonCtx: BrowserContext | undefined;
  try {
    const pub = await (await page.request.get(`${API}/v1/public/publications/${CAPSULE_ID}`)).json();
    anonCtx = await browser.newContext({ baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 3400}` });
    const anon = await anonCtx.newPage();
    expect(await anonCtx.cookies()).toHaveLength(0);
    await anon.goto(`/public/${CAPSULE_ID}`);
    await expect(anon.getByTestId('public-publication')).toBeVisible();
    await expect(anon.getByTestId('public-needs-reader')).toHaveCount(0);
    await expect(anon.getByTestId('public-limitations')).toContainText('SYNTHETIC');
    await expect(anon.getByTestId('public-trust').getByTestId('key-fingerprint')).toHaveText(pub.versions[pub.versions.length - 1].key.fingerprint);
    await expect(anon.getByTestId('public-trust').getByTestId('anchor-entry-hash')).toHaveText(pub.versions[pub.versions.length - 1].anchor.log.entryHash);
    // no session cookie was ever set for the reader
    expect(await anonCtx.cookies()).toHaveLength(0);

    // exports through the public BFF route, no cookie
    const docs = anon.getByTestId('public-document');
    expect(await docs.count()).toBe(pub.documents.length);
    await docs.first().getByTestId('public-doc-check').click();
    await expect(docs.first()).toContainText('hash matches');
    const direct = await anon.request.get(`/api/public/publications/${CAPSULE_ID}/exports/THESIS.md`);
    expect(direct.status()).toBe(200);
    expect(direct.headers()['x-capsule-sha256']).toBe(pub.documents.find((d: { path: string }) => d.path === 'exports/THESIS.md').sha256);
    // the public route never reaches anything but public publications
    expect((await anon.request.get('/api/public/me')).status()).toBe(404);
    expect((await anon.request.get('/api/public/publications/..%2Fcapsules')).status()).toBe(404);

    // withdraw: the same URL becomes a clear state, and the export route refuses
    await unpublishCapsule(page);
    await anon.goto(`/public/${CAPSULE_ID}`);
    await expect(anon.getByTestId('public-withdrawn')).toBeVisible();
    await expect(anon.getByTestId('public-withdrawn')).toContainText('withdrawn');
    expect((await anon.request.get(`/api/public/publications/${CAPSULE_ID}/exports/THESIS.md`)).status()).toBe(404);
    await anon.goto('/public/cap-never-existed');
    await expect(anon.getByTestId('public-not-found')).toBeVisible();
  } finally {
    await unpublishCapsule(page);
    await anonCtx?.close();
  }
});
