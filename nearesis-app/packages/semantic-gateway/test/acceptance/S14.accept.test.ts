import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import { baseline, sha256, canonicalJson, createPg, loadQuery, migratePg } from "@nearesis/analytics";
import { ast, setupEnv, W1, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env.close());

const M = "intents.oneclick_completed_swap_count";
const f = (member: string, operator: string, values: unknown[]) => ({ member, operator, values });
const T = (o: Record<string, unknown> = {}) => ({
  field: "intents.day",
  from: "2026-10-01T00:00:00Z",
  to: "2026-10-11T00:00:00Z",
  grain: "day",
  ...o,
});

const negatives: Array<{ name: string; body: unknown; path: string }> = [
  { name: "unknown top-level field sql", body: { ...ast(), sql: "SELECT 1" }, path: "sql" },
  { name: "9 measures", body: ast({ measures: Array(9).fill(M) }), path: "measures" },
  { name: "7 dimensions", body: ast({ dimensions: Array(7).fill("intents.status") }), path: "dimensions" },
  {
    name: "13 filters",
    body: ast({ filters: Array(13).fill(f("intents.status", "equals", ["SUCCESS"])) }),
    path: "filters",
  },
  {
    name: "101 filter values",
    body: ast({
      filters: [
        f(
          "intents.status",
          "in",
          Array.from({ length: 101 }, (_, i) => `v${i}`),
        ),
      ],
    }),
    path: "filters[0].values",
  },
  { name: "limit 10001", body: ast({ limit: 10001 }), path: "limit" },
  {
    name: "missing to",
    body: ast({ time: { field: "intents.day", from: "2026-10-01T00:00:00Z", grain: "day" } }),
    path: "time.to",
  },
  {
    name: "from after to",
    body: ast({ time: T({ from: "2026-10-11T00:00:00Z", to: "2026-10-01T00:00:00Z" }) }),
    path: "time",
  },
  { name: "operator like", body: ast({ filters: [f("intents.status", "like", ["%"])] }), path: "filters[0]" },
  {
    name: "filter member 1=1; DROP",
    body: ast({ filters: [f("1=1; DROP", "equals", ["x"])] }),
    path: "filters[0].member",
  },
  { name: "nested object where scalar expected", body: ast({ limit: { n: 5 } }), path: "limit" },
  { name: "foreign tenantId", body: { ...ast(), tenantId: "t2" }, path: "tenantId" },
  { name: "foreign workspaceId", body: { ...ast(), workspaceId: "w2" }, path: "workspaceId" },
  {
    name: "securityContext field",
    body: { ...ast(), securityContext: { tenantId: "t2", workspaceId: "w2" } },
    path: "securityContext",
  },
  { name: "join field", body: { ...ast(), join: "a LEFT JOIN b" }, path: "join" },
  { name: "where field", body: { ...ast(), where: "1=1" }, path: "where" },
  { name: "empty measures", body: ast({ measures: [] }), path: "measures" },
  { name: "measures not an array", body: ast({ measures: M }), path: "measures" },
  { name: "grain year", body: ast({ time: T({ grain: "year" }) }), path: "time.grain" },
  { name: "limit 0", body: ast({ limit: 0 }), path: "limit" },
  { name: "limit float", body: ast({ limit: 1.5 }), path: "limit" },
  { name: "bad semanticVersion", body: ast({ semanticVersion: "latest" }), path: "semanticVersion" },
  { name: "non-date from", body: ast({ time: T({ from: "yesterday" }) }), path: "time.from" },
  {
    name: "empty filter values",
    body: ast({ filters: [f("intents.status", "equals", [])] }),
    path: "filters[0].values",
  },
  {
    name: "bad order direction",
    body: ast({ order: [{ member: M, direction: "sideways" }] }),
    path: "order[0].direction",
  },
  {
    name: "5 order entries",
    body: ast({ order: Array(5).fill({ member: M, direction: "asc" }) }),
    path: "order",
  },
  { name: "uppercase member", body: ast({ measures: ["Intents.Completed"] }), path: "measures[0]" },
  {
    name: "extra key inside filter",
    body: ast({ filters: [{ ...f("intents.status", "equals", ["x"]), raw: "1=1" }] }),
    path: "filters[0].raw",
  },
  { name: "extra key inside time", body: ast({ time: T({ timezone: "x" }) }), path: "time.timezone" },
  { name: "null body", body: null, path: "" },
  { name: "array body", body: [ast()], path: "" },
  { name: "unknown measure id", body: ast({ measures: ["intents.nope"] }), path: "measures[0]" },
];

