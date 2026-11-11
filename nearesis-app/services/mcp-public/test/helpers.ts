import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildCapsule } from "@nearesis/capsule";
import { createPublicMcpServer } from "../src/index.ts";
import type { Principal } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, "..", "..", "..");
export const SNAPSHOT = join(APP, "packages", "capsule", "fixtures", "snapshot-synthetic");
export const RESEARCH = join(APP, "packages", "test-fixtures", "research", "signal-bundle");

export function makeRoot(): { root: string; capsuleId: string } {
  const root = mkdtempSync(join(tmpdir(), "mcp-public-"));
  const m = buildCapsule({
    snapshotDir: SNAPSHOT,
    outDir: join(root, "cap-synthetic-2026-11-10"),
    researchBundleDir: RESEARCH,
  });
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
