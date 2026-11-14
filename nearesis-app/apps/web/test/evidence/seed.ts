/** Seeds evidence and history state through the real kernel HTTP API (bearer token for the test user). */
import { API_PORT, type Env } from "../thesis/harness.ts";

export interface Api {
  get: <T = unknown>(path: string) => Promise<T>;
  post: <T = Record<string, unknown>>(
    path: string,
    body: Record<string, unknown>,
  ) => Promise<{ status: number; body: T }>;
  node: (kind: string, label: string, extra?: Record<string, unknown>) => Promise<string>;
  edge: (
    from: string,
    to: string,
    relation: string,
    extra?: Record<string, unknown>,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
}

export async function api(env: Env): Promise<Api> {
  const token = await env.kernel.devAuth!.login(env.subject);
  const base = `http://127.0.0.1:${API_PORT}/v1/workspaces/${env.workspaceId}`;
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = async <T>(p: string) => {
    const r = await fetch(`${base}${p}`, { headers: h });
    if (!r.ok) throw new Error(`GET ${p} -> ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  };
  const version = async () => (await get<{ version: number }>("")).version;
  const post = async <T>(p: string, body: Record<string, unknown>) => {
    const r = await fetch(`${base}${p}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ expectedVersion: await version(), ...body }),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as T };
  };
  const node = async (kind: string, label: string, extra: Record<string, unknown> = {}) => {
    const r = await post<{ result: { nodeId: string } }>("/graph/nodes", { kind, label, ...extra });
    if (r.status >= 300) throw new Error(`node ${label}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.result.nodeId;
  };
  const edge = (from: string, to: string, relation: string, extra: Record<string, unknown> = {}) =>
    post<Record<string, unknown>>("/graph/edges", { from, to, relation, ...extra });
  return { get, post, node, edge };
}
