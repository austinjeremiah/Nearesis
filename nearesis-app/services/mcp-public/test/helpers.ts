import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCapsule, writeCapsuleOwnership, writeCapsulePublicationState } from "@nearesis/capsule";
import { createPublicMcpServer } from "../src/index.ts";
import type { Principal } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, "..", "..", "..");
export const SNAPSHOT = join(APP, "packages", "capsule", "fixtures", "snapshot-synthetic");
export const RESEARCH = join(APP, "packages", "test-fixtures", "research", "signal-bundle");

export const ORG_A = "11111111-1111-4111-8111-111111111111";
export const WS_A = "22222222-2222-4222-8222-222222222222";
export const ORG_B = "33333333-3333-4333-8333-333333333333";
export const WS_B = "44444444-4444-4444-8444-444444444444";

/** Owns a stored capsule and explicitly publishes (or withdraws) it, the only way the public gateways serve it. */
export function publishCapsule(
  root: string,
  capsuleId: string,
  o: {
    org?: string;
    ws?: string;
    state?: "published" | "unpublished";
    ownedBy?: { org: string; ws: string };
  } = {},
): void {
  const dir = join(root, capsuleId);
  const org = o.org ?? ORG_A;
  const ws = o.ws ?? WS_A;
  writeCapsuleOwnership(dir, { orgId: o.ownedBy?.org ?? org, workspaceId: o.ownedBy?.ws ?? ws });
  writeCapsulePublicationState(dir, {
    state: o.state ?? "published",
    orgId: org,
    workspaceId: ws,
    actorId: "test-publisher",
    at: "2026-11-12T00:00:00.000Z",
    acknowledged: [],
    badge: "unverified",
  });
}

/** A root holding one capsule, published by default. `publish: false` leaves it a draft. */
export function makeRoot(o: { publish?: boolean } = {}): { root: string; capsuleId: string } {
  const root = mkdtempSync(join(tmpdir(), "mcp-public-"));
  const m = buildCapsule({
    snapshotDir: SNAPSHOT,
    outDir: join(root, "cap-synthetic-2026-11-10"),
    researchBundleDir: RESEARCH,
  });
  if (o.publish !== false) publishCapsule(root, m.capsuleId);
  return { root, capsuleId: m.capsuleId };
}

export function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(relative(dir, p)).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

export async function connect(
  root: string,
  principal: Principal,
  onCall?: Parameters<typeof createPublicMcpServer>[0]["onCall"],
) {
  const server = createPublicMcpServer({ capsuleRoot: root, principal, ...(onCall ? { onCall } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);
  return { client, close: async () => (await client.close(), await server.close()) };
}

export const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]!.text;
export const jsonOf = (r: unknown): Record<string, unknown> =>
  JSON.parse(textOf(r)) as Record<string, unknown>;
