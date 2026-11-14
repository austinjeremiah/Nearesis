import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMetricCorrectionPort } from "../src/metric-correction.ts";
import { apiFixture, bearer, login, seedOrg } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

let f: ApiFixture;
let token: string;
let ws: string;
const KEY = "authored.corr_metric";

beforeAll(async () => {
  f = await apiFixture({ runtime: true });
  const a = await seedOrg(f.db.admin, "corr-api", { alice: "owner" });
  token = await login(f.app, a.users.alice!.subject);
  ws = (
    (
      await f.app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: { ...bearer(token), "idempotency-key": "corr-ws-000001" },
        payload: { objective: "o", networkScope: "fixture-only" },
      })
    ).json() as { workspaceId: string }
  ).workspaceId;
});
afterAll(async () => f?.close());

const cmd = async (commandType: string, payload: Record<string, unknown>) => {
  const w = await f.app.inject({ method: "GET", url: `/v1/workspaces/${ws}`, headers: bearer(token) });
  const r = await f.app.inject({
    method: "POST",
    url: `/v1/workspaces/${ws}/commands`,
    headers: bearer(token),
    payload: {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType,
      payload,
      expectedVersion: (w.json() as { version: number }).version,
    },
  });
  expect(r.statusCode).toBe(200);
};

describe("V18 metric correction reaches the kernel", () => {
  it("flags pinned evidence for recheck and disables only the rules that read the corrected metric", async () => {
    const v = (
      await f.app.inject({ method: "GET", url: `/v1/workspaces/${ws}`, headers: bearer(token) })
    ).json() as {
      version: number;
    };
    const node = await f.app.inject({
      method: "POST",
      url: `/v1/workspaces/${ws}/graph/nodes`,
      headers: bearer(token),
      payload: {
        expectedVersion: v.version,
        kind: "statistical_result",
        label: "R",
        semanticPins: { [KEY]: "1" },
      },
    });
    expect(node.statusCode).toBe(201);
    const nodeId = (node.json() as { result: { nodeId: string } }).result.nodeId;

    const hit = randomUUID();
    const nested = randomUUID();
    const other = randomUUID();
    const cmpOn = (m: string) => ({ kind: "compare", metricId: m, op: "gt", value: 1 });
    await cmd("monitor.rule_create", { ruleId: hit, name: "hit", sourceId: "s1", condition: cmpOn(KEY) });
    await cmd("monitor.rule_create", {
      ruleId: nested,
      name: "nested",
      sourceId: "s2",
      condition: { kind: "and", terms: [cmpOn("other.metric"), { kind: "not", term: cmpOn(KEY) }] },
    });
    await cmd("monitor.rule_create", {
      ruleId: other,
      name: "other",
      sourceId: "s3",
      condition: cmpOn("other.metric"),
    });

    const session = await f.kernel.identity.resolveSession(token);
    const out = await createMetricCorrectionPort(f.kernel)({
      session,
      workspaceId: ws,
      metricKey: KEY,
      version: 1,
      reason: "denominator was wrong",
    });
    expect(out.semanticChange).toEqual({ toVersion: "corrected:1", flaggedCount: 1 });
    expect(out.failedRules).toEqual([]);
    expect(out.disabledRules.sort()).toEqual([hit, nested].sort());

    const rules = (
      await f.db.admin.query("SELECT id, enabled FROM monitor_rules WHERE workspace_id = $1", [ws])
    ).rows as Array<{ id: string; enabled: boolean }>;
    expect(Object.fromEntries(rules.map((r) => [r.id, r.enabled]))).toEqual({
      [hit]: false,
      [nested]: false,
      [other]: true,
    });
    const flags = await f.app.inject({
      method: "GET",
      url: `/v1/workspaces/${ws}/graph/rechecks`,
      headers: bearer(token),
    });
    expect(JSON.stringify(flags.json())).toContain(nodeId);

    // Idempotent: a second run flags nothing new and finds no enabled rule left to disable.
    const again = await createMetricCorrectionPort(f.kernel)({
      session,
      workspaceId: ws,
      metricKey: KEY,
      version: 1,
      reason: "again",
    });
    expect(again.disabledRules).toEqual([]);
  });
});
