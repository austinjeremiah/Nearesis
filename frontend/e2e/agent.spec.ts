import { test, expect, type Page } from '@playwright/test';
import { devSignIn } from './auth';

/**
 * The Agent page (/agent): threads and the workspace switcher on the left, charts in the middle, chat on the right.
 * Conversations and tasks are server-side (/v1/agent/*); this file stubs those routes (page.route, here only) for the
 * deterministic states. No workspace is created by this file; any future test that creates one must name it
 * "E2E agent ..." so scripts/cleanup-e2e-workspaces.mjs archives it.
 */
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function openAgent(page: Page, query = '') {
  await page.goto(`/agent${query}`);
  await expect(page.getByTestId('agent-page')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await devSignIn(page);
});

test('the Agent page has the thread rail, the chart canvas and the chat', async ({ page }) => {
  await page.route('**/api/k/agent/threads', (route) => route.fulfill(json(200, { items: [] })));
  await openAgent(page);
  await expect(page.getByRole('navigation', { name: 'Conversations and workspaces' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Charts' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Agent chat' })).toBeVisible();
  await expect(page.getByTestId('agent-threads-empty')).toBeVisible();
  await expect(page.getByTestId('agent-empty')).toBeVisible();
});

test('a missing agent API renders an honest state, not mock data', async ({ page }) => {
  await page.route('**/api/k/agent/threads', (route) => route.fulfill(json(404, { error: { code: 'NOT_FOUND', message: 'not found' } })));
  await openAgent(page);
  await expect(page.getByTestId('agent-threads-unavailable')).toBeVisible();
});

test('a plan needs every consent ticked before Start is enabled', async ({ page }) => {
  const task = {
    id: 't1', threadId: 'th1', workspaceId: null, title: 'Prove a capsule', state: 'proposed', currentStep: 0,
    steps: [{ idx: 0, key: 'capsule.prove', title: 'Prove it', detail: 'OutLayer', state: 'pending', startedAt: null, finishedAt: null, progress: null, result: null, waiting: null, cost: { modelUsd: '0.000000', modelCalls: 0, creditsYocto: '0', entries: [] }, error: null }],
    consent: { required: [{ key: 'spend_credits', label: 'Spend NEAR credits', detail: 'For the proof.', maxYocto: '1000000000000000000000000' }], given: [] },
    estimate: { creditsMaxYocto: '1000000000000000000000000', modelUsdMax: '0.100000' },
    cost: { modelUsd: '0.000000', modelCalls: 0, creditsChargedYocto: '0', creditsHeldYocto: '0' },
    links: { workspaceId: null, runId: null, capsuleId: null, proofId: null, publicationId: null, reportUrl: null },
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
  };
  const thread = { id: 'th1', title: 'Proof', workspaceId: null, updatedAt: new Date().toISOString(), preview: 'plan', activeTaskId: null };
  const msg = { id: 'm1', role: 'assistant', state: 'ready', createdAt: new Date().toISOString(), kind: 'plan', text: null, answer: null, taskId: 't1', cost: { modelUsd: '0.000000', modelCalls: 1 }, error: null };
  await page.route('**/api/k/agent/threads', (route) => route.fulfill(json(200, { items: [thread] })));
  await page.route('**/api/k/agent/threads/th1', (route) => route.fulfill(json(200, { thread, messages: [msg], tasks: [task] })));
  await openAgent(page);
  await page.getByTestId('agent-thread').getByRole('button').first().click();
  const start = page.getByTestId('plan-start');
  await expect(start).toBeDisabled();
  await page.getByTestId('consent-spend_credits').check();
  await expect(start).toBeEnabled();
});
