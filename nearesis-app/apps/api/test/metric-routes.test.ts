import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { toErrorResponse } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import { metricRoutes } from "../src/metric-routes.ts";
import {
  setup,
  txPerDay,
  AGENT,
  type Harness,
} from "../../../packages/semantic-gateway/test/authoring/harness.ts";

const WS = "5a1b6c70-0000-4000-8000-000000000001";
const ORG = "5a1b6c70-0000-4000-8000-0000000000aa";
let h: Harness;
let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  h = await setup();
  const kernel = {
    db: {
      tx: async (_c: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ query: async () => ({ rows: [{}] }) }),
    },
  } as unknown as Kernel;
  app = Fastify();
  app.setErrorHandler((e, _req, reply) => {
    const { status, body } = toErrorResponse(e, "t");
    reply.status(status).send(body);
  });
  await app.register(metricRoutes, {
    kernel,
    authoring: h.svc,
    authenticate: async (req): Promise<Session> => ({
      userId: String(req.headers["x-user"] ?? "user-1"),
      role: String(req.headers["x-role"] ?? "analyst") as Session["role"],
      principal: { kind: "human", actorId: ORG, orgId: "tenant-a" } as Session["principal"],
    }),
  });
});
afterAll(async () => {
  await app.close();
  await h.close();
});

const call = (method: "GET" | "POST" | "PUT", url: string, role: string, user: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/workspaces/${WS}${url}`,
    headers: { "x-role": role, "x-user": user },
    payload: payload as never,
  });

describe("metric authoring API", () => {
  it("propose -> catalogue -> versions; the author is the session, not the body", async () => {
    const body = {
      proposal: {
        ...txPerDay(AGENT, { name: "api_metric" }),
        author: { principalId: "spoof", kind: "agent", tenantId: "x" },
      },
    };
    const r = await call("POST", "/metrics/proposals", "analyst", "analyst-1", body);
    expect(r.statusCode).toBe(201);
    const j = r.json();
    expect(j.record.status).toBe("VALIDATED");
    expect(j.record.authorId).toBe("analyst-1");
    const cat = (await call("GET", "/metrics", "viewer", "v")).json();
    expect(
      cat.metrics.find((m: { metricKey: string }) => m.metricKey === "authored.api_metric"),
    ).toMatchObject({ status: "VALIDATED", exploratory: true });
    const vs = (await call("GET", "/metrics/authored.api_metric/versions", "viewer", "v")).json();
    expect(vs.versions).toHaveLength(1);
  });

  it("typed errors: raw SQL 422, certify by analyst 403, self-certify 403, certify by another owner 200, deprecate needs reason", async () => {
    const sql = await call("POST", "/metrics/proposals", "analyst", "analyst-1", {
      proposal: { ...txPerDay(AGENT), sql: "select 1" },
    });
    expect(sql.statusCode).toBe(422);
    expect(sql.json().reasonCode).toBe("RAW_SQL_REFUSED");
    const an = await call("POST", "/metrics/authored.api_metric/versions/1/certify", "analyst", "analyst-2");
    expect(an.statusCode).toBe(403);
    expect(an.json().reasonCode).toBe("CERTIFIER_REQUIRED");
    const own = await call("POST", "/metrics/authored.api_metric/versions/1/certify", "owner", "analyst-1");
    expect(own.json().reasonCode).toBe("SELF_CERTIFICATION_REFUSED");
    const ok = await call("POST", "/metrics/authored.api_metric/versions/1/certify", "owner", "owner-1");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("CERTIFIED");
    const bad = await call("POST", "/metrics/authored.api_metric/versions/1/deprecate", "owner", "owner-1", {
      reason: "x",
    });
    expect(bad.statusCode).toBe(422);
    expect((await call("GET", "/metrics/authored.nope/versions", "owner", "o")).statusCode).toBe(404);
  });

  it("explore labels drafts, publish-check refuses non-certified and accepts certified", async () => {
    await call("POST", "/metrics/proposals", "analyst", "analyst-1", {
      proposal: txPerDay(AGENT, { name: "api_draft", tests: [{ kind: "min_rows", name: "m", rows: 999 }] }),
    });
    const e = await call(
      "POST",
      "/metrics/authored.api_draft/versions/1/explore",
      "analyst",
      "analyst-1",
      {},
    );
    expect(e.statusCode).toBe(200);
    expect(e.json().envelope.metricStatus).toBe("draft");
    expect(e.json().envelope.exploratory.banner).toMatch(/EXPLORATORY/);
    const refuse = await call("POST", "/metrics/publish-check", "owner", "owner-1", {
      metrics: [{ metricKey: "authored.api_draft", version: 1 }],
    });
    expect(refuse.statusCode).toBe(422);
    expect(refuse.json().reasonCode).toBe("METRIC_NOT_CERTIFIED");
    const ok = await call("POST", "/metrics/publish-check", "owner", "owner-1", {
      metrics: [{ metricKey: "authored.api_metric", version: 1 }],
    });
    expect(ok.json()).toEqual({ publishable: true });
    const pin = await call("POST", "/metrics/pins", "owner", "owner-1", {
      snapshotId: "s1",
      metrics: [{ metricKey: "authored.api_metric", version: 1 }],
    });
    expect(pin.json().pins[0]).toMatchObject({ metricKey: "authored.api_metric", version: 1 });
    expect((await call("GET", "/metrics/pins/s1", "viewer", "v")).json().pins).toHaveLength(1);
  });
});
