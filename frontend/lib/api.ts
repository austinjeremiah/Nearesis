import type { ZodType, z } from 'zod';
import { ENV } from './env';
import { session } from './session';
import * as T from './types';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: unknown) {
    super(message);
  }
}

type Auth = 'none' | 'owner' | 'demo';

async function call<S extends ZodType>(method: 'GET' | 'POST' | 'PUT', path: string, schema: S, opts: { body?: unknown; auth?: Auth } = {}): Promise<z.infer<S>> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth === 'owner') {
    const t = session.token();
    if (!t) throw new ApiError('UNAUTHORIZED', 'Sign in with World ID first.', 401);
    headers.authorization = `Bearer ${t}`;
  }
  if (opts.auth === 'demo') headers['x-demo-key'] = ENV.DEMO_KEY;

  let r: Response;
  try {
    r = await fetch(`${ENV.API_URL}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach the Klero API.', 0);
  }
  const text = await r.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { throw new ApiError('INTERNAL', 'Unexpected response from the API.', r.status); }
  if (!r.ok) {
    const e = json.error ?? {};
    if (r.status === 401 && opts.auth === 'owner') session.clear(); // expired/invalid fos_ token → back to /login
    throw new ApiError(e.code ?? 'INTERNAL', e.message ?? `HTTP ${r.status}`, r.status, json);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.error('[api] schema mismatch', path, parsed.error.issues);
    throw new ApiError('SCHEMA', `API response for ${path} did not match the contract.`, r.status, parsed.error.issues);
  }
  return parsed.data;
}

const q = encodeURIComponent;

export const api = {
  health: () => call('GET', '/v1/health', T.zAny),
  config: () => call('GET', '/v1/config', T.zConfig),

  loginStart: () => call('POST', '/v1/owner/login/start', T.zLoginStart, { body: {} }),
  loginPoll: (attemptId: string) => call('GET', `/v1/owner/login/${q(attemptId)}`, T.zLoginPoll),

  me: () => call('GET', '/v1/me', T.zMe, { auth: 'owner' }),
  pairing: (label: string) => call('POST', '/v1/pairings', T.zPairing, { auth: 'owner', body: { label } }),
  revokeStart: (agentAddr: string) => call('POST', `/v1/agents/${q(agentAddr)}/revoke/start`, T.zApprovalStart, { auth: 'owner', body: {} }),
  approval: (id: string) => call('GET', `/v1/approvals/${q(id)}`, T.zApproval, { auth: 'owner' }),
  approvalCancel: (id: string) => call('POST', `/v1/approvals/${q(id)}/cancel`, T.zAny, { auth: 'owner', body: {} }),

  policy: () => call('GET', '/v1/policy', T.zPolicy, { auth: 'owner' }),
  putPolicy: (p: Partial<Pick<T.Policy, 'capPerPayment' | 'dailyCap' | 'allowlist'>>) => call('PUT', '/v1/policy', T.zPolicy, { auth: 'owner', body: p }),

  job: (jobKey: string) => call('GET', `/v1/jobs/${q(jobKey)}`, T.zJob, { auth: 'owner' }),
  intent: (id: string) => call('GET', `/v1/intents/${q(id)}`, T.zIntent, { auth: 'owner' }),
  counter: (jobKey: string, since: number) => call('GET', `/v1/counter?jobKey=${q(jobKey)}&since=${since}`, T.zCounter),

  directory: () => call('GET', '/v1/directory', T.zDirectory),
  timeline: (jobKey: string) => call('GET', `/v1/timeline?jobKey=${q(jobKey)}`, T.zTimeline),

  demoJob: () => call('POST', '/v1/demo/job', T.zDemoJob, { auth: 'demo', body: {} }),
  chaosKill: () => call('POST', '/v1/chaos/kill-next-payer', T.zArmed, { auth: 'demo', body: {} }),
  chaosFail: () => call('POST', '/v1/chaos/fail-next-job', T.zArmed, { auth: 'demo', body: {} }),
  chaosReplay: (intentId: string) => call('POST', `/v1/chaos/replay/${q(intentId)}`, T.zAny, { auth: 'demo', body: {} }),
  chaosRevive: (agentAddr: string, jobKey: string) => call('POST', `/v1/chaos/revive/${q(agentAddr)}`, T.zAny, { auth: 'demo', body: { jobKey } }),
};
