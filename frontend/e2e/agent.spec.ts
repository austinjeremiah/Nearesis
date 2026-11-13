import { test, expect, type Page } from '@playwright/test';
import { devSignIn } from './auth';

/**
 * The Agent page (/agent): charts in the middle, agent chat on the right. Navigation, consent and the answer states run against the real Next app and real sign-in. The answer
 * endpoint is stubbed (page.route, in this test file only) for the states that must be deterministic: cannot answer,
 * refusal, missing endpoint. One test calls the live endpoint and skips cleanly when the API answers 404.
 * No workspace is created by this file (the consent step is cancelled), so there is nothing to archive; any workspace a
 * future test adds here must be named "E2E agent ..." so scripts/cleanup-e2e-workspaces.mjs archives it.
 */
const ANSWER_URL = '**/api/k/assistant/answer';
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function openAgent(page: Page, query = '') {
  await page.goto(`/agent${query}`);
  await expect(page.getByTestId('agent-page')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await devSignIn(page);
});

test('the Agent page opens from the nav and the URL with charts in the middle and chat on the right', async ({ page }) => {
  await page.goto('/home');
  await page.getByRole('link', { name: 'Agent', exact: true }).click();
  await expect(page).toHaveURL(/\/agent$/);
  await expect(page.getByRole('region', { name: 'Charts' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Agent chat' })).toBeVisible();
  await expect(page.getByTestId('agent-canvas-empty')).toBeVisible();
  await expect(page.getByTestId('agent-empty')).toBeVisible();
  await expect(page.getByTestId('agent-composer')).toBeVisible();
  // chat is docked right of the canvas
  const c = await page.getByTestId('agent-canvas').boundingBox();
  const r = await page.getByTestId('agent-chat').boundingBox();
  expect(r!.x).toBeGreaterThan(c!.x + c!.width - 1);
  await expect(page.getByTestId('agent-ops')).toBeVisible();
  await expect(page.getByTestId('agent-context')).toHaveValue('quick');
  await page.getByRole('button', { name: 'Collapse the chat' }).click();
  await expect(page.getByTestId('agent-chat')).toBeHidden();
  await page.getByTestId('agent-chat-open').click();
  await expect(page.getByTestId('agent-chat')).toBeVisible();
});

test('the old Home tab URL redirects to /agent', async ({ page }) => {
  await page.goto('/home?tab=agent');
  await expect(page).toHaveURL(/\/agent$/);
});

test('the hero box routes the question to the Agent page and answers it as a quick answer', async ({ page }) => {
  const asked: string[] = [];
  await page.route(ANSWER_URL, (route) => {
    asked.push(route.request().postDataJSON().question);
    return route.fulfill(json(200, { answerId: 'a1', status: 'cannot_answer', summary: null, charts: [], findings: [], limitations: [], steps: [], cannotAnswerReason: 'Stubbed: nothing indexed for that.', suggestedWorkspaceObjective: 'x', cost: { usd: 0, modelCalls: 0 }, elapsedMs: 5 }));
  });
  const workspaceWrites: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/k\/workspaces$/.test(r.url())) workspaceWrites.push(r.url());
  });
  await page.goto('/home');
  await page.getByTestId('home-question').fill('How many swaps happened last week?');
  await page.getByTestId('home-ask-submit').click();
  await expect(page).toHaveURL(/\/agent$/);
  await expect(page.getByTestId('agent-user-turn')).toContainText('How many swaps happened last week?');
  await expect(page.getByTestId('agent-answer')).toBeVisible();
  expect(asked).toEqual(['How many swaps happened last week?']);
  expect(workspaceWrites).toEqual([]);
  // The answer survives navigating away and a reload.
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.getByRole('link', { name: 'Agent', exact: true }).click();
  await expect(page.getByTestId('agent-answer')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('agent-answer')).toBeVisible();
  await page.getByTestId('agent-clear').click();
  await expect(page.getByTestId('agent-empty')).toBeVisible();
});

test('an example chip on Home submits on the Agent page', async ({ page }) => {
  await page.route(ANSWER_URL, (route) => route.fulfill(json(404, { errorCode: 'NOT_FOUND', message: 'Not found.', retryable: false })));
  await page.goto('/home');
  await page.getByTestId('home-example').first().click();
  await expect(page).toHaveURL(/\/agent/);
  await expect(page.getByTestId('agent-user-turn')).toBeVisible();
});

test('consent comes first: Create workspace creates nothing until the user confirms', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/api\/k\/workspaces(\/|$)/.test(r.url())) writes.push(r.url());
  });
  await openAgent(page);
  await page.getByTestId('agent-composer').fill('Study NEAR Intents refunds by route');
  await page.getByTestId('agent-create').click();
  const consent = page.getByTestId('agent-consent');
  await expect(consent).toBeVisible();
  await expect(consent).toContainText('will not');
  await expect(consent).toContainText('publish, freeze or approve anything else');
  await expect(page.getByTestId('agent-consent-objective')).toHaveValue('Study NEAR Intents refunds by route');
  await expect(page.getByTestId('agent-pipeline')).toHaveCount(0);
  expect(writes).toEqual([]);
  await consent.getByRole('button', { name: 'Cancel' }).click();
  await expect(consent).toBeHidden();
  expect(writes).toEqual([]);
});

