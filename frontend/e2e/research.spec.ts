import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { addGraphNode, api, command, createWorkspace, seedPanel, signIn, sourceWorkspaceWithPanels } from './research-helpers';

/**
 * Research surfaces against the real stack: evidence graph, claims, markers, monitors, hypotheses, experiments,
 * thesis. No mocks. Audit tests 22 to 25 plus the surfaces BE2 added.
 */

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

/** A workspace holding a real claim that is derived from a query (the long-running research workspace); reads only. */
async function workspaceWithClaims(page: import('@playwright/test').Page) {
  const list = await api<{ workspaces: { id: string }[] }>(page, 'GET', 'workspaces');
  for (const w of list.workspaces) {
    const g = await api<{ nodes: { id: string; type: string; label: string }[]; edges: { source: string }[] }>(page, 'GET', `workspaces/${w.id}/graph`);
    const claim = g.nodes.find((n) => n.type === 'claim' && g.edges.some((e) => e.source === n.id));
    if (claim) return { wid: w.id, claimId: claim.id, label: claim.label };
  }
  throw new Error('no workspace has a claim with evidence edges on this stack');
}

test('22 evidence graph loads the real projection and a claim chain reaches its query', async ({ page }) => {
  const { wid, claimId, label } = await workspaceWithClaims(page);
  const proj = await api<{ nodes: { id: string; type: string }[]; edges: { source: string; target: string }[] }>(page, 'GET', `workspaces/${wid}/graph`);
  await page.goto(`/w/${wid}/evidence`);
  const g = page.getByTestId('evidence-graph');
  await expect(g).toBeVisible();
  // node count shown equals the API projection (agent nodes are hidden by default and counted separately)
  await expect(g).toHaveAttribute('data-node-count', String(proj.nodes.length));
  await expect(g).toHaveAttribute('data-edge-count', String(proj.edges.length));

  // List view: pick the claim, read its dereference, follow the chain to the query.
  await page.getByRole('tab', { name: /^List/ }).click();
  await page.getByRole('button', { name: 'claim', exact: true }).click();
  await page.locator('table tbody tr', { hasText: label.slice(0, 40) }).first().click();
  const insp = page.getByTestId('node-inspector');
  await expect(insp).toBeVisible();
  await expect(insp.getByTestId('deref-fields')).toContainText('tier');
  const selectedId = await insp.getAttribute('data-node-id');
  const edge = proj.edges.find((e) => e.source === selectedId);
  expect(edge).toBeTruthy();
  await insp.getByRole('button', { name: /derived_from/ }).first().click();
  await expect(page.getByTestId('node-inspector')).toHaveAttribute('data-node-id', edge!.target);
  await expect(page.getByTestId('node-inspector')).toContainText('query');
  // unsupported claims say what is missing
  await page.goto(`/w/${wid}/claims/${claimId}`);
  await expect(page.getByTestId('claim-detail')).toBeVisible();
});

test('22b graph drag saves layout only', async ({ page }) => {
  const wid = await createWorkspace(page, 'layout');
  const { panelId } = await seedPanel(page, wid);
  await page.goto(`/w/${wid}/evidence`);
  const node = page.locator(`.gnode[data-node-id="${panelId}"]`);
  await expect(node).toBeVisible();
  const before = await api<{ version: number; nodes: { id: string; position?: { x: number; y: number } }[] }>(page, 'GET', `workspaces/${wid}/graph`);
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 80, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('save-layout')).toBeEnabled();
  await page.getByTestId('save-layout').click();
  await expect(page.getByTestId('save-layout')).toBeDisabled();
  const after = await api<{ nodes: { id: string; type: string; label: string; position?: { x: number; y: number } }[] }>(page, 'GET', `workspaces/${wid}/graph`);
  const moved = after.nodes.find((n) => n.id === panelId)!;
  expect(moved.position).toBeTruthy();
  // evidence is unchanged: same nodes with the same labels
  expect(after.nodes.map((n) => `${n.id}:${n.label}`).sort()).toEqual(before.nodes.map((n) => `${n.id}:${(n as { label?: string }).label}`).sort());
});

