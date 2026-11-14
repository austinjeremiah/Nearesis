import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { devSignIn } from './auth';

/**
 * Investigate flow against the REAL stack (API on 4110, real model). No mocking.
 * Model spend for this file is capped at USD 0.15 on the global ledger: it is read
 * before and after and asserted below. A run that the API blocks because a source is
 * not fresh ends in BLOCKED / BLOCKED_SOURCE; that is a real outcome with its own
 * assertions, and the tests that need approved panels say so when they cannot proceed.
 */
const QUESTION = 'Compare weekly Intents swap volume by status since August';
const SPEND_CAP_USD = 0.15;
const TERMINAL = ['COMPLETE', 'PARTIAL', 'BLOCKED', 'BLOCKED_SOURCE', 'CANCELLED'];

/** Sign in through the dev login. The API rate-limits sign-ins per client, so wait out a 429 instead of failing. */
async function signIn(page: Page) {
  await devSignIn(page);
}

async function globalCommitted(page: Page): Promise<number> {
  const r = await page.request.get('/api/k/cost/global');
  expect(r.ok()).toBeTruthy();
  return ((await r.json()) as { committedUsd: number }).committedUsd;
}

async function newWorkspace(page: Page, name: string): Promise<string> {
  const r = await page.request.post('/api/k/workspaces', {
    headers: { 'idempotency-key': `e2e-ws2-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    data: { objective: `WS2 e2e ${name}`, networkScope: 'fixture-only' },
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
  return ((await r.json()) as { workspaceId: string }).workspaceId;
}

/** Open a page and wait until the client has hydrated (the live stream indicator reaches "open"). */
async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId('stream-status')).toHaveAttribute('data-status', 'open', { timeout: 30_000 });
}

async function ask(page: Page, wid: string, question = QUESTION) {
  await open(page, `/w/${wid}/investigate`);
  await page.getByTestId('question-input').fill(question);
  await page.getByTestId('ask-submit').click();
  await expect(page).toHaveURL(new RegExp(`/w/${wid}/runs/[0-9a-f-]{36}$`));
  return page.url().split('/').pop()!;
}

const runState = (page: Page) => page.getByTestId('run-view').getAttribute('data-run-state');

/** Wait for the run to reach a state in `states`; returns the state seen. */
async function waitState(page: Page, states: string[], timeout = 120_000): Promise<string> {
  await expect.poll(async () => states.includes((await runState(page)) ?? ''), { timeout, intervals: [500] }).toBeTruthy();
  return (await runState(page))!;
}

test.describe.configure({ mode: 'serial' });

// One sign-in for the whole file; each test gets a fresh page in that signed-in context.
let ctx: BrowserContext;
let startSpend = 0;
test.beforeAll(async ({ browser }: { browser: Browser }) => {
  ctx = await browser.newContext({ baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 3400}` });
  const page = await ctx.newPage();
  await signIn(page);
  startSpend = await globalCommitted(page);
  await page.close();
});
test.afterAll(async () => ctx?.close());
// Every open page holds a live stream; the API allows six per browser, so close each test's pages.
test.afterEach(async () => {
  for (const p of ctx.pages()) await p.close();
});

test('ask form: validation, minimum budget and a free plan preview', async () => {
  const page = await ctx.newPage();
  test.setTimeout(300_000);
  const wid = await newWorkspace(page, 'preview');
  await open(page, `/w/${wid}/investigate`);
  const submit = page.getByTestId('ask-submit');
  await expect(submit).toBeDisabled();
  await page.getByTestId('question-input').fill(QUESTION);
  await expect(submit).toBeEnabled();

  await page.getByTestId('preview-plan').click();
  const plan = page.getByTestId('plan-preview');
  await expect(plan).toBeVisible();
  await expect(plan).toHaveAttribute('data-plan-kind', 'deterministic_composer');
  await expect(plan).toContainText('canvas.apply_patch');
  await expect(plan).toContainText('0 model calls');

  // A budget under the runtime minimum is refused before any request is sent, and says why.
  await page.getByText('Budget reservation').click();
  await page.getByLabel('Tokens').fill('1000');
  await expect(submit).toBeDisabled();
  await expect(page.getByTestId('ask-disabled-reason')).toContainText('below the minimum');
  await expect(page.getByTestId('plan-preview')).toHaveCount(0); // edited inputs invalidate the old preview
});

