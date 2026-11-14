import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { computeHash, Registry } from "@nearesis/analytics";
import type { IntegrityGuard } from "@nearesis/kernel";

export type RegistryCheck =
  { ok: true; registry: Registry } | { ok: false; expected: string; actual: string; ref: string };

/**
 * Reads a semantic-model registry file and re-hashes its content against the `contentHash` it carries. A file that no
 * longer parses is also a failure (its expected hash is unknown, so `expected` names the missing structure). Pure and
 * synchronous: callers decide how to quarantine.
 */
export function checkRegistryFile(file: string): RegistryCheck {
  const bytes = readFileSync(file);
  const ref = basename(file);
  try {
    const r = Registry.parse(JSON.parse(bytes.toString("utf8")));
    const actual = computeHash(r);
    return actual === r.contentHash
      ? { ok: true, registry: r }
      : { ok: false, expected: r.contentHash, actual, ref };
  } catch {
    return {
      ok: false,
      expected: "parseable-registry",
      actual: createHash("sha256").update(bytes).digest("hex"),
      ref,
    };
  }
}

/** Verified read: a corrupted registry is quarantined (record plus audit event) and `integrity_error` is thrown. */
export async function loadVerifiedRegistry(guard: IntegrityGuard, file: string): Promise<Registry> {
  const scope = { orgId: null, userId: null };
  const ref = basename(file);
  await guard.assertNotQuarantined(scope, "semantic_model", ref);
  const c = checkRegistryFile(file);
  if (!c.ok) return guard.violation(scope, "semantic_model", c.ref, c.expected, c.actual);
  return c.registry;
}