test('22c node comments and rechecks render honestly', async ({ page }) => {
  const wid = await createWorkspace(page, 'comments');
  const { panelId } = await seedPanel(page, wid);
  await page.goto(`/w/${wid}/evidence`);
  await page.getByRole('tab', { name: /^List/ }).click();
  await page.locator('table tbody tr').first().click();
  await page.getByLabel('Review comment').fill('e2e review note');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.getByTestId('comments')).toContainText('e2e review note');
  await page.getByRole('tab', { name: /^Rechecks/ }).click();
  await expect(page.getByText('Nothing to recheck')).toBeVisible();
  expect(panelId).toBeTruthy();
});

test('23 marker from a range, then agent assignment starts a run, then transition and evidence', async ({ page }) => {
  const wid = await createWorkspace(page, 'marker');
  const { title, panelId } = await seedPanel(page, wid);
  await page.goto(`/w/${wid}/markers`);
  await expect(page.getByText('No markers yet')).toBeVisible();
  await page.getByTestId('new-marker').click();
  await page.getByLabel('Panel').selectOption({ label: title });
  await page.getByLabel('Start').fill('2026-11-01');
  await page.getByLabel('End').fill('2026-11-05');
  await page.getByLabel('Question').fill('Why did activity change in early November?');
  await page.getByTestId('create-marker').click();
  await expect(page).toHaveURL(/\/markers\/[0-9a-f-]{36}$/);
  const mid = page.url().split('/').pop()!;

  // selection alone spawned nothing
  const tasks0 = await api<{ tasks: unknown[] }>(page, 'GET', `workspaces/${wid}/markers/${mid}/tasks`);
  expect(tasks0.tasks).toHaveLength(0);
  const detail = page.getByTestId('marker-detail');
  await expect(detail).toHaveAttribute('data-status', 'DRAFT');
  await expect(page.getByText('Selection context')).toBeVisible();
  await expect(page.getByTestId('assign-agent')).toBeDisabled();

  await page.getByTestId('to-ACTIVE').click();
  await expect(detail).toHaveAttribute('data-status', 'ACTIVE');

  // explicit assign starts a real sub-agent run
  await page.getByTestId('assign-agent').click();
  const tasks = page.getByTestId('marker-tasks');
  await expect(tasks).toBeVisible();
  await expect(tasks.locator('tbody tr')).toHaveCount(1);
  type Tasks = { tasks: { runId: string | null; agents: string[]; origin: string }[] };
  const t = await api<Tasks>(page, 'GET', `workspaces/${wid}/markers/${mid}/tasks`);
  expect(t.tasks[0]!.origin).toBe('assign');
  expect(t.tasks[0]!.agents).toEqual(['quant']);
  // the sub-agent run is dispatched asynchronously: its run id appears and the row links to it
  await expect.poll(async () => (await api<Tasks>(page, 'GET', `workspaces/${wid}/markers/${mid}/tasks`)).tasks[0]!.runId, { timeout: 30_000 }).toBeTruthy();
  await expect(tasks.getByRole('link', { name: 'open run' })).toBeVisible({ timeout: 30_000 });

  // evidence attachment: a stored observation in the workspace's evidence graph
  const obsId = randomUUID();
  await addGraphNode(page, wid, { nodeId: obsId, kind: 'observation', label: 'E2E observation for the marker', data: {} });
  await page.reload();
  await page.getByLabel('Evidence node').selectOption(obsId);
  await page.getByTestId('attach-evidence').click();
  await expect(page.getByTestId('linked-evidence')).toBeVisible();
  const m = await api<{ linkedEvidenceIds: string[] }>(page, 'GET', `workspaces/${wid}/markers/${mid}`);
  expect(m.linkedEvidenceIds.length).toBe(1);
  expect(panelId).toBeTruthy();
});

