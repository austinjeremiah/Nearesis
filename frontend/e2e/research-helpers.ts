import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { devSignIn } from './auth';

/**
 * Helpers for the research specs. Everything goes through the real stack: the dev sign-in route, the same-origin
 * BFF and the kernel API. Each test creates its own workspace with an idempotency key, so runs are repeatable.
 * No request is mocked or intercepted.
 */
export async function signIn(page: Page) {
  await devSignIn(page);
}

const origin = (page: Page) => new URL(page.url() === 'about:blank' ? 'http://127.0.0.1:3400' : page.url()).origin;
const hdr = (page: Page, extra: Record<string, string> = {}) => ({ origin: origin(page), 'content-type': 'application/json', ...extra });

export async function api<T = unknown>(page: Page, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const r: APIRequestContext = page.request;
  const url = `${origin(page)}/api/k/${path.replace(/^\/?(v1\/)?/, '')}`;
  const res =
    method === 'GET'
      ? await r.get(url)
      : await r.post(url, { data: body ?? {}, headers: hdr(page, { 'idempotency-key': randomUUID(), ...headers }) });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function createWorkspace(page: Page, label: string): Promise<string> {
  const key = `e2e-${label}-${randomUUID()}`;
  const r = await api<{ workspaceId: string }>(page, 'POST', 'workspaces', { objective: `E2E research ${label}`, networkScope: 'fixture-only', idempotencyKey: key }, { 'idempotency-key': key });
  return r.workspaceId;
}

export async function command(page: Page, wid: string, commandType: string, payload: Record<string, unknown>) {
  const ws = await api<{ version: number }>(page, 'GET', `workspaces/${wid}`);
  return api(page, 'POST', `workspaces/${wid}/commands`, { apiVersion: 'v1', commandId: randomUUID(), commandType, payload, expectedVersion: ws.version });
}

type Panel = Record<string, unknown> & { panelId: string; title: string };

/** The workspace that already holds real analysed panels (the long-running NEAR research workspace). */
export async function sourceWorkspaceWithPanels(page: Page): Promise<{ wid: string; panels: Panel[] }> {
  const list = await api<{ workspaces: { id: string; objective: string }[] }>(page, 'GET', 'workspaces');
  for (const w of list.workspaces) {
    const c = await api<{ panels: Panel[] }>(page, 'GET', `workspaces/${w.id}/canvas`);
    if (c.panels.length > 0) return { wid: w.id, panels: c.panels };
  }
  throw new Error('no workspace with real panels exists on this stack');
}

/** Copy one real panel spec (its certified query reference) into a fresh workspace's canvas. Returns the new panel id. */
export async function seedPanel(page: Page, wid: string): Promise<{ panelId: string; title: string }> {
  const src = await sourceWorkspaceWithPanels(page);
  const spec = src.panels.find((p) => (p as { queryRef?: { resultKind?: string } }).queryRef?.resultKind === undefined) ?? src.panels[0]!;
  const panelId = randomUUID();
  await command(page, wid, 'canvas.apply_patch', {
    schemaVersion: 1,
    type: 'workspace.patch',
    operationId: randomUUID(),
    expectedRevision: 0,
    operations: [{ op: 'addPanel', panel: { ...spec, panelId } }],
  });
  return { panelId, title: spec.title };
}

export async function addGraphNode(page: Page, wid: string, body: Record<string, unknown>): Promise<string> {
  const ws = await api<{ version: number }>(page, 'GET', `workspaces/${wid}`);
  const r = await api<{ result?: { nodeId?: string }; nodeId?: string }>(page, 'POST', `workspaces/${wid}/graph/nodes`, { expectedVersion: ws.version, ...body });
  return (r.nodeId ?? r.result?.nodeId ?? (body.nodeId as string)) as string;
}
