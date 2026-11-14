import { describe, expect, it } from "vitest";
import { CATALOG_UNAVAILABLE, catalogUnreadable } from "../src/source-gate.ts";

describe("fresh-data gate fails closed", () => {
  it("an unreadable or empty live catalog blocks the run with catalog_unavailable", () => {
    expect(CATALOG_UNAVAILABLE).toBe("catalog_unavailable");
    expect(catalogUnreadable({})).toBe(true);
    expect(catalogUnreadable(undefined)).toBe(true);
    expect(catalogUnreadable(null)).toBe(true);
  });
  it("a catalog that names at least one metric's sources is readable", () => {
    expect(catalogUnreadable({ m: ["intents-1click"] })).toBe(false);
  });
});

import { contextNeedsRebind } from "../src/source-gate.ts";
describe("a failed catalog read is not frozen into the run", () => {
  it("an empty stored map is rebound, a populated one is kept, no context is not a rebind", () => {
    expect(contextNeedsRebind({ metricSources: {} })).toBe(true);
    expect(contextNeedsRebind({ metricSources: { m: ["a"] } })).toBe(false);
    expect(contextNeedsRebind(null)).toBe(false);
  });
});