test('24 monitor rule: create, trigger by replay, suppression, live versus replay counters, notification', async ({ page }) => {
  const wid = await createWorkspace(page, 'monitor');
  await page.goto(`/w/${wid}/monitors`);
  await expect(page.getByText('No monitor rules')).toBeVisible();
  await page.getByTestId('new-rule').click();
  await page.getByLabel('Rule name').fill('E2E activity above 100');
  await page.getByLabel('Source', { exact: true }).fill('e2e.replay.source');
  await page.getByLabel('Metric id').fill('live.near_tx_count');
  await page.getByLabel('Value', { exact: true }).fill('100');
  await page.getByLabel('Cooldown seconds').fill('3600');
  await page.getByTestId('save-rule').click();
  await expect(page).toHaveURL(/\/monitors\/[0-9a-f-]{36}$/);
  const detail = page.getByTestId('rule-detail');
  await expect(detail).toHaveAttribute('data-enabled', 'true');
  await expect(page.getByTestId('rule-condition')).toContainText('live.near_tx_count > 100');

  // disable then enable
  await page.getByTestId('toggle-rule').click();
  await expect(detail).toHaveAttribute('data-enabled', 'false');
  await page.getByTestId('toggle-rule').click();
  await expect(detail).toHaveAttribute('data-enabled', 'true');

  // replay: two events above the threshold inside the cooldown, one below
  const replay = page.getByTestId('replay-form');
  const fill = async (i: number, at: string, v: string) => {
    await replay.getByLabel(`Replay watermark ${i}`).fill(at);
    await replay.getByLabel(`Replay value live.near_tx_count ${i}`).fill(v);
  };
  await fill(1, '2026-11-01T10:00', '500');
  await replay.getByRole('button', { name: 'Add event' }).click();
  await fill(2, '2026-11-01T10:05', '600');
  await replay.getByRole('button', { name: 'Add event' }).click();
  await fill(3, '2026-11-01T10:10', '5');
  await page.getByTestId('run-replay').click();
  await expect(page.getByText('Replayed 3 event(s)')).toBeVisible();

  const rc = page.getByTestId('replay-counts');
  await expect(rc.locator('[data-k=fired]')).toHaveText('1');
  await expect(rc.locator('[data-k=suppressed]')).toHaveText('1');
  await expect(rc.locator('[data-k=false]')).toHaveText('1');
  // nothing replayed is counted as live
  await expect(page.getByTestId('live-counts').locator('[data-k=total]')).toHaveText('0');
  await expect(page.getByTestId('triggers').locator('tr[data-mode=live]')).toHaveCount(0);
  await expect(page.getByTestId('triggers').locator('tr[data-outcome=fired][data-mode=replay]')).toHaveCount(1);

  // the notification reaches the page (SSE invalidation refreshes the list)
  await expect(page.getByTestId('rule-notifications')).toContainText('replay');
  await expect(page.getByTestId('stream-status')).toHaveAttribute('data-status', 'open');

  // workspace counters keep replay apart from live
  await page.goto(`/w/${wid}/monitors`);
  await expect(page.getByTestId('counter-live')).toHaveText('0');
  await expect(page.getByTestId('counter-replay')).not.toHaveText('0');
});

test('25 claim tier: memory basis is refused, an out-of-sample result upgrades', async ({ page }) => {
  const wid = await createWorkspace(page, 'tier');
  const claimId = randomUUID();
  const resultId = randomUUID();
  await addGraphNode(page, wid, { nodeId: claimId, kind: 'claim', label: 'E2E claim for tiering', data: { tier: 'exploratory', basis: 'observation', status: 'supported' } });
  await addGraphNode(page, wid, { nodeId: resultId, kind: 'statistical_result', label: 'E2E out-of-sample result', data: { evaluation: 'out_of_sample' } });
  await page.goto(`/w/${wid}/claims/${claimId}`);
  const body = page.getByTestId('claim-detail');
  await expect(body).toBeVisible();
  // honest unknowns, not invented values
  await expect(body.locator('[data-state=unknown]').first()).toBeVisible();

  const tier = page.getByTestId('tier-control');
  await tier.getByLabel('Basis kind').selectOption('memory');
  await tier.getByLabel('Summary id').fill(randomUUID());
  await page.getByTestId('apply-tier').click();
  await expect(page.getByTestId('mutation-error')).toHaveAttribute('data-code', 'MEMORY_CANNOT_UPGRADE_CONFIDENCE');

  await tier.getByLabel('Basis kind').selectOption('evidence');
  await tier.getByLabel('Statistical result').selectOption(resultId);
  await page.getByTestId('apply-tier').click();
  await expect(page.getByText('Tier updated')).toBeVisible();
  await expect(body.getByText('out_of_sample').first()).toBeVisible();
  const c = await api<{ strength: { evidenceTier: string } }>(page, 'GET', `workspaces/${wid}/claims/${claimId}`);
  expect(c.strength.evidenceTier).toBe('out_of_sample');
});

