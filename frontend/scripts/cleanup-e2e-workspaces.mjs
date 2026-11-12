#!/usr/bin/env node
/**
 * Archive (never delete) the workspaces that Playwright runs and probes leave behind, through the real API.
 *
 *   node scripts/cleanup-e2e-workspaces.mjs [--dry-run]
 *
 * Signs in with the dev login (the API must run outside production), lists the workspaces and archives those whose
 * objective matches a test-run pattern. Archived workspaces can be restored with POST /v1/workspaces/:id/unarchive.
 * Env: NEARESIS_API_URL (default http://127.0.0.1:4110), NEARESIS_DEV_SUBJECT (default dev-owner).
 */
const API = (process.env.NEARESIS_API_URL ?? 'http://127.0.0.1:4110').replace(/\/$/, '');
const SUBJECT = process.env.NEARESIS_DEV_SUBJECT ?? 'dev-owner';
const dry = process.argv.includes('--dry-run');

/** Names the e2e specs and workstream probes create. Real research workspaces do not match. */
const PATTERNS = [/^WS\d+ /i, /^E2E /i, /^(conflict|ws\d+|probe)\b.*\bprobe\b|^probe\b/i];

const call = async (token, method, path) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: method === 'GET' ? undefined : '{}',
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
};

const login = await fetch(`${API}/v1/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oidcSubject: SUBJECT }) });
if (!login.ok) throw new Error(`dev login failed: ${login.status}`);
const { token } = await login.json();

let archived = 0;
let failed = 0;
// The list can be capped, so repeat until a pass finds nothing left (archived workspaces drop out of the list).
for (let pass = 0; pass < 20; pass++) {
  const { workspaces } = await call(token, 'GET', '/v1/workspaces');
  const targets = workspaces.filter((w) => PATTERNS.some((p) => p.test(w.objective ?? '')));
  if (targets.length === 0 || dry) {
    if (dry) for (const w of targets) console.log(`would archive ${w.id}  ${w.objective}`);
    if (dry) console.log(`${targets.length} workspace(s) match (dry run)`);
    break;
  }
  let progress = 0;
  for (const w of targets) {
    try {
      await call(token, 'POST', `/v1/workspaces/${w.id}/archive`);
      archived++;
      progress++;
    } catch (e) {
      failed++;
      console.error(`could not archive ${w.id} (${w.objective}): ${e.message}`);
    }
  }
  if (progress === 0) break;
}
if (!dry) console.log(`archived ${archived} e2e workspace(s)${failed ? `, ${failed} failed` : ''}`);