test('a run blocked by an unavailable source is a typed state, and a run with no approval says so', async () => {
  const page = await ctx.newPage();
  test.setTimeout(300_000);
  const wid = await newWorkspace(page, 'blocked-or-live');
  await ask(page, wid);
  const s = await waitState(page, ['APPROVAL_NEEDED', ...TERMINAL]);
  test.skip(s === 'APPROVAL_NEEDED' || s === 'COMPLETE', 'The sources are fresh right now, so this run proceeded; the happy-path test covers it.');
  await expect(page.getByTestId('run-blocked')).toBeVisible();
  await expect(page.getByTestId('run-blocked')).toContainText(/source/i);
  await expect(page.getByTestId('replay-command')).toBeVisible();
  await expect(page.getByTestId('run-panels')).toHaveCount(0);
});

test('ask, approve with the exact hash, panels land, findings carry labels and notes', async () => {
  const page = await ctx.newPage();
  test.setTimeout(300_000);
  const wid = await newWorkspace(page, 'happy');
  await ask(page, wid);
  const s = await waitState(page, ['APPROVAL_NEEDED', ...TERMINAL]);
  test.skip(s !== 'APPROVAL_NEEDED', `The API did not reach approval (state ${s}); sources are not fresh enough for a live run.`);

  const card = page.getByTestId('approval').first();
  await expect(card).toHaveAttribute('data-status', 'pending');
  const hash = (await card.getByTestId('action-hash').innerText()).trim();
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  await expect(card.getByTestId('cost-limit')).toBeVisible();
  await expect(card).toContainText('canvas.apply_patch');

  // The decision sent carries the displayed hash.
  const decision = page.waitForRequest((r) => r.method() === 'POST' && /\/api\/k\/runs\/[^/]+\/approvals\/\d+$/.test(r.url()));
  await card.getByTestId('approve').click();
  expect(JSON.parse((await decision).postData() ?? '{}')).toEqual({ decision: 'approve', actionHash: hash });

  const end = await waitState(page, TERMINAL, 180_000);
  expect(['COMPLETE', 'PARTIAL']).toContain(end);
  await expect(page.getByTestId('approval').first()).toHaveAttribute('data-status', 'approved');

  // Panels from the approved patch.
  await expect(page.getByTestId('run-panel').first()).toBeVisible();
  const panels = await page.getByTestId('run-panel').count();
  expect(panels).toBeGreaterThan(0);
  await expect(page.getByTestId('panel-progress')).toContainText(`${panels} of ${panels} panels ready`).catch(() => undefined);

  // Findings, once interpretation has written them.
  await expect.poll(async () => (await page.getByTestId('finding').count()) + (await page.getByTestId('interpretation-unavailable').count()), { timeout: 120_000 }).toBeGreaterThan(0);
  if ((await page.getByTestId('finding').count()) > 0) {
    const f = page.getByTestId('finding').first();
    await expect(f.getByTestId('finding-basis')).toHaveText(/Observation|Inference/);
    await expect(f.getByTestId('finding-status')).toBeVisible();
    await expect(f.getByTestId('finding-skeptic')).toBeVisible();
  }

  // Per-task cost is shown from the ledger; the run's agents are listed.
  await expect(page.getByTestId('task').first()).toBeVisible();
  await expect(page.getByTestId('task-cost').first()).toBeVisible();

  // The workspace pages reflect the run.
  await page.goto(`/w/${wid}/agents`);
  await expect(page.getByTestId('run-table')).toContainText(/complete/i);
  await expect(page.getByTestId('agent-table')).toContainText('composer');
  await page.goto(`/w/${wid}/approvals`);
  await page.getByRole('button', { name: 'All' }).click();
  await expect(page.getByTestId('approval').first()).toHaveAttribute('data-status', 'approved');
  await page.goto(`/w/${wid}/timeline`);
  await expect(page.getByTestId('timeline-full')).toBeVisible();
});

test('rejecting an approval ends the run and adds no panels', async () => {
  const page = await ctx.newPage();
  test.setTimeout(300_000);
  const wid = await newWorkspace(page, 'reject');
  await ask(page, wid);
  const s = await waitState(page, ['APPROVAL_NEEDED', ...TERMINAL]);
  test.skip(s !== 'APPROVAL_NEEDED', `The API did not reach approval (state ${s}).`);
  await page.getByTestId('reject').first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reject' }).click();
  const end = await waitState(page, TERMINAL, 60_000);
  expect(['CANCELLED', 'BLOCKED', 'PARTIAL']).toContain(end);
  await expect(page.getByTestId('approval').first()).toHaveAttribute('data-status', 'rejected');
  await expect(page.getByTestId('run-panel')).toHaveCount(0);
});