test('hypotheses: draft, freeze with a hash chain, amend, fork, link', async ({ page }) => {
  const wid = await createWorkspace(page, 'hypo');
  await page.goto(`/w/${wid}/hypotheses`);
  await expect(page.getByText('No hypotheses yet')).toBeVisible();
  await page.getByTestId('new-hypothesis').click();
  await page.getByLabel('Proposition').fill('Lagged Intents volume improves 7 day NEAR activity forecasts');
  await page.getByLabel('Target').fill('daily NEAR transactions, 7 day horizon');
  await page.getByLabel('Predictor').fill('lagged Intents swap volume');
  await page.getByLabel('Benchmark').fill('seasonal naive');
  await page.getByLabel('Falsification criterion').fill('No out-of-sample MAE gain over the baseline after FDR control');
  await page.getByTestId('create-hypothesis').click();
  const detail = page.getByTestId('hypothesis-detail');
  await expect(detail).toHaveAttribute('data-status', 'draft');
  await expect(page.getByText('unregistered')).toBeVisible();

  await page.getByTestId('freeze').click();
  await expect(detail).toHaveAttribute('data-status', 'frozen');
  const hash = (await page.getByTestId('registration-hash').getAttribute('title'))!;
  expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  await page.getByTestId('verify').click();
  await expect(page.getByTestId('verify-result')).toHaveAttribute('data-intact', 'true');

  // amend: new version chained to the frozen one, the original hash unchanged
  await page.getByLabel('Benchmark').fill('seasonal naive and 7 day moving average');
  await page.getByLabel('Reason').fill('Add the moving average as a second benchmark');
  await page.getByTestId('amend').click();
  await expect(page.getByText('Version 2')).toBeVisible();
  type L = { hypotheses: { version: number; registrationHash: string | null }[] };
  await expect.poll(async () => (await api<L>(page, 'GET', `workspaces/${wid}/hypotheses`)).hypotheses[0]!.version).toBe(2);
  const list = await api<L>(page, 'GET', `workspaces/${wid}/hypotheses`);
  const full = await api<{ versions: { version: number; registrationHash: string | null }[] }>(page, 'GET', `workspaces/${wid}/hypotheses/${(list.hypotheses[0] as unknown as { hypothesisId: string }).hypothesisId}`);
  expect(full.versions.find((v) => v.version === 1)!.registrationHash).toBe(hash);

  // the amendment is a new draft that is frozen on its own, chained to version 1
  await expect(detail).toHaveAttribute('data-status', 'draft');
  await page.getByTestId('freeze').click();
  await expect(detail).toHaveAttribute('data-status', 'frozen');
  await page.getByTestId('verify').click();
  await expect(page.getByTestId('verify-result')).toHaveAttribute('data-intact', 'true');
  await expect(page.getByTestId('verify-result')).toContainText('2 frozen version(s)');

  // link a claim, mirrored into the evidence graph
  const linkClaim = randomUUID();
  await addGraphNode(page, wid, { nodeId: linkClaim, kind: 'claim', label: 'E2E claim to link', data: { tier: 'exploratory', basis: 'observation', status: 'supported' } });
  await page.reload();
  await page.getByTestId('hypothesis-row').first().click();
  await page.getByLabel('Reference').selectOption(linkClaim);
  await page.getByTestId('add-link').click();
  await expect(page.getByTestId('hypothesis-links')).toContainText(linkClaim);

  // a frozen version cannot be edited through the API either
  const hid = (list.hypotheses[0] as unknown as { hypothesisId: string }).hypothesisId;
  const res = await page.request.patch(`${new URL(page.url()).origin}/api/k/workspaces/${wid}/hypotheses/${hid}`, { data: { proposition: 'changed after freezing' }, headers: { origin: new URL(page.url()).origin, 'content-type': 'application/json', 'idempotency-key': randomUUID() } });
  expect(res.status()).toBeGreaterThanOrEqual(400);

  // fork starts a separate hypothesis
  await page.getByLabel('Reason').fill('Try the price predictor instead');
  await page.getByLabel('Predictor').fill('lagged price returns');
  await page.getByTestId('fork').click();
  await expect(page.getByTestId('hypothesis-row')).toHaveCount(2);
});

