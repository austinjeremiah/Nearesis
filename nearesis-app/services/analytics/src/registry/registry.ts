import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_ROOT } from "../ch.ts";
import { Registry } from "./types.ts";

export const REGISTRY_DIR = join(SERVICE_ROOT, "registry");

/** Canonical JSON: keys sorted recursively, no whitespace. Stable across processes. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Content hash covers everything that defines semantics (metrics, dimensions, evaluators), not the version label or itself. */
export function computeHash(
  r: Pick<Registry, "metrics" | "dimensions" | "evaluators" | "exactScales">,
): string {
  return sha256(
    canonicalJson({
      metrics: r.metrics,
      dimensions: r.dimensions,
      evaluators: r.evaluators,
      exactScales: r.exactScales,
    }),
  );
}

export function latestRegistryFile(dir = REGISTRY_DIR): string {
  const files = readdirSync(dir)
    .filter((f) => /^metrics\.v\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const f = files.at(-1);
  if (!f) throw new Error("no registry file");
  return join(dir, f);
}

/** Loads and validates a registry file; throws when the stored hash does not match the content. */
export function loadRegistry(file = latestRegistryFile()): Registry {
  const r = Registry.parse(JSON.parse(readFileSync(file, "utf8")));
  const h = computeHash(r);
  if (h !== r.contentHash)
    throw new Error(`registry hash mismatch in ${file}: stored ${r.contentHash} computed ${h}`);
  return r;
}

export function sealRegistry(r: Omit<Registry, "contentHash">): Registry {
  return { ...r, contentHash: computeHash(r) };
}

export function stringifyRegistry(r: Registry): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}

export function bumpMinor(v: string): string {
  const [maj, min] = v.split(".").map(Number);
  return `${maj}.${(min ?? 0) + 1}.0`;
}

export function metricById(r: Registry, id: string) {
  return r.metrics.find((m) => m.id === id);
}