test('a cannot-answer response shows the reason plainly', async ({ page }) => {
  await page.route(ANSWER_URL, (route) =>
    route.fulfill(json(200, { answerId: 'a2', status: 'cannot_answer', summary: null, charts: [], findings: [], limitations: [], steps: [], cannotAnswerReason: 'Staking rewards are not indexed. Swaps and accounts are.', suggestedWorkspaceObjective: 'Staking', cost: { usd: 0, modelCalls: 0 }, elapsedMs: 4 })),
  );
  await openAgent(page);
  await page.getByTestId('agent-composer').fill('What are staking rewards?');
  await page.getByTestId('agent-ask').click();
  await expect(page.getByTestId('agent-cannot-answer')).toContainText('Staking rewards are not indexed');
  await expect(page.getByTestId('agent-to-workspace')).toBeVisible();
});

test('API refusals and a missing endpoint render honest states', async ({ page }) => {
  await page.route(ANSWER_URL, (route) => route.fulfill(json(500, { errorCode: 'INTERNAL', message: 'The model call failed upstream.', retryable: false })));
  await openAgent(page);
  await page.getByTestId('agent-composer').fill('First question');
  await page.getByTestId('agent-ask').click();
  await expect(page.getByTestId('agent-error')).toContainText('The model call failed upstream.');

  await page.unroute(ANSWER_URL);
  await page.route(ANSWER_URL, (route) => route.fulfill(json(404, { errorCode: 'NOT_FOUND', message: 'Not found.', retryable: false })));
  await page.getByTestId('agent-composer').fill('Second question');
  await page.getByTestId('agent-ask').click();
  await expect(page.getByText('Quick answers are not available on this API yet')).toBeVisible();
});

test('a live quick answer renders (skips when the API has no answer endpoint yet)', async ({ page }) => {
  test.setTimeout(120_000);
  const probe = await page.request.post('/api/k/assistant/answer', { data: { question: 'How many Intents swaps were there in the last 30 days?' } });
  test.skip(probe.status() === 404, 'POST /v1/assistant/answer is not implemented on this API yet');
  expect([200, 429, 402, 403, 503]).toContain(probe.status());
  await openAgent(page);
  await page.getByTestId('agent-composer').fill('How many Intents swaps were there in the last 30 days?');
  await page.getByTestId('agent-ask').click();
  await expect(page.getByTestId('agent-pending')).toBeVisible();
  await expect(page.getByTestId('agent-answer').or(page.getByTestId('agent-error'))).toBeVisible({ timeout: 90_000 });
});

test('answer charts land in the middle and selecting a finding highlights them', async ({ page }) => {
  await page.route(ANSWER_URL, (route) =>
    route.fulfill(
      json(200, {
        answerId: 'a3',
        status: 'ok',
        summary: 'Swaps rose from 10 to 14.',
        charts: [
          { id: 'c1', title: 'Daily swaps', kind: 'line', unit: 'swaps', x: ['2026-08-15', '2026-08-16', '2026-08-17'], series: [{ name: 'swaps', values: ['10', null, '14'] }], source: 'intents', window: { from: '2026-08-15', to: '2026-08-17' }, coverage: '2/3 days', metricVersion: 'intents.v1', caveats: ['one day missing'] },
          { id: 'c2', title: 'Top routes', kind: 'table', columns: ['route', 'swaps'], rows: [['a>b', '5']], source: 'intents', caveats: [] },
        ],
        findings: [{ statement: 'Swaps rose.', basis: 'observation', status: 'supported', chartIds: ['c1'], facts: [{ value: '14', unit: 'swaps' }], limitations: [], skepticNotes: [], skepticVerdict: 'holds' }],
        limitations: [],
        steps: [{ tool: 'intents.trend', label: 'Read the daily trend', outcome: 'ok', ms: 120 }],
        cannotAnswerReason: null,
        suggestedWorkspaceObjective: 'Study swaps',
        cost: { usd: 0.01, modelCalls: 1 },
        elapsedMs: 900,
      }),
    ),
  );
  await openAgent(page);
  await page.getByTestId('agent-composer').fill('How did swaps change?');
  await page.getByTestId('agent-ask').click();
  const canvas = page.getByTestId('agent-canvas');
  await expect(canvas.getByTestId('agent-chart')).toHaveCount(2);
  await expect(page.getByTestId('agent-chat').getByTestId('agent-chart')).toHaveCount(0);
  await expect(canvas.getByTestId('agent-chart-gaps')).toContainText('1 of 3');
  await expect(page.getByTestId('agent-steps')).toContainText('Read the daily trend');
  await page.getByTestId('agent-finding-select').click();
  await expect(canvas.locator('[data-testid=agent-chart][data-hl=true]')).toHaveCount(1);
  await expect(canvas.locator('[data-testid=agent-chart][data-dim=true]')).toHaveCount(1);
});

test('a workspace context asks for confirmation naming the reservation before anything starts', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/questions$/.test(r.url())) writes.push(r.url());
  });
  await openAgent(page);
  await page.getByTestId('agent-context').locator('optgroup option').first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
  const opts = await page.getByTestId('agent-context').locator('optgroup option').count();
  test.skip(opts === 0, 'no existing workspace to select');
  await page.getByTestId('agent-context').selectOption({ index: 2 });
  await page.getByTestId('agent-composer').fill('What changed last week?');
  await page.getByTestId('agent-ask').click();
  await expect(page.getByTestId('agent-ask-consent')).toContainText('reserves up to $3');
  expect(writes).toEqual([]);
});
