import { afterAll, beforeAll, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { observe } from "@nearesis/acceptance";
import { baseline, sealRegistry, type Registry } from "@nearesis/analytics";
import { DEFAULT_POLICY, parseCacheKey, type Policy, type Session } from "../../src/index.ts";
import { ast, setupEnv, W1, W2, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env.close());

const RESTRICTED = "fx.restricted_metric";
const policyFor = (s: Session): Policy => ({
  ...DEFAULT_POLICY,
  grantedMembers: s.workspaceId === "w1" ? [RESTRICTED] : [],
});

test("S16 discovery and cache are partitioned by tenant, workspace and ACL class", async () => {
  const base = env.registry;
  const reg: Registry = sealRegistry({
    ...base,
    metrics: [
      ...base.metrics,
      {
        ...base.metrics.find((m) => m.id === "intents.oneclick_total_swap_count")!,
        id: RESTRICTED,
        displayName: "Zebra confidential fixture metric",
        visibility: "restricted",
        cubeMember: "intents.oneclick_total_swap_count",
      },
    ],
  });
  const gw = env.gateway({ registry: reg, policy: policyFor });
  const q = (o: Record<string, unknown> = {}) => ast({ semanticVersion: reg.semanticVersion, ...o });

  // 1. discovery
  const c1 = await gw.discover(W1);
  const c2 = await gw.discover(W2);
  expect(c1.metrics.some((m) => m.id === RESTRICTED)).toBe(true);
  const c2json = JSON.stringify(c2);
  expect(c2.metrics.some((m) => m.id === RESTRICTED)).toBe(false);
  for (const needle of [RESTRICTED, "Zebra", "externally_reported_revenue", "intents.referral"])
    expect(c2json).not.toContain(needle);

  // 2. same public AST A from both scopes
  const a1 = await gw.query(W1, q());
  const a2 = await gw.query(W2, q());
  expect(a1.ok && a2.ok).toBe(true);
  if (!a1.ok || !a2.ok) return;
  expect(a1.cache).toBe("miss");
  expect(a2.cache).toBe("miss"); // never a cross-scope hit: no key is marked public-shareable
  const ka1 = parseCacheKey(a1.cacheKey);
  const ka2 = parseCacheKey(a2.cacheKey);
  expect(ka1.tenant).not.toBe(ka2.tenant);
  expect(ka1.workspace).not.toBe(ka2.workspace);
  const admin = await gw.query({ ...W1, aclClasses: ["admin"] }, q());
  expect(admin.ok && parseCacheKey(admin.cacheKey).acl).not.toBe(ka1.acl);

  // 3-4. restricted AST B
  const bq = q({ measures: [RESTRICTED] });
  const b1 = await gw.query(W1, bq);
  const b1again = await gw.query(W1, bq);
  expect(b1.ok && b1.cache).toBe("miss");
  expect(b1again.ok && b1again.cache).toBe("hit");
  const b2 = await gw.query(W2, bq);
  expect(b2.ok).toBe(false);
  if (!b2.ok) {
    expect([403, 422]).toContain(b2.status);
    const body = JSON.stringify(b2.error);
    for (const needle of ["Zebra", "confidential", "fixture metric", "cubeMember", "unit"])
      expect(body).not.toContain(needle);
  }

  // 5. cache keys
  // The dev Redis is shared with other agents' runtime tests, which write semantic:q:* keys under their own random
  // tenant ids; check every key produced by this test's own scopes (tenants t1 and t2), not foreign writers' keys.
  const keys = (await env.redis.keys("semantic:q:*"))
    .filter((k) => ["t1", "t2"].includes(parseCacheKey(k).tenant ?? ""))
    .sort();
  expect(keys.length).toBeGreaterThanOrEqual(4);
  for (const k of keys) {
    const p = parseCacheKey(k);
    expect(p.semanticVersion).toBe(reg.semanticVersion);
    expect(p.semanticHash).toBe(reg.contentHash.slice(0, 12));
    expect(p.vintage).toMatch(/^[0-9a-f]{16}$/);
    expect(p.tenant && p.workspace && p.acl).toBeTruthy();
  }
  const stored = await Promise.all(keys.map((k) => env.redis.get(k)));
  const leakedToW2 = keys.filter(
    (k, i) => parseCacheKey(k).workspace === "w2" && (stored[i] ?? "").includes(RESTRICTED),
  );
  expect(leakedToW2).toHaveLength(0);
  observe({
    testId: "S16",
    observed: `W2 catalog omits ${RESTRICTED} and leaks none of its metadata; identical public AST from W1 and W2 produced distinct keys (tenant/workspace/acl components) and W2 got a miss (policy: strict scope isolation, no public-shareable class); admin ACL gets its own key; restricted B from W1 cached (miss then hit) while W2 got ${b2.ok ? "200" : b2.status} ${b2.ok ? "" : b2.error.reasonCode}; all ${keys.length} cache keys carry version, hash and vintage`,
    fixtureHash: baseline().digest,
    evidence: {
      policy:
        "strict-scope-isolation: every key carries tenant+workspace+acl; no key is shared across scopes",
      w1CatalogCount: c1.metrics.length,
      w2CatalogCount: c2.metrics.length,
      keyHashes: keys.map((k) => createHash("sha256").update(k).digest("hex").slice(0, 16)),
      restrictedStatusForW2: b2.ok ? 200 : b2.status,
      audit: gw
        .audit()
        .map((x) => ({ workspace: x.workspaceId, outcome: x.outcome, reason: x.reasonCode ?? null })),
    },
  });
});