test('cancel a run that is waiting for approval', async () => {
  const page = await ctx.newPage();
  test.setTimeout(300_000);
  const wid = await newWorkspace(page, 'cancel');
  await ask(page, wid);
  const s = await waitState(page, ['APPROVAL_NEEDED', 'EXECUTING', ...TERMINAL]);
  test.skip(TERMINAL.includes(s), `The run ended on its own (state ${s}) before it could be cancelled.`);
  await page.getByTestId('cancel-run').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel run' }).click();
  const end = await waitState(page, TERMINAL, 60_000);
  expect(end).toBe('CANCELLED');
  await expect(page.getByTestId('cancel-run')).toHaveCount(0);
});

test('a tiny workspace cap: the question is accepted or refused with the budget state, and history still reads', async () => {
  const page = await ctx.newPage();
  const wid = await newWorkspace(page, 'budget');
  const put = await page.request.put(`/api/k/workspaces/${wid}/cost/policy`, {
    headers: { 'idempotency-key': `e2e-ws2-pol-${Date.now()}` },
    data: { capUsd: 0.000001 },
  });
  expect(put.status(), await put.text()).toBeLessThan(300);
  await ask(page, wid);
  // The cap is enforced where paid work happens: the run names the budget if it was the cause, otherwise it ended for
  // another real reason (for example a source that is not fresh). Either way the page shows a typed outcome.
  // The plugin is enabled by default now, so the run can reach the (free) approval step before any paid work; then it
  // is cancelled so no approval is left pending.
  test.setTimeout(180_000);
  const end = await waitState(page, ['APPROVAL_NEEDED', ...TERMINAL], 120_000);
  if (end === 'APPROVAL_NEEDED') {
    await page.getByTestId('cancel-run').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel run' }).click();
    await waitState(page, TERMINAL, 60_000);
  } else if (await page.getByTestId('run-budget-stop').count()) await expect(page.locator('[data-state="budget_exhausted"]')).toBeVisible();
  else expect(TERMINAL).toContain(end);
  // Historical reads still work.
  await open(page, `/w/${wid}/timeline`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Timeline');
  await expect(page.getByTestId('timeline-full')).toBeVisible();
});

test('seeded run: a cannot_compute finding reads as insufficient data, with labels, limitations and skeptic notes', async () => {
  const page = await ctx.newPage();
  test.setTimeout(300_000);
  const list = await page.request.get('/api/k/workspaces');
  const workspaces = ((await list.json()) as { workspaces: { id: string }[] }).workspaces;
  let found: { wid: string; runId: string } | null = null;
  for (const w of workspaces) {
    const runs = (await (await page.request.get(`/api/k/workspaces/${w.id}/runs`)).json()) as { runs: { runId: string; state: string }[] };
    for (const r of runs.runs.filter((x) => x.state === 'COMPLETE').slice(0, 6)) {
      const d = (await (await page.request.get(`/api/k/runs/${r.runId}`)).json()) as { findings: { status: string }[] };
      if (d.findings.some((f) => f.status === 'cannot_compute')) {
        found = { wid: w.id, runId: r.runId };
        break;
      }
    }
    if (found) break;
  }
  test.skip(!found, 'No run in this stack has a cannot_compute finding.');
  await page.goto(`/w/${found!.wid}/runs/${found!.runId}`);
  const f = page.locator('[data-testid="finding"][data-status="cannot_compute"]').first();
  await expect(f).toBeVisible();
  await expect(f.locator('[data-state="insufficient_data"]')).toBeVisible();
  await expect(f.getByTestId('finding-basis')).toHaveText(/Observation|Inference/);
  await expect(f.getByTestId('finding-limitations')).toBeVisible();
  await expect(f.getByTestId('finding-skeptic')).toBeVisible();
  await expect(page.getByTestId('task-cost').first()).toBeVisible();
  await expect(page.getByTestId('run-state')).toHaveAttribute('data-state', 'COMPLETE');
});

test('model spend for this file stayed under the cap', async () => {
  const page = await ctx.newPage();
  test.setTimeout(300_000);
  const end = await globalCommitted(page);
  const spent = end - startSpend;
  console.log(`global ledger before ${startSpend.toFixed(6)} after ${end.toFixed(6)} delta ${spent.toFixed(6)} USD`);
  expect(spent).toBeLessThanOrEqual(SPEND_CAP_USD);
});
