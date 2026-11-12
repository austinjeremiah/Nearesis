import { randomUUID } from "node:crypto";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorResponse } from "@nearesis/contracts";
import { loginSession } from "@nearesis/kernel/testing";
import type { Session } from "@nearesis/kernel";
import { apiFixture, bearer, login, seedOrg } from "../helpers.ts";
import type { ApiFixture } from "../helpers.ts";
import type { InvestigationEngine } from "../../src/runs.ts";

/** An engine that behaves like the workflow: the run row appears as EXECUTING as soon as the run starts. */
function recordingEngine(f: () => ApiFixture): InvestigationEngine & { started: number } {
  const e = {
    started: 0,
    async start(i: {
      runId: string;
      tenantId: string;
      workspaceId: string;
      investigationId: string;
      questionId: string;
      budgetId: string;
    }) {
      e.started++;
      await f().db.admin.query(
        `INSERT INTO runtime.runs(id, tenant_id, workspace_id, investigation_id, question_id, snapshot_ref, budget_id, workflow_id, state)
         VALUES ($1,$2,$3,$4,$5,'live',$6,$7,'EXECUTING') ON CONFLICT (id) DO NOTHING`,
        [
          i.runId,
          i.tenantId,
          i.workspaceId,
          i.investigationId,
          i.questionId,
          i.budgetId,
          `investigation-${i.investigationId}-${i.questionId}`,
        ],
      );
      return { runId: i.runId, workflowId: `investigation-${i.investigationId}-${i.questionId}` };
    },
    async signal() {},
  };
  return e;
}

let f: ApiFixture;
const engine = recordingEngine(() => f);
let base: string;
let aliceTok: string;
let bobTok: string;
let aliceSession: Session;
let wsA: string;
let wsB: string;
let orgA: string;
let kernelAlice: Session;

const q = {
  question: "Why did fees spike?",
  snapshotPolicy: "live",
  budget: { tokens: 200000, toolCalls: 12, usd: 10 },
};
const ask = (tok: string, ws: string, key?: string, extra: object = {}) =>
  f.app.inject({
    method: "POST",
    url: `/v1/workspaces/${ws}/questions`,
    headers: { ...bearer(tok), ...(key ? { "idempotency-key": key } : {}) },
    payload: { ...q, ...extra } as never,
  });

