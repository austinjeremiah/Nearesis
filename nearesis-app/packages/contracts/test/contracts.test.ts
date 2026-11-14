import { describe, expect, it } from "vitest";
import * as C from "../src/index.ts";
import { toSchemas } from "../scripts/gen-schemas.ts";

const uuid = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(64);
const now = "2026-11-10T12:00:00Z";

const panel = {
  panelId: uuid,
  schemaVersion: 1,
  kind: "timeSeries",
  title: "Daily swaps",
  queryRef: { hash: sha, semanticVersion: "1.0.0" },
  dataBinding: {
    fields: ["day", "swaps"],
    units: { swaps: "count" },
    timezone: "UTC",
    completeness: "complete",
  },
  encoding: { x: "day", y: ["swaps"] },
  layout: { x: 0, y: 0, w: 6, h: 4 },
  refreshPolicy: { mode: "on_watermark" },
  provenanceRequired: true,
};

describe("SemanticQuery (ch.20 strict)", () => {
  const ok = {
    semanticVersion: "1.0.0",
    measures: ["intents.swap_count"],
    dimensions: [],
    time: {
      field: "intents.block_date",
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-31T00:00:00Z",
      grain: "day",
    },
    filters: [],
    order: [],
    limit: 100,
  };
  it("accepts a bounded query", () => expect(C.SemanticQuery.safeParse(ok).success).toBe(true));
  it.each([
    ["unknown field sql", { ...ok, sql: "select 1" }],
    ["client tenantId", { ...ok, tenantId: uuid }],
    ["securityContext", { ...ok, securityContext: {} }],
    ["9 measures", { ...ok, measures: Array.from({ length: 9 }, (_, i) => `a.m${i}`) }],
    ["limit 10001", { ...ok, limit: 10001 }],
    ["from>=to", { ...ok, time: { ...ok.time, from: ok.time.to } }],
    ["like operator", { ...ok, filters: [{ member: "a.b", operator: "like", values: ["x"] }] }],
    ["sql in member", { ...ok, measures: ["a.b; DROP"] }],
  ])("rejects %s", (_n, q) => expect(C.SemanticQuery.safeParse(q).success).toBe(false));
});

describe("PanelSpec (C02/C09/C10 surface)", () => {
  it("accepts a registered declarative panel", () => expect(C.PanelSpec.safeParse(panel).success).toBe(true));
  it("rejects unknown kind", () =>
    expect(C.PanelSpec.safeParse({ ...panel, kind: "sankey3d" }).success).toBe(false));
  it("rejects jsx/formatter injection fields", () => {
    expect(C.PanelSpec.safeParse({ ...panel, jsx: "<div/>" }).success).toBe(false);
    expect(
      C.PanelSpec.safeParse({ ...panel, encoding: { ...panel.encoding, formatter: "function(){}" } }).success,
    ).toBe(false);
  });
  it("requires provenanceRequired=true", () =>
    expect(C.PanelSpec.safeParse({ ...panel, provenanceRequired: false }).success).toBe(false));
  it("canvas patch requires >=1 op and expectedRevision", () => {
    expect(
      C.CanvasPatch.safeParse({
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: uuid,
        expectedRevision: 0,
        operations: [{ op: "addPanel", panel }],
      }).success,
    ).toBe(true);
    expect(
      C.CanvasPatch.safeParse({
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: uuid,
        expectedRevision: 0,
        operations: [],
      }).success,
    ).toBe(false);
  });
});

describe("PluginManifest (ch.04/ch.20)", () => {
  const m = {
    pluginId: "near-explorer",
    version: "1.0.0",
    apiVersion: 1,
    publisher: "nearesis",
    artifactSha256: sha,
    capabilities: [
      {
        id: "near.explorer.listSwaps@1",
        category: "data.source",
        sideEffect: "read_only",
        idempotent: true,
        latencyClass: "batch",
        inputSchema: {},
        outputSchema: {},
        requiredGrants: ["data.read"],
        timeoutMs: 10000,
        maxOutputBytes: 1000000,
      },
    ],
    permissions: ["egress:explorer.near-intents.org"],
    networkHosts: ["explorer.near-intents.org"],
    resourceLimits: { memoryMb: 256, cpuMs: 10000, concurrency: 1 },
    configurationSchema: {},
    healthCheck: { intervalMs: 60000 },
    entrypoint: "dist/index.js",
    rollbackStrategy: "previous_version",
  };
  it("accepts unsigned manifest shape (trust policy enforced by kernel, K05)", () =>
    expect(C.PluginManifest.safeParse(m).success).toBe(true));
  it("rejects missing rollbackStrategy (K11)", () => {
    const { rollbackStrategy: _r, ...rest } = m;
    expect(C.PluginManifest.safeParse(rest).success).toBe(false);
  });
  it("rejects bad capability id", () =>
    expect(
      C.PluginManifest.safeParse({ ...m, capabilities: [{ ...m.capabilities[0], id: "Explorer" }] }).success,
    ).toBe(false));
});

