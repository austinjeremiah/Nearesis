import { describe, expect, test } from "vitest";
import { loadRegistry } from "@nearesis/analytics";
import { buildCacheKey, parseCacheKey, aclClassOf } from "../../src/cache.ts";
import { estimateRows, formatScale } from "../../src/gateway.ts";
import { DEFAULT_POLICY } from "../../src/types.ts";
import { unitsCompatible, validateQuery } from "../../src/validate.ts";
import { bucketStart, nextBucket } from "../../src/time.ts";

const parts = {
  tenantId: "t1",
  workspaceId: "w1",
  aclClasses: ["b", "a"],
  semanticVersion: "1.0.0",
  semanticModelHash: "ab".repeat(32),
  sourceVintage: "0123456789abcdef",
  queryHash: "cd".repeat(32),
};

describe("cache key", () => {
  test("carries scope, acl, version, hash, vintage and is order-insensitive in acl", () => {
    const k = buildCacheKey(parts);
    expect(k.startsWith("semantic:q:")).toBe(true);
    const p = parseCacheKey(k);
    expect(p).toMatchObject({
      tenant: "t1",
      workspace: "w1",
      semanticVersion: "1.0.0",
      vintage: "0123456789abcdef",
    });
    expect(buildCacheKey({ ...parts, aclClasses: ["a", "b", "a"] })).toBe(k);
  });
  test.each([
    ["tenantId", "t2"],
    ["workspaceId", "w2"],
    ["semanticVersion", "1.1.0"],
    ["semanticModelHash", "ef".repeat(32)],
    ["sourceVintage", "ffffffffffffffff"],
    ["queryHash", "00".repeat(32)],
    ["aclClasses", ["admin"]],
  ])("changing %s changes the key", (field, value) => {
    expect(buildCacheKey({ ...parts, [field]: value })).not.toBe(buildCacheKey(parts));
  });
  test("acl class is stable", () => expect(aclClassOf(["x", "y"])).toBe(aclClassOf(["y", "x"])));
});

describe("units and cost", () => {
  test("unit compatibility table", () => {
    expect(unitsCompatible(["swaps", "swaps"])).toBe(true);
    expect(unitsCompatible(["swaps", "usd"])).toBe(false);
    expect(unitsCompatible([])).toBe(true);
  });
  test("cost estimate is rows/day times days", () => {
    expect(estimateRows({ a: 10, b: 2.5 }, 4)).toBe(50);
    expect(estimateRows({}, 100)).toBe(0);
  });
  test("exact decimal formatting stays textual", () => {
    expect(formatScale("7.5", 18)).toBe("7.500000000000000000");
    expect(formatScale("340282366920938463463374607431768211455", 0)).toBe(
      "340282366920938463463374607431768211455",
    );
    expect(formatScale("-1.2", 3)).toBe("-1.200");
  });
});

describe("pure validateQuery", () => {
  const reg = loadRegistry();
  const q = (o = {}) => ({
    semanticVersion: reg.semanticVersion,
    measures: ["intents.oneclick_completed_swap_count"],
    dimensions: [],
    time: { field: "intents.day", from: "2026-10-01T00:00:00Z", to: "2026-10-11T00:00:00Z", grain: "day" },
    filters: [],
    order: [],
    limit: 10,
    ...o,
  });
  test("accepts a valid query", () => expect(validateQuery(q(), DEFAULT_POLICY, reg).ok).toBe(true));
  test("rejects a restricted metric unless granted", () => {
    const m = {
      measures: ["economics.externally_reported_revenue_usd"],
      time: {
        field: "economics.day",
        from: "2026-10-01T00:00:00Z",
        to: "2026-10-11T00:00:00Z",
        grain: "day",
      },
    };
    const r = validateQuery(q(m), DEFAULT_POLICY, reg);
    expect(!r.ok && r.status).toBe(403);
    expect(
      validateQuery(
        q(m),
        { ...DEFAULT_POLICY, grantedMembers: ["economics.externally_reported_revenue_usd"] },
        reg,
      ).ok,
    ).toBe(true);
  });
  test("mixed views are refused", () => {
    const r = validateQuery(
      q({ measures: ["intents.oneclick_completed_swap_count", "near.daily_successful_tx_count"] }),
      DEFAULT_POLICY,
      reg,
    );
    expect(!r.ok && r.error.reasonCode).toBe("INCOMPATIBLE_VIEWS");
  });
});

describe("time buckets", () => {
  test("weeks start Monday, months on the first", () => {
    expect(new Date(bucketStart(Date.parse("2026-10-01T05:00:00Z"), "week")).toISOString()).toBe(
      "2026-09-28T00:00:00.000Z",
    );
    expect(new Date(nextBucket(Date.parse("2026-12-01T00:00:00Z"), "month")).toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});
