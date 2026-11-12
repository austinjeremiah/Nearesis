import { sleep } from "./util.ts";

export type Actor = "owner" | "viewer" | "other" | "anonymous";
const SUBJECT: Record<Exclude<Actor, "anonymous">, string> = {
  owner: "dev-owner",
  viewer: "eval-viewer",
  other: "eval-other-owner",
};

export class Api {
  private tokens = new Map<Actor, string>();
  constructor(readonly base: string) {}

  async token(a: Actor): Promise<string | null> {
    if (a === "anonymous") return null;
    const have = this.tokens.get(a);
    if (have) return have;
    const r = await fetch(`${this.base}/v1/dev/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oidcSubject: SUBJECT[a] }),
    });
    if (!r.ok) throw new Error(`dev login as ${a} failed (${r.status}); run \`pnpm evals:setup\` first`);
    const t = ((await r.json()) as { token: string }).token;
    this.tokens.set(a, t);
    return t;
  }

  async call(a: Actor, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const tok = await this.token(a);
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, body: json, text };
  }

  get(a: Actor, path: string) {
    return this.call(a, "GET", path);
  }

  async waitRun(
    a: Actor,
    runId: string,
    timeoutMs: number,
  ): Promise<{ body: Record<string, unknown>; timedOut: boolean }> {
    const t0 = Date.now();
    for (;;) {
      const r = await this.get(a, `/v1/runs/${runId}`);
      const b = (r.body ?? {}) as Record<string, unknown>;
      if (b.terminal === true || b.state === "APPROVAL_NEEDED") return { body: b, timedOut: false };
      if (Date.now() - t0 > timeoutMs) return { body: b, timedOut: true };
      await sleep(2500);
    }
  }
}
