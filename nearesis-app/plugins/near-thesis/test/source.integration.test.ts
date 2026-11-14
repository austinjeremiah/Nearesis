/** Per-run semantic source: the plugin answers from the layer registered for the principal's run, defaulting to fixture. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { InvocationContext } from "@nearesis/plugin-sdk";
import { gateway, registerRunSource, sourceOf } from "../src/entry.ts";

const ctx = (parentRunId?: string) =>
  ({
    principal: {
      kind: "agent",
      actorId: randomUUID(),
      orgId: randomUUID(),
      ...(parentRunId ? { parentRunId } : {}),
    },
    workspaceId: randomUUID(),
  }) as unknown as InvocationContext;

describe("sourceOf", () => {
  it("returns the source registered for the principal's run", () => {
    const live = randomUUID();
    const fx = randomUUID();
    registerRunSource(live, "live");
    registerRunSource(fx, "fixture");
    expect(sourceOf(ctx(live))).toBe("live");
    expect(sourceOf(ctx(fx))).toBe("fixture");
  });
  it("falls back to fixture, never live, without a run or for an unregistered run", () => {
    expect(sourceOf(ctx())).toBe("fixture");
    expect(sourceOf(ctx(randomUUID()))).toBe("fixture");
  });
});

describe("gateway(source)", () => {
  it("wires distinct registries: live metrics are live.*, fixture metrics are not", () => {
    const live = gateway("live").registry.metrics.map((m) => m.id);
    const fx = gateway("fixture").registry.metrics.map((m) => m.id);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((id) => id.startsWith("live."))).toBe(true);
    expect(fx.some((id) => id.startsWith("live."))).toBe(false);
    expect(gateway("live")).toBe(gateway("live"));
  });
});