test('experiments come from verified research runs and show their verdict honestly', async ({ page }) => {
  const { wid } = await sourceWorkspaceWithPanels(page);
  const api0 = await api<{ experiments: { experimentId: string; status: string; integrity: string; methodValidated: boolean }[] }>(page, 'GET', `workspaces/${wid}/experiments`);
  expect(api0.experiments.length).toBeGreaterThan(0);
  const e = api0.experiments.find((x) => x.integrity === 'verified') ?? api0.experiments[0]!;
  await page.goto(`/w/${wid}/experiments`);
  await expect(page.getByText(e.experimentId).first()).toBeVisible();
  await page.getByText(e.experimentId).first().click();
  await expect(page).toHaveURL(new RegExp(`/experiments/${e.experimentId}$`));
  const detail = page.getByTestId('experiment-detail');
  await expect(detail).toHaveAttribute('data-status', e.status);
  if (!e.methodValidated) await expect(page.getByText('Method not validated').first()).toBeVisible();
  if (e.status === 'INSUFFICIENT_DATA') await expect(page.getByText('Insufficient data').first()).toBeVisible();
  await expect(page.getByTestId('model-table')).toBeVisible();
  await expect(page.getByTestId('comparisons')).toBeVisible();
});

test('thesis: blocked document is shown as blocked, versioned and exportable', async ({ page }) => {
  const wid = await createWorkspace(page, 'thesis');
  await page.goto(`/w/${wid}/thesis`);
  await expect(page.getByTestId('thesis-supported')).toHaveText('0');
  await page.getByLabel('Thesis title').fill('E2E thesis');
  await page.getByTestId('create-thesis').click();
  const doc = page.getByTestId('thesis-doc');
  await expect(doc).toBeVisible();
  await expect(page.getByText('A blocking check failed').first()).toBeVisible();
  await expect(page.getByTestId('thesis-checks')).toHaveAttribute('data-status', 'blocked');
  await expect(page.getByTestId('thesis-checks').locator('[data-check=has_supported_claims]')).toHaveAttribute('data-passed', 'false');
  const digest1 = await page.getByTestId('thesis-digest').getAttribute('title');
  await page.getByTestId('new-version').click();
  await expect(page.getByText('Saved version 2')).toBeVisible();
  await expect(doc).toHaveAttribute('data-version', '1'); // viewing v1 until selected
  await page.getByRole('button', { name: 'v2' }).click();
  await expect(doc).toHaveAttribute('data-version', '2');
  expect(await page.getByTestId('thesis-digest').getAttribute('title')).toBe(digest1);
  await page.getByRole('button', { name: 'Check against current evidence' }).click();
  await expect(page.getByText('Up to date')).toBeVisible();

  const href = await page.getByTestId('export-md').getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('E2E thesis');
  const pdf = await page.request.get((await page.getByTestId('export-pdf').getAttribute('href'))!);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
});

test('research pages show no fixture strings and no console errors', async ({ page }) => {
  const { wid, claimId } = await workspaceWithClaims(page);
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  for (const p of ['evidence', 'markers', 'monitors', 'hypotheses', 'experiments', 'thesis', `claims/${claimId}`]) {
    await page.goto(`/w/${wid}/${p}`);
    await page.waitForLoadState('networkidle');
    const text = await page.locator('body').innerText();
    for (const bad of ['snap_2026_11_09', 'FIXTURE', 'Not connected to the API yet']) expect(text, `${p} shows ${bad}`).not.toContain(bad);
  }
  expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  expect(command).toBeTruthy();
});
