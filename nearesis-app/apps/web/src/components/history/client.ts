/** Browser helpers for the evidence and history pages (same-origin routes only). */
export interface Mutation {
  commandId: string;
  workspaceVersion: number;
  eventSeq: number;
  replayed: boolean;
  result: Record<string, unknown>;
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function parse<T>(r: Response): Promise<T> {
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok)
    throw new ApiError(
      r.status,
      String(body.reasonCode ?? body.errorCode ?? r.status),
      String(body.message ?? `HTTP ${r.status}`),
    );
  return body as T;
}

/** Both pages use the shared same-origin BFF (lib/server/bff-allow.ts lists the history routes). */
export const historyApi = (ws: string) => `/api/k/workspaces/${ws}`;
export const evidenceApi = (ws: string) => `/api/k/workspaces/${ws}`;

export async function getJson<T>(url: string): Promise<T> {
  return parse<T>(await fetch(url, { cache: "no-store" }));
}

export async function workspaceVersion(ws: string): Promise<number> {
  return (await getJson<{ version: number }>(`/api/k/workspaces/${ws}`)).version;
}

/** Mutations carry the current workspace version (optimistic concurrency) and a fresh idempotency key. */
export async function mutate(ws: string, url: string, body: Record<string, unknown>): Promise<Mutation> {
  const expectedVersion = await workspaceVersion(ws);
  const commandId = crypto.randomUUID();
  return parse<Mutation>(
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": commandId },
      body: JSON.stringify({ ...body, commandId, expectedVersion }),
    }),
  );
}

/** Kernel workspace command (graph.save_layout): layout only, never evidence semantics. */
export async function saveLayout(
  ws: string,
  positions: Record<string, { x: number; y: number }>,
): Promise<void> {
  const version = await workspaceVersion(ws);
  await parse(
    await fetch(`/api/k/workspaces/${ws}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": String(version) },
      body: JSON.stringify({
        apiVersion: "v1",
        commandId: crypto.randomUUID(),
        commandType: "graph.save_layout",
        payload: { positions },
        expectedVersion: version,
      }),
    }),
  );
}
