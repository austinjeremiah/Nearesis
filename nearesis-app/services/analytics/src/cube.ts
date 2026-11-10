import { createHmac } from "node:crypto";

export const CUBE_URL_DEFAULT = "http://127.0.0.1:4000";
/** Dev-only default; production sets CUBEJS_API_SECRET. Never sent to a browser. */
export const CUBE_SECRET_ENV = "CUBEJS_API_SECRET";
export const CUBE_SECRET_DEV_DEFAULT = "nearesis-dev-cube-secret-not-for-production";

export function defaultCubeSecret(): string {
  return process.env[CUBE_SECRET_ENV] ?? CUBE_SECRET_DEV_DEFAULT;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** HS256 JWT carrying the security context. Built by the gateway from the server session only. */
export function signCubeToken(
  secret: string,
  context: Record<string, unknown>,
  ttlSeconds = 300,
  nowMs = Date.now(),
): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ ...context, iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + ttlSeconds });
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export interface CubeLoadResult {
  data: Array<Record<string, string | number | null>>;
  annotation: Record<string, unknown>;
  usedPreAggregations?: Record<string, { preAggregationId?: string; type?: string; lastUpdatedAt?: number }>;
  query: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export class CubeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function cubeFetch(url: string, token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${url}/cubejs-api/v1/${path}`, {
    ...init,
    headers: { Authorization: token, "content-type": "application/json" },
  });
}

/** POST /load, polling the "Continue wait" protocol until Cube returns data (pre-aggregation builds can take seconds). */
export async function cubeLoad(
  url: string,
  token: string,
  query: Record<string, unknown>,
  timeoutMs = 90_000,
): Promise<CubeLoadResult> {
  const t0 = Date.now();
  for (;;) {
    const res = await cubeFetch(url, token, "load", { method: "POST", body: JSON.stringify({ query }) });
    const text = await res.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new CubeError(`cube returned non-JSON (${res.status})`, res.status);
    }
    if (body.error === "Continue wait") {
      if (Date.now() - t0 > timeoutMs) throw new CubeError("cube load timed out", 504);
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    if (!res.ok)
      throw new CubeError(`cube error: ${String(body.error ?? res.status).slice(0, 300)}`, res.status);
    return {
      data: body.data as CubeLoadResult["data"],
      annotation: (body.annotation ?? {}) as Record<string, unknown>,
      usedPreAggregations: body.usedPreAggregations as CubeLoadResult["usedPreAggregations"],
      query: (body.query ?? {}) as Record<string, unknown>,
      raw: body,
    };
  }
}

export async function cubeMeta(url: string, token: string): Promise<{ cubes: Array<Record<string, any>> }> {
  const res = await cubeFetch(url, token, "meta");
  if (!res.ok)
    throw new CubeError(`cube meta ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  return (await res.json()) as { cubes: Array<Record<string, any>> };
}

/** Pre-aggregation builds list (for S13 evidence). */
export async function cubeDryRun(
  url: string,
  token: string,
  query: Record<string, unknown>,
): Promise<Record<string, any>> {
  const res = await cubeFetch(url, token, "dry-run", { method: "POST", body: JSON.stringify({ query }) });
  return (await res.json()) as Record<string, any>;
}

export async function cubeReady(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/readyz`)).ok;
  } catch {
    return false;
  }
}