const valids = [
  ast(),
  ast({ measures: ["near.daily_successful_tx_count"], time: T({ field: "near_usage.day" }) }),
  ast({ measures: ["intents.oneclick_total_swap_count"], dimensions: ["intents.status"] }),
  ast({ measures: ["intents.route_quote_availability"], time: T({ field: "quotes.day" }) }),
  ast({ measures: ["prices.daily_close_price_usd"], time: T({ field: "prices.day" }), limit: 50 }),
];

test("S14 negative AST corpus is rejected before execution; security context is server-bound", async () => {
  expect(negatives.length).toBeGreaterThanOrEqual(25);
  const pool = createPg();
  await migratePg(pool);
  const gw = env.gateway({ pg: pool });
  const table: unknown[] = [];
  for (const c of negatives) {
    const before = gw.stats().executions;
    const r = await gw.query(W1, c.body);
    expect(r.ok, c.name).toBe(false);
    if (r.ok) continue;
    expect(r.status, c.name).toBe(422);
    expect(r.error.reasonCode, c.name).toBeTruthy();
    const paths = (r.error.details ?? []).map((d) => d.path);
    expect(paths.length, c.name).toBeGreaterThan(0);
    if (c.path)
      expect(
        paths.some((p) => p === c.path || p.startsWith(c.path)),
        `${c.name}: ${paths.join("|")}`,
      ).toBe(true);
    expect(gw.stats().executions).toBe(before);
    table.push({
      case: c.name,
      requestHash: sha256(canonicalJson(c.body)).slice(0, 16),
      status: r.status,
      errorCode: r.error.errorCode,
      reasonCode: r.error.reasonCode,
      path: paths[0],
    });
  }
  expect(gw.stats().executions).toBe(0);

  const hashes: string[] = [];
  for (const v of valids) {
    const r = await gw.query(W1, v);
    expect(r.ok, JSON.stringify(!r.ok && r.error)).toBe(true);
    if (r.ok) {
      expect(r.status).toBe(200);
      expect(r.queryHash).toMatch(/^[0-9a-f]{64}$/);
      hashes.push(r.queryHash);
    }
  }
  expect(gw.stats().executions).toBe(5);
  for (const [i, h] of hashes.entries())
    expect((await loadQuery(pool, h))?.ast).toEqual(JSON.parse(JSON.stringify(valids[i])));
  await pool.end();

  const exec = gw.audit().filter((a) => a.outcome === "executed");
  expect(exec).toHaveLength(5);
  for (const a of exec) {
    expect(a.boundContext).toEqual({
      tenantId: W1.tenantId,
      workspaceId: W1.workspaceId,
      principalId: W1.principalId,
      aclClasses: W1.aclClasses,
    });
    expect(a.workspaceId).toBe("w1");
  }
  observe({
    testId: "S14",
    observed: `${negatives.length} negative cases -> all 422 with reasonCode and path, 0 executions; 5 valid ASTs -> 200 with query hashes, 5 executions; all 5 audit records bound workspace ${W1.workspaceId}/tenant ${W1.tenantId} from the session`,
    fixtureHash: baseline().digest,
    evidence: {
      cases: table,
      validQueryHashes: hashes,
      executionsNegative: 0,
      executionsValid: 5,
      auditBoundContexts: exec.map((a) => a.boundContext),
    },
  });
});