beforeAll(async () => {
  f = await apiFixture({
    runtime: true,
    engine,
    appOptions: {
      ssePollMs: 30,
      overload: {
        admission: { maxRunningPerTenant: 2, maxQueuedPerTenant: 1, queueTimeoutMs: 300, pollMs: 20 },
        sse: { maxPerClient: 2, slowAfterMs: 200, slowDrainTimeoutMs: 20_000, slowMaxLag: 5 },
      },
    },
  });
  await f.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(f.app.server.address() as { port: number }).port}`;
  const a = await seedOrg(f.db.admin, "ov", { alice: "owner" });
  const b = await seedOrg(f.db.admin, "ov2", { bob: "owner" });
  orgA = a.orgId;
  aliceTok = await login(f.app, a.users.alice!.subject);
  bobTok = await login(f.app, b.users.bob!.subject);
  aliceSession = await loginSession(f.kernel, a.users.alice!.subject);
  kernelAlice = aliceSession;
  const mk = async (tok: string, key: string) =>
    (
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/workspaces",
          headers: { ...bearer(tok), "idempotency-key": key },
          payload: { objective: "o", networkScope: "fixture-only" },
        })
      ).json() as { workspaceId: string }
    ).workspaceId;
  wsA = await mk(aliceTok, "ov-create-a");
  wsB = await mk(bobTok, "ov-create-b");
});
afterAll(async () => f?.close(), 30_000);

const admitted: Array<{ key: string; runId: string }> = [];
describe("per-tenant investigation cap over HTTP", () => {
  it("admits up to the cap, queues one, and answers the rest 429 with Retry-After and a structured body", async () => {
    const rs = await Promise.all([0, 1, 2, 3, 4].map((i) => ask(aliceTok, wsA, `cap-key-${i}-aaaa`)));
    rs.forEach((r, i) => {
      if (r.statusCode === 202)
        admitted.push({ key: `cap-key-${i}-aaaa`, runId: (r.json() as { runId: string }).runId });
    });
    const ok = rs.filter((r) => r.statusCode === 202);
    const limited = rs.filter((r) => r.statusCode === 429);
    expect(ok).toHaveLength(2);
    expect(limited).toHaveLength(3);
    expect(engine.started).toBe(2);
    const reasons = limited.map((r) => (r.json() as { reasonCode: string }).reasonCode).sort();
    expect(reasons).toEqual(["QUEUE_TIMEOUT", "TENANT_QUEUE_FULL", "TENANT_QUEUE_FULL"]);
    for (const r of limited) {
      const body = ErrorResponse.parse(r.json());
      expect(body.errorCode).toBe("RATE_LIMITED");
      expect(body.retryable).toBe(true);
      expect(Number(r.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(body.retryAfterSeconds).toBe(Number(r.headers["retry-after"]));
    }
    // no budget row was written for a refused submission
    const n = await f.db.admin.query("SELECT count(*)::int AS n FROM runtime.budgets WHERE tenant_id = $1", [
      orgA,
    ]);
    expect(n.rows[0]!.n).toBe(2);
  });

  it("a replayed Idempotency-Key of an admitted run returns that run at once while the tenant is at its cap", async () => {
    expect(admitted).toHaveLength(2);
    const t0 = Date.now();
    const again = await ask(aliceTok, wsA, admitted[0]!.key);
    expect(again.statusCode).toBe(202);
    expect((again.json() as { runId: string }).runId).toBe(admitted[0]!.runId);
    expect(Date.now() - t0).toBeLessThan(250); // it did not wait in the queue
  });

  it("another tenant is unaffected while this one is saturated", async () => {
    const t0 = Date.now();
    const r = await ask(bobTok, wsB, "bob-key-1-aaaa");
    expect(r.statusCode).toBe(202);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("finishing a run frees a slot", async () => {
    await f.db.admin.query("UPDATE runtime.runs SET state = 'COMPLETE' WHERE tenant_id = $1", [orgA]);
    const r = await ask(aliceTok, wsA, "cap-key-after-aaaa");
    expect(r.statusCode).toBe(202);
  });

  it("a low-priority caller may ask for low; a body asking for high is a validation error", async () => {
    const r = await ask(aliceTok, wsA, "prio-key-bad-aaa", { priority: "high" });
    expect(r.statusCode).toBe(422);
  });
});

/** Raw SSE client: a socket the test can stop reading from. */
function rawSse(path: string, token: string, headers: Record<string, string> = {}) {
  const url = new URL(base + path);
  const sock = net.createConnection({ host: url.hostname, port: Number(url.port) });
  let status = 0;
  let head = "";
  let bytes = 0;
  const chunks: string[] = [];
  sock.on("data", (d) => {
    bytes += d.length;
    const s = d.toString("utf8");
    if (!status) {
      head += s;
      const m = /^HTTP\/1\.1 (\d+)/.exec(head);
      if (m) status = Number(m[1]);
    }
    if (chunks.length < 4000) chunks.push(s);
  });
  sock.on("error", () => undefined);
  const hs = Object.entries({ authorization: `Bearer ${token}`, ...headers })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  sock.write(`GET ${url.pathname}${url.search} HTTP/1.1\r\nhost: ${url.host}\r\n${hs}\r\n\r\n`);
  return {
    sock,
    get status() {
      return status;
    },
    get bytes() {
      return bytes;
    },
    head: () => head,
    text: () => chunks.join(""),
    close: () => sock.destroy(),
  };
}
const until = async (cond: () => boolean, ms = 3000) => {
  const t = Date.now();
  while (!cond() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 10));
  return cond();
};

describe("per-browser SSE limit", () => {
  it("the third stream of one browser is 429 with Retry-After; another client id and another credential are unaffected; closing frees a slot", async () => {
    const path = `/v1/workspaces/${wsA}/events`;
    const c1 = rawSse(path, aliceTok, { "x-client-id": "tab-1" });
    const c2 = rawSse(path, aliceTok, { "x-client-id": "tab-1" });
    await until(() => c1.status === 200 && c2.status === 200);
    expect([c1.status, c2.status]).toEqual([200, 200]);
    const c3 = rawSse(path, aliceTok, { "x-client-id": "tab-1" });
    await until(() => c3.status !== 0);
    expect(c3.status).toBe(429);
    expect(c3.head().toLowerCase()).toMatch(/retry-after: \d+/);
    expect(c3.text()).toContain("TOO_MANY_STREAMS");
    const other = rawSse(path, aliceTok, { "x-client-id": "tab-2" });
    await until(() => other.status !== 0);
    expect(other.status).toBe(200);
    expect(f.app.overload.sse.stats().refused).toBeGreaterThanOrEqual(1);
    c1.close();
    await until(() => f.app.overload.sse.stats().open <= 2);
    const c4 = rawSse(path, aliceTok, { "x-client-id": "tab-1" });
    await until(() => c4.status !== 0);
    expect(c4.status).toBe(200);
    for (const c of [c2, c3, other, c4]) c.close();
    await until(() => f.app.overload.sse.stats().open === 0);
    expect(f.app.overload.sse.stats().open).toBe(0);
  });
});

describe("slow SSE clients", () => {
  it("a slow client is served a coalesced aggregate instead of the backlog; a stuck one is disconnected; buffers stay bounded and a healthy client is unaffected", async () => {
    const path = `/v1/workspaces/${wsA}/events`;
    const fast = rawSse(path, aliceTok, { "x-client-id": "fast" });
    const slow = rawSse(path, aliceTok, { "x-client-id": "slow" });
    const stuck = rawSse(path, aliceTok, { "x-client-id": "stuck" });
    try {
      await until(() => fast.status === 200 && slow.status === 200 && stuck.status === 200);
      slow.sock.pause(); // reads nothing for a while, then resumes
      stuck.sock.pause(); // never reads again
      const before = f.app.overload.sse.stats();
      const big = "x".repeat(3900);
      const v0 = (await f.db.admin.query("SELECT version FROM workspaces WHERE id = $1", [wsA])).rows[0]!
        .version as number;
      for (let i = 0; i < 700; i++) {
        await f.kernel.commands.execute(kernelAlice, wsA, {
          apiVersion: "v1",
          commandId: randomUUID(),
          commandType: "workspace.update_objective",
          payload: { objective: `${i}-${big}` },
          expectedVersion: v0 + i,
        });
        if (i === 600) slow.sock.resume(); // drains slowly enough that its backlog is already long
      }
      await until(() => fast.text().split("event: ").length > 600, 20_000);
      await until(() => slow.text().includes("event: coalesced"), 10_000);
      expect(slow.text()).toContain("event: coalesced");
      expect(f.app.overload.sse.stats().slowEntered).toBeGreaterThan(before.slowEntered);
      expect(f.app.overload.sse.stats().coalescedFrames).toBeGreaterThan(before.coalescedFrames);
      // the stuck client is dropped once it stays blocked past the drain timeout
      await until(() => f.app.overload.sse.stats().slowDropped > before.slowDropped, 40_000);
      const after = f.app.overload.sse.stats();
      expect(after.slowDropped).toBeGreaterThan(before.slowDropped);
      // bounded: never more than one journal batch (100 events of <= ~5 KiB) was queued on one connection
      expect(after.peakBufferedBytes).toBeLessThan(1_048_576);
      // the healthy client saw every event, in order
      const ids = [...fast.text().matchAll(/\nid: (\d+)\n/g)].map((m) => Number(m[1]));
      expect(ids.length).toBeGreaterThan(600);
      expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    } finally {
      for (const c of [slow, stuck, fast]) c.close();
    }
  }, 120_000);
});
