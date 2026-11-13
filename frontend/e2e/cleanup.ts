/**
 * Test workspaces pile up in the shared stack, and GET /v1/workspaces returns only the newest 100. Left alone, a few
 * full runs push the real workspaces that some tests read out of that window. Setup archives test workspaces left by
 * earlier runs; teardown archives the ones this run made. Archiving is the product's own reversible action; only
 * workspaces whose objective carries a test prefix are touched, never anything else.
 */
const API = process.env.NEARESIS_API_URL ?? 'http://127.0.0.1:4110';
const TEST_OBJECTIVE = /^(E2E\b|WS\d+\s|probe)/i;

export async function archiveTestWorkspaces(filter: (createdAtMs: number) => boolean): Promise<number> {
  let token = '';
  for (let i = 0; i < 8 && !token; i++) {
    const r = await fetch(`${API}/v1/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oidcSubject: 'dev-owner' }) });
    if (r.ok) token = ((await r.json()) as { token: string }).token;
    else await new Promise((res) => setTimeout(res, 10_000));
  }
  if (!token) return 0;
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const list = (await (await fetch(`${API}/v1/workspaces`, { headers: h })).json()) as { workspaces: { id: string; objective: string; createdAt: string }[] };
  let n = 0;
  for (const w of list.workspaces) {
    if (!TEST_OBJECTIVE.test(w.objective) || !filter(Date.parse(w.createdAt))) continue;
    const r = await fetch(`${API}/v1/workspaces/${w.id}/archive`, { method: 'POST', headers: { ...h, 'idempotency-key': crypto.randomUUID() }, body: '{}' });
    if (r.ok) n++;
  }
  return n;
}
