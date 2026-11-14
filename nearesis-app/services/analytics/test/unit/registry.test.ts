import { describe, expect, test } from "vitest";
import { MetricMetadata } from "@nearesis/contracts";
import {
  applyChange,
  bumpMinor,
  canonicalJson,
  computeHash,
  generateMetricsMd,
  loadRegistry,
  renderAll,
  sealRegistry,
  toRows,
  baseline,
} from "../../src/index.ts";

describe("registry", () => {
  const r = loadRegistry();
  test("hash is deterministic and key-order independent", () => {
    expect(computeHash(r)).toBe(r.contentHash);
    const shuffled = JSON.parse(
      JSON.stringify({
        evaluators: r.evaluators,
        exactScales: r.exactScales,
        dimensions: r.dimensions,
        metrics: r.metrics,
      }),
    );
    expect(computeHash(shuffled)).toBe(r.contentHash);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
  test("every metric satisfies the contract and cubeMember is unique", () => {
    for (const m of r.metrics) MetricMetadata.parse(m);
    expect(new Set(r.metrics.map((m) => m.cubeMember)).size).toBe(r.metrics.length);
  });
  test("applyChange bumps version and hash and leaves the base untouched", () => {
    const next = applyChange(r, {
      metricId: "near.distinct_signer_proxy",
      patch: { uncertainty: "changed" },
    });
    expect(next.semanticVersion).toBe(bumpMinor(r.semanticVersion));
    expect(next.contentHash).not.toBe(r.contentHash);
    expect(r.metrics.find((m) => m.id === "near.distinct_signer_proxy")!.uncertainty).not.toBe("changed");
    expect(sealRegistry(next).contentHash).toBe(next.contentHash);
  });
  test("METRICS.md is deterministic and lists every metric", () => {
    const md = generateMetricsMd(r);
    expect(generateMetricsMd(r)).toBe(md);
    for (const m of r.metrics) expect(md).toContain(`## ${m.id}`);
  });
  test("Cube model generation is deterministic and copies registry meta", () => {
    const a = renderAll(r);
    expect(renderAll(r)).toEqual(a);
    expect(Object.keys(a)).toHaveLength(8);
    expect(a["near_usage.yml"]).toContain('"id":"near.daily_successful_tx_count"');
  });
  test("loader maps amounts without touching strings", () => {
    const rows = toRows(baseline());
    expect(rows.intents_swaps![0]!.amount_in_raw).toBe("1000000000000000000000000");
  });
});
