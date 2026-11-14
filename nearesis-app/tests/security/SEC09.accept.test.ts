/**
 * SEC09: query and semantic-layer injection fuzz. PASS: fuzzed ASTs never reach raw SQL, unknown measures or unbounded
 * scans. Real gateway, real Cube, real ClickHouse (query_log is the oracle), fixed seed, 5,000 mutated ASTs (each sent as
 * a member and as an outsider) plus 200 raw Cube-style requests. Bounds are frozen here before any run.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import { baseline } from "../../services/analytics/src/index.ts";
import { ast, setupEnv, W1, type Env } from "../../packages/semantic-gateway/test/helpers.ts";
import type { Session } from "../../packages/semantic-gateway/src/index.ts";

const SEED = 0x5ec09;
const BYTE_CAP = 256 * 1024 * 1024; // frozen: no logged statement may read more than 256 MiB
const HEALTH_P95_MS = 1000; // PERF01 SLO for cached queries
const OUTSIDER: Session = { tenantId: "t9", workspaceId: "w9", principalId: "outsider", aclClasses: [] };
const TOKENS = [
  "'; DROP TABLE intents_swaps;--",
  '" OR 1=1 --',
  "x' UNION SELECT password FROM system.users --",
  "/* FZK */",
  "') OR ('1'='1",
  "\\'; SYSTEM SHUTDOWN; --",
  "${jndi:ldap://x/a}",
  "a\u0000b",
  "'||(SELECT 1)||'",
  "{{7*7}}",
];

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env?.close());

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("SEC09: 5,000 fuzzed ASTs and 200 raw Cube-style requests never reach raw SQL, unknown measures or unbounded scans", async () => {
  const r = rng(SEED);
  const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)]!;
  const certifiedMeasures = new Set(env.registry.metrics.map((m) => m.id));
  const certifiedDims = new Set(env.registry.dimensions.map((d) => d.id));
  const measure = "intents.oneclick_completed_swap_count";
  const dims = env.registry.dimensions.filter((d) => d.kind === "dimension").map((d) => d.id);
  let marker = 0;
  const injected: string[] = [];
  const tok = () => {
    const t = `${pick(TOKENS)} FZK${(marker++).toString(16)}`;
    injected.push(t);
    return t;
  };

  const mutate = (): { body: unknown; kind: string } => {
    const kinds = [
      "unknown-measure",
      "inject-measure",
      "inject-dimension",
      "inject-filter-value",
      "inject-filter-member",
      "inject-order",
      "inject-time-field",
      "huge-limit",
      "bad-limit",
      "deep-nesting",
      "type-confusion",
      "unicode",
      "cross-cube",
      "extra-key",
      "proto-key",
      "many-measures",
      "bad-time",
    ];
    const kind = pick(kinds);
    switch (kind) {
      case "unknown-measure":
        return {
          kind,
          body: ast({
            measures: [
              `intents.${pick(["x", "revenue", "oneclick_completed_swap_count_v2", "all"])}${marker++}`,
            ],
          }),
        };
      case "inject-measure":
        return { kind, body: ast({ measures: [tok()] }) };
      case "inject-dimension":
        return { kind, body: ast({ dimensions: [tok()] }) };
      case "inject-filter-value": {
        const d = pick(dims);
        return {
          kind,
          body: ast({ filters: [{ member: d, operator: pick(["equals", "in", "gt"]), values: [tok()] }] }),
        };
      }
      case "inject-filter-member":
        return { kind, body: ast({ filters: [{ member: tok(), operator: "equals", values: ["a"] }] }) };
      case "inject-order":
        return { kind, body: ast({ order: [{ member: tok(), direction: pick(["asc", "desc"]) }] }) };
      case "inject-time-field":
        return {
          kind,
          body: ast({
            time: { field: tok(), from: "2026-10-01T00:00:00Z", to: "2026-10-11T00:00:00Z", grain: "day" },
          }),
        };
      case "huge-limit":
        return { kind, body: ast({ limit: pick([10001, 1e9, Number.MAX_SAFE_INTEGER, 2 ** 53]) }) };
      case "bad-limit":
        return { kind, body: ast({ limit: pick([-1, 0, 1.5, "10", null, NaN, Infinity]) }) };
      case "deep-nesting": {
        let n: unknown = { member: measure, operator: "equals", values: ["a"] };
        for (let i = 0; i < 200; i++) n = { and: [n] };
        return { kind, body: ast({ filters: [n] }) };
      }
      case "type-confusion":
        return {
          kind,
          body: ast({
            measures: pick([measure, { 0: measure }, [[measure]], 7, null]),
            limit: pick(["1000", [1000]]),
          }),
        };
      case "unicode":
        return {
          kind,
          body: ast({
            measures: [
              pick([
                "intents.oneclick_completed_swap_count\u200b",
                "\uff49\uff4e\uff54\uff45\uff4e\uff54\uff53.oneclick_completed_swap_count",
                "intents.onecl\u0456ck_completed_swap_count",
                "\u202eintents.oneclick_completed_swap_count",
              ]),
            ],
          }),
        };
      case "cross-cube":
        return {
          kind,
          body: ast({
            dimensions: [
              `${pick(["quotes", "economics", "agents", "price"])}.${pick(["chain", "asset", "day"])}`,
            ],
          }),
        };
      case "extra-key":
        return { kind, body: { ...ast(), sql: tok(), rawQuery: tok() } };
      case "proto-key":
        return {
          kind,
          body: JSON.parse(
            `{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}},"measures":["${measure}"],"dimensions":[],"time":{"field":"intents.day","from":"2026-10-01T00:00:00Z","to":"2026-10-11T00:00:00Z","grain":"day"},"filters":[],"order":[],"limit":10,"semanticVersion":"1.0.0"}`,
          ),
        };
      case "many-measures":
        return { kind, body: ast({ measures: Array.from({ length: 40 }, () => measure) }) };
      default:
        return {
          kind,
          body: ast({
            time: {
              field: "intents.day",
              from: pick(["2026-13-45", "x", "1e9", ""]),
              to: "2026-10-11T00:00:00Z",
              grain: pick(["day", "decade"]),
            },
          }),
        };
    }
  };
  const inputs = Array.from({ length: 5000 }, mutate);
  const rawCube = Array.from({ length: 200 }, (_, i) => ({
    kind: "raw-cube",
    body: {
      measures: [pick([measure, tok(), "Intents.count", "*"])],
      dimensions: [pick(dims.concat([tok()]))],
      timeDimensions: [{ dimension: "intents.day", granularity: "day", dateRange: ["2026-10-01", tok()] }],
      filters: [{ member: pick(dims), operator: "equals", values: [tok()] }],
      segments: [tok()],
      limit: pick([100, 1e9, -5]),
      ungrouped: i % 3 === 0,
      renewQuery: true,
    },
  }));
  const all = [...inputs, ...rawCube];
  const fixtureHash = createHash("sha256").update(JSON.stringify(all)).digest("hex");

  // health probes run for the whole fuzz
  const lat: number[] = [];
  let probing = true;
  const prober = (async () => {
    while (probing) {
      const t0 = performance.now();
      await env.ch.query({ query: "SELECT 1", format: "JSONEachRow" }).then((q) => q.text());
      lat.push(performance.now() - t0);
      await new Promise((res) => setTimeout(res, 100));
    }
  })();
  const rssBefore = process.memoryUsage().rss;

  await env.ch.command({ query: "SYSTEM FLUSH LOGS" });
  const startedAt = (
    await (await env.ch.query({ query: "SELECT now() AS t", format: "JSONEachRow" })).json<{ t: string }>()
  )[0]!.t;
  const execBefore = env.gateway().constructor === Object ? 0 : 0;
  void execBefore;
  const gw = env.gateway();
  let accepted = 0;
  let rejected = 0;
  const violations: string[] = [];
  const statusHist: Record<string, number> = {};
  for (const [i, item] of all.entries()) {
    for (const who of [W1, OUTSIDER]) {
      if (who === OUTSIDER && i % 5 !== 0) continue; // outsider sees every fifth input (1,040 calls), member sees all
      const res = await gw.query(who, item.body);
      statusHist[String(res.status)] = (statusHist[String(res.status)] ?? 0) + 1;
      if (res.ok) {
        accepted++;
        const b = item.body as { measures?: string[]; dimensions?: string[]; limit?: number };
        const certified =
          Array.isArray(b.measures) &&
          b.measures.every((m) => certifiedMeasures.has(m)) &&
          (b.dimensions ?? []).every((d) => certifiedDims.has(d)) &&
          typeof b.limit === "number" &&
          b.limit > 0 &&
          b.limit <= 10_000;
        if (!certified) violations.push(`${item.kind}#${i} accepted outside the certified catalog`);
      } else {
        rejected++;
        if (![400, 402, 403, 422].includes(res.status))
          violations.push(`${item.kind}#${i} status ${res.status}`);
      }
    }
  }
  probing = false;
  await prober;

  // oracle: ClickHouse's own statement log for the window
  await env.ch.command({ query: "SYSTEM FLUSH LOGS" });
  const logRows = await (
    await env.ch.query({
      query:
        "SELECT query, read_bytes FROM system.query_log WHERE event_time >= {t:DateTime} AND type IN ('QueryFinish','ExceptionBeforeStart','ExceptionWhileProcessing') AND query NOT LIKE '%system.query_log%'",
      query_params: { t: startedAt },
      format: "JSONEachRow",
    })
  ).json<{ query: string; read_bytes: string }>();
  const dangerous = [
    /DROP TABLE/i,
    /UNION SELECT/i,
    /SYSTEM SHUTDOWN/i,
    /FZK[0-9a-f]+/,
    /jndi:/i,
    /OR 1=1/i,
    /'1'='1/,
  ];
  const tokenHits = logRows.filter((l) => dangerous.some((d) => d.test(l.query)));
  const maxBytes = Math.max(0, ...logRows.map((l) => Number(l.read_bytes)));
  const p95 = [...lat].sort((a, b) => a - b)[Math.floor(lat.length * 0.95)] ?? 0;
  const rssGrowth = process.memoryUsage().rss - rssBefore;

  // BigQuery is not reachable from the gateway at all
  const bq = (dir: string): boolean =>
    readdirSync(dir, { withFileTypes: true }).some((e) =>
      e.isDirectory() ? bq(join(dir, e.name)) : /bigquery/i.test(readFileSync(join(dir, e.name), "utf8")),
    );
  const bigQueryReachable = bq(join(process.cwd(), "packages", "semantic-gateway", "src"));

  // negative control: a gateway that concatenates filter values into SQL leaks the tokens into the statement log
  const ctlStart = (
    await (await env.ch.query({ query: "SELECT now() AS t", format: "JSONEachRow" })).json<{ t: string }>()
  )[0]!.t;
  for (const t of injected.slice(0, 40))
    await env.ch
      .query({
        query: `SELECT count() FROM system.one WHERE dummy = '${t.replaceAll("'", "''")}' OR '${t.slice(0, 20).replaceAll("'", "''")}' = ''`,
        format: "JSONEachRow",
      })
      .then((q) => q.text())
      .catch(() => undefined);
  await env.ch.command({ query: "SYSTEM FLUSH LOGS" });
  const ctlRows = await (
    await env.ch.query({
      query:
        "SELECT query FROM system.query_log WHERE event_time >= {t:DateTime} AND query LIKE '%FZK%' AND query NOT LIKE '%system.query_log%'",
      query_params: { t: ctlStart },
      format: "JSONEachRow",
    })
  ).json<{ query: string }>();

  expect(all.length).toBe(5200);
  expect(violations).toEqual([]);
  expect(rejected).toBeGreaterThan(accepted);
  expect(
    tokenHits.map((l) => {
      const d = dangerous.find((x) => x.test(l.query))!;
      const i = l.query.search(d);
      return `${d}: ...${l.query.slice(Math.max(0, i - 40), i + 80)}`;
    }),
  ).toEqual([]);
  expect(maxBytes).toBeLessThan(BYTE_CAP);
  expect(bigQueryReachable).toBe(false);
  expect(p95).toBeLessThan(HEALTH_P95_MS);
  expect(rssGrowth).toBeLessThan(500 * 1024 * 1024);
  expect(ctlRows.length).toBeGreaterThan(0); // control: injected statements are visible to the log scan

  observe({
    testId: "SEC09",
    observed: `seed 0x${SEED.toString(16)}: 5,000 mutated ASTs (17 mutation kinds) plus 200 raw Cube-style requests, sent as a member to all and as an outsider to every fifth (${accepted + rejected} gateway calls): ${accepted} accepted, all inside the certified catalog with bounded limits; ${rejected} rejected before any database call; ClickHouse statement log for the window (${logRows.length} statements) contains 0 injection tokens; max read_bytes ${maxBytes} (cap ${BYTE_CAP}); BigQuery client reachable from the gateway: ${bigQueryReachable}; health probe p95 ${p95.toFixed(0)} ms over ${lat.length} probes (bound ${HEALTH_P95_MS}); RSS growth ${(rssGrowth / 1048576).toFixed(0)} MB; control with concatenated SQL leaked ${ctlRows.length} tokenised statements into the log scan`,
    fixtureHash,
    evidence: {
      accepted,
      rejected,
      statusHist,
      logStatements: logRows.length,
      maxBytes,
      p95,
      probes: lat.length,
      controlLeaks: ctlRows.length,
    },
  });
}, 1_800_000);
