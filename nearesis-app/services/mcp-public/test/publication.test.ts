import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cautionStatuses, readManifest } from "@nearesis/capsule";
import { describe, expect, it } from "vitest";
import { createGatewayServer, PUBLIC_PRINCIPAL } from "../src/gateway.ts";
import { connect, jsonOf, makeRoot, ORG_A, ORG_B, publishCapsule, WS_A, WS_B } from "./helpers.ts";

async function gatewayClient(root: string) {
  const server = createGatewayServer({ capsuleRoot: root, principal: PUBLIC_PRINCIPAL });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1.0.0" });
  await client.connect(b);
  return { client, close: async () => (await client.close(), await server.close()) };
}

const ids = async (root: string): Promise<{ server: string[]; gateway: string[] }> => {
  const s = await connect(root, { id: "anonymous", kind: "anonymous" });
  const g = await gatewayClient(root);
  const sl = jsonOf(await s.client.callTool({ name: "list_capsules", arguments: {} })) as {
    capsules: Array<{ capsuleId: string }>;
  };
  const gl = jsonOf(await g.client.callTool({ name: "semantic_discover", arguments: {} })) as {
    metrics: Array<{ capsuleId: string }>;
  };
  await s.close();
  await g.close();
  return {
    server: sl.capsules.map((c) => c.capsuleId),
    gateway: [...new Set(gl.metrics.map((m) => m.capsuleId))],
  };
};

describe("public MCP serves only explicitly published capsules", () => {
  it("a draft (no publication record) is invisible on list, summary, verify and query", async () => {
    const { root, capsuleId } = makeRoot({ publish: false });
    expect(await ids(root)).toEqual({ server: [], gateway: [] });
    const s = await connect(root, { id: "anonymous", kind: "anonymous" });
    for (const name of ["get_capsule_summary", "get_claims", "verify_capsule_local"]) {
      const r = await s.client.callTool({ name, arguments: { capsuleId } });
      expect(jsonOf(r)).toMatchObject({ errorCode: "NOT_FOUND" });
    }
    await s.close();
    const g = await gatewayClient(root);
    for (const [name, args] of [
      ["semantic_query", { capsuleId, metricId: "x" }],
      ["chart_preview", { capsuleId }],
      ["capsule_verify", { capsuleId }],
    ] as const) {
      expect(jsonOf(await g.client.callTool({ name, arguments: args }))).toMatchObject({
        errorCode: "NOT_FOUND",
      });
    }
    await g.close();
  });

  it("publish makes it public on both servers; unpublish withdraws it again", async () => {
    const { root, capsuleId } = makeRoot({ publish: false });
    publishCapsule(root, capsuleId);
    expect(await ids(root)).toEqual({ server: [capsuleId], gateway: [capsuleId] });
    publishCapsule(root, capsuleId, { state: "unpublished" });
    expect(await ids(root)).toEqual({ server: [], gateway: [] });
  });

  it("a failed or tampered publication record never publishes", async () => {
    const { root, capsuleId } = makeRoot({ publish: false });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, capsuleId, "publication-state.json"), "{not json");
    expect(await ids(root)).toEqual({ server: [], gateway: [] });
    writeFileSync(join(root, capsuleId, "publication-state.json"), JSON.stringify({ state: "published" }));
    expect(await ids(root)).toEqual({ server: [], gateway: [] });
  });

  it("cross-tenant negative: a record naming another org or workspace than the owner does not publish", async () => {
    const { root, capsuleId } = makeRoot({ publish: false });
    // owned by org A / ws A, but the publication record claims org B / ws B (a copied or forged record)
    publishCapsule(root, capsuleId, { org: ORG_B, ws: WS_B, ownedBy: { org: ORG_A, ws: WS_A } });
    expect(await ids(root)).toEqual({ server: [], gateway: [] });
    // same org, different workspace
    publishCapsule(root, capsuleId, { org: ORG_A, ws: WS_B, ownedBy: { org: ORG_A, ws: WS_A } });
    expect(await ids(root)).toEqual({ server: [], gateway: [] });
    // an unowned capsule with a publication record is not public
    const { rmSync: rm } = await import("node:fs");
    rm(join(root, capsuleId, "ownership.json"));
    expect(await ids(root)).toEqual({ server: [], gateway: [] });
  });

  it("one tenant's published capsule does not expose another tenant's draft in the same root", async () => {
    const { root, capsuleId } = makeRoot();
    cpSync(join(root, capsuleId), join(root, "cap-other-tenant-draft"), { recursive: true });
    rmSync(join(root, "cap-other-tenant-draft", "publication-state.json"));
    publishCapsule(root, "cap-other-tenant-draft", { org: ORG_B, ws: WS_B, state: "unpublished" });
    const r = await ids(root);
    expect(r.server).toEqual([capsuleId]);
    expect(r.gateway).toEqual([capsuleId]);
  });

  it("cautionStatuses names INSUFFICIENT_DATA and METHOD_NOT_VALIDATED results", () => {
    const { root, capsuleId } = makeRoot({ publish: false });
    const m = readManifest(join(root, capsuleId))!;
    expect(cautionStatuses({ ...m, results: [{ ...m.results[0]!, value: "METHOD_NOT_VALIDATED" }] })).toEqual(
      ["METHOD_NOT_VALIDATED"],
    );
    expect(
      cautionStatuses({ ...m, results: [{ ...m.results[0]!, value: "INSUFFICIENT_DATA (n=3)" }] }),
    ).toEqual(["INSUFFICIENT_DATA"]);
  });
});
