import { test, expect, type Page } from '@playwright/test';
import { devSignIn } from './auth';

/**
 * Home > Agent tab. Navigation, consent and the answer states run against the real Next app and real sign-in. The answer
 * endpoint is stubbed (page.route, in this test file only) for the states that must be deterministic: cannot answer,
 * refusal, missing endpoint. One test calls the live endpoint and skips cleanly when the API answers 404.
 * No workspace is created by this file (the consent step is cancelled), so there is nothing to archive; any workspace a
 * future test adds here must be named "E2E agent ..." so scripts/cleanup-e2e-workspaces.mjs archives it.
 */
const ANSWER_URL = '**/api/k/assistant/answer';
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function openAgent(page: Page, query = '') {
  await page.goto(`/home?tab=agent${query}`);
  await expect(page.getByTestId('agent-tab')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await devSignIn(page);
});

test('the Agent tab opens from the URL and keeps the tab on reload', async ({ page }) => {
  await openAgent(page);
  await expect(page.getByRole('tab', { name: 'Agent' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('home-panel-overview')).toBeHidden();
  await expect(page.getByTestId('agent-empty')).toBeVisible();
  await expect(page.getByTestId('agent-composer')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Agent' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId('home-view')).toBeVisible();
});

test('the hero box routes the question into the Agent tab and answers it as a quick answer', async ({ page }) => {
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
  await expect(page).toHaveURL(/\/home\?tab=agent$/);
  await expect(page.getByTestId('agent-user-turn')).toContainText('How many swaps happened last week?');
  await expect(page.getByTestId('agent-answer')).toBeVisible();
  expect(asked).toEqual(['How many swaps happened last week?']);
  expect(workspaceWrites).toEqual([]);
  // The answer survives a tab switch and a reload.
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('tab', { name: 'Agent' }).click();
  await expect(page.getByTestId('agent-answer')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('agent-answer')).toBeVisible();
  await page.getByTestId('agent-clear').click();
  await expect(page.getByTestId('agent-empty')).toBeVisible();
});

test('an example chip on Overview submits in the Agent tab', async ({ page }) => {
  await page.route(ANSWER_URL, (route) => route.fulfill(json(404, { errorCode: 'NOT_FOUND', message: 'Not found.', retryable: false })));
  await page.goto('/home');
  await page.getByTestId('home-example').first().click();
  await expect(page).toHaveURL(/tab=agent/);
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
