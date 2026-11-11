import { randomUUID } from "node:crypto";
import type { Browser, BrowserContext } from "playwright";
import { BASE } from "./harness.ts";
import type { KernelEnv } from "./kernel-harness.ts";

/** Bearer-token client for the kernel API (`apps/api` buildApp) used to arrange backend state the UI then shows. */
export async function apiClient(env: KernelEnv, user: string) {
  const r = await env.app.inject({
    method: "POST",
    url: "/v1/dev/login",
    payload: { oidcSubject: env.users[user]!.subject },
  });
  if (r.statusCode !== 200) throw new Error(`api login failed: ${r.statusCode}`);
  const headers = { authorization: `Bearer ${(r.json() as { token: string }).token}` };
  return {
    async command(workspaceId: string, commandType: string, payload: Record<string, unknown>) {
      const v = (
        await env.app.inject({ method: "GET", url: `/v1/workspaces/${workspaceId}`, headers })
      ).json<{ version: number }>().version;
      const res = await env.app.inject({
        method: "POST",
        url: `/v1/workspaces/${workspaceId}/commands`,
        headers,
        payload: { apiVersion: "v1", commandId: randomUUID(), commandType, payload, expectedVersion: v },
      });
      if (res.statusCode !== 200)
        throw new Error(`${commandType} -> ${res.statusCode} ${res.body.slice(0, 300)}`);
    },
    async post(url: string, payload: unknown) {
      return env.app.inject({ method: "POST", url, headers, payload: payload as object });
    },
    async get<T>(url: string): Promise<T> {
      return (await env.app.inject({ method: "GET", url, headers })).json<T>();
    },
  };
}

export async function openMonitoring(
  browser: Browser,
  ctx: BrowserContext,
  workspaceId: string,
  hash = "#monitoring",
) {
  void browser;
  const page = await ctx.newPage();
  await page.goto(`${BASE}/w/${workspaceId}?backend=kernel${hash}`);
  await page.waitForFunction(
    () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
  );
  return page;
}
