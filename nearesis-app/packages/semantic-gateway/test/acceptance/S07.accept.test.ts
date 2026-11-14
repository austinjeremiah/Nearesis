import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import { baseline, bumpMinor, sealRegistry, type Registry } from "@nearesis/analytics";
import { parseCacheKey } from "../../src/index.ts";
import { ast, setupEnv, W1, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env.close());

test("S07 a changed semantic version/hash never serves the previous cached result", async () => {
  const v1 = env.registry;
  const gw1 = env.gateway({ registry: v1 });
  const a = await gw1.query(W1, ast());
  const b = await gw1.query(W1, ast());
  expect(a.ok && a.cache).toBe("miss");
  expect(b.ok && b.cache).toBe("hit");
  expect(a.ok && b.ok && a.cacheKey === b.cacheKey).toBe(true);

  // (1) new semantic version + hash: old AST is stale, never answered from the old cache entry.
  const changed = structuredClone(v1.metrics);
  changed.find((m) => m.id === "intents.oneclick_completed_swap_count")!.transformations = [
    "Swaps with latest status SUCCESS (reviewed redefinition)",
  ];
  const v2: Registry = sealRegistry({
    ...v1,
    semanticVersion: bumpMinor(v1.semanticVersion),
    metrics: changed,
  });
  expect(v2.contentHash).not.toBe(v1.contentHash);
  const gw2 = env.gateway({ registry: v2 });
  const stale = await gw2.query(W1, ast());
  expect(stale.ok).toBe(false);
  if (!stale.ok) {
    expect(stale.status).toBe(409);
    expect(stale.error.reasonCode).toBe("STALE_SEMANTIC_VERSION");
  }
  expect(gw2.stats().executions).toBe(0);
  const fresh = await gw2.query(W1, ast({ semanticVersion: v2.semanticVersion }));
  expect(fresh.ok && fresh.cache).toBe("miss");
  expect(gw2.stats().executions).toBe(1);

  // (2) same version label but different content hash: key differs in the hash component, so the v1 entry is not served.
  const v1b: Registry = sealRegistry({ ...v1, metrics: changed });
  const gw3 = env.gateway({ registry: v1b });
  const same = await gw3.query(W1, ast());
  expect(same.ok && same.cache).toBe("miss");
  const k1 = parseCacheKey(a.ok ? a.cacheKey : "");
  const k2 = parseCacheKey(fresh.ok ? fresh.cacheKey : "");
  const k3 = parseCacheKey(same.ok ? same.cacheKey : "");
  expect(k1.semanticVersion).not.toBe(k2.semanticVersion);
  expect(k1.semanticHash).not.toBe(k2.semanticHash);
  expect(k1.semanticVersion).toBe(k3.semanticVersion);
  expect(k1.semanticHash).not.toBe(k3.semanticHash);
  // v1 gateway still hits its own entry (nothing was evicted or corrupted).
  const again = await gw1.query(W1, ast());
  expect(again.ok && again.cache).toBe("hit");
  observe({
    testId: "S07",
    observed: `v1 query: miss then hit (same key). After version bump ${v1.semanticVersion}->${v2.semanticVersion} the old AST is refused 409 STALE_SEMANTIC_VERSION (0 executions) and the new AST misses and executes; with an unchanged label but new content hash the key's hash component differs (${k1.semanticHash} vs ${k3.semanticHash}) and the query misses`,
    fixtureHash: baseline().digest,
    evidence: { keys: { v1: k1, v2: k2, v1WithNewHash: k3 }, v1Hash: v1.contentHash, v2Hash: v2.contentHash },
  });
});