describe("Observations, monitor, errors", () => {
  it("QuoteAttempt must be dry", () => {
    const q = {
      routeId: "r1",
      amountBaseUnits: "1000000",
      privacyMode: "public",
      scheduledBucketUTC: now,
      attemptNo: 1,
      dry: true,
      class: "NO_QUOTE",
      amountOutBaseUnits: null,
      fetchedAtUTC: now,
      rawObjectHash: null,
    };
    expect(C.QuoteAttempt.safeParse(q).success).toBe(true);
    expect(C.QuoteAttempt.safeParse({ ...q, dry: false }).success).toBe(false);
  });
  it("DecimalString rejects floats in exponent form", () => {
    expect(C.DecimalString.safeParse("340282366920938463463374607431768211455").success).toBe(true);
    expect(C.DecimalString.safeParse("1e21").success).toBe(false);
  });
  it("AgentRecord matches directive shape", () => {
    expect(
      C.AgentRecord.safeParse({
        agentId: "A1",
        parentEngine: "ENGINE_A",
        model: "sonnet",
        taskId: "T-P00-FOUNDATION",
        task: "x",
        ownedPaths: [],
        status: "RUNNING",
        startedAt: now,
        heartbeatAt: now,
        testsPassed: 0,
        testsFailed: 0,
        blockerIds: [],
        commitSha: null,
      }).success,
    ).toBe(true);
  });
  it("run state machine has terminal states with no exits", () => {
    for (const s of ["COMPLETE", "PARTIAL", "BLOCKED", "CANCELLED"] as const)
      expect(C.RUN_TRANSITIONS[s]).toEqual([]);
  });
  it("every error code maps to an HTTP status", () => {
    for (const c of C.ErrorCode.options) expect(C.HTTP_STATUS_FOR[c]).toBeGreaterThanOrEqual(400);
  });
});

describe("JSON Schema export", () => {
  it("exports every contract as JSON Schema", () => {
    const s = toSchemas();
    expect(Object.keys(s).length).toBeGreaterThanOrEqual(27);
    for (const v of Object.values(s)) expect(typeof v).toBe("object");
  });
});

describe("v1.1.0 additions (INTEGRATION_QUEUE 11:53Z/11:58Z)", () => {
  it("PatchOp accepts removeMarker and clearSelection, still rejects unknown ops", () => {
    expect(C.PatchOp.safeParse({ op: "removeMarker", markerId: uuid }).success).toBe(true);
    expect(C.PatchOp.safeParse({ op: "clearSelection", panelId: uuid }).success).toBe(true);
    expect(C.PatchOp.safeParse({ op: "dropTable", panelId: uuid }).success).toBe(false);
    expect(C.PatchOp.safeParse({ op: "removeMarker", markerId: "x" }).success).toBe(false);
  });
  it("v1.0.0 patch payloads remain valid (backward compatible)", () => {
    expect(C.PatchOp.safeParse({ op: "removePanel", panelId: uuid }).success).toBe(true);
    // additive releases only move forward within major 1
    const [maj, min] = C.CONTRACTS_VERSION.split(".").map(Number);
    expect(maj).toBe(1);
    expect(min).toBeGreaterThanOrEqual(1);
  });
  it("enum types are usable as types", () => {
    const q: C.QuoteAttemptClass = "NO_QUOTE";
    const v: C.TestVerdict = "PASS";
    expect([q, v]).toEqual(["NO_QUOTE", "PASS"]);
  });
});

describe("v1.2.0 additions (graph)", () => {
  it("GraphProjection validates a kernel-shaped projection and rejects unknown relations", () => {
    const g = {
      workspaceId: uuid,
      version: 3,
      nodes: [
        { id: "q1", type: "query", label: "Daily swaps", queryRef: sha },
        { id: "m1", type: "marker", label: "Oct 27" },
      ],
      edges: [{ id: "e1", source: "m1", target: "q1", relation: "references", origin: "derived" }],
      unresolved: [],
    };
    expect(C.GraphProjection.safeParse(g).success).toBe(true);
    expect(C.GraphProjection.safeParse({ ...g, edges: [{ ...g.edges[0], relation: "owns" }] }).success).toBe(
      false,
    );
    expect(
      C.GraphProjection.safeParse({ ...g, nodes: [{ id: "x", type: "widget", label: "x" }] }).success,
    ).toBe(false);
  });
  it("graph.save_layout is a contract command and v1.1.0 commands remain valid", () => {
    expect(C.CommandType.safeParse("graph.save_layout").success).toBe(true);
    expect(C.CommandType.safeParse("canvas.apply_patch").success).toBe(true);
    expect(C.SaveGraphLayoutPayload.safeParse({ positions: { q1: { x: 1, y: 2 } } }).success).toBe(true);
    expect(C.CONTRACTS_VERSION).toMatch(/^1\.[23456789]\.0$/);
  });
});
