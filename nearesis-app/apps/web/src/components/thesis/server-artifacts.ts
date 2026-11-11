/**
 * Server-only loader for the thesis page's research results: R1's `ResearchRunArtifact`, read from a published research
 * capsule. The capsule is chosen from the kernel's own `GET /v1/capsules` listing (session-checked); the run file is
 * the one the capsule manifest lists, verified against the manifest's SHA-256 and validated with the contract.
 * There is no synthetic fallback: without a published capsule the page reports `unavailable`.
 *
 * The kernel API does not serve `research/research_run.json` yet (queue request); this reads the same capsule
 * directory the API reads (NEARESIS_CAPSULE_DIR), by exact manifest path only.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { CapsuleManifest, ResearchRunArtifact } from "@nearesis/contracts";
import { upstream } from "../../lib/server/upstream.ts";
import type { ArtifactsResponse } from "./model.ts";

const CAPSULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function capsuleRoot(): string {
  return resolve(process.env.NEARESIS_CAPSULE_DIR ?? join(process.cwd(), "..", "..", ".data", "capsules"));
}

const unavailable = (reason: string): ArtifactsResponse => ({ status: "unavailable", reason });

export async function loadArtifacts(requested: string | null): Promise<ArtifactsResponse> {
  const r = await upstream("/v1/capsules");
  if (!r.ok) return unavailable(`Capsule listing failed (${r.status}).`);
  const list =
    ((await r.json()) as { capsules?: Array<{ capsuleId: string; createdAt: string }> }).capsules ?? [];
  const pick = requested
    ? list.find((c) => c.capsuleId === requested)
    : [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (!pick)
    return unavailable(
      requested
        ? `Capsule ${requested.slice(0, 60)} not found.`
        : "No research capsule has been published for this deployment, so there are no research results to show.",
    );
  if (!CAPSULE_ID.test(pick.capsuleId)) return unavailable("Capsule id is not valid.");
  const root = capsuleRoot();
  const dir = resolve(root, pick.capsuleId);
  if (!dir.startsWith(root + sep)) return unavailable("Capsule path is not valid.");
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return unavailable("Capsule manifest is not readable from this web server.");
  const manifest = CapsuleManifest.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!manifest.success) return unavailable("Capsule manifest failed validation.");
  const entry = manifest.data.research?.runFile;
  if (!entry) return unavailable(`Capsule ${pick.capsuleId} carries no research run.`);
  const runPath = resolve(dir, entry.path);
  if (!runPath.startsWith(dir + sep) || !existsSync(runPath))
    return unavailable("Research run file is missing.");
  const bytes = readFileSync(runPath);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== entry.sha256)
    return unavailable("Research run file does not match the capsule manifest hash; not shown.");
  const parsed = ResearchRunArtifact.safeParse(JSON.parse(bytes.toString("utf8")));
  if (!parsed.success)
    return unavailable(
      `Research run failed contract validation at ${parsed.error.issues[0]?.path.join(".") ?? "?"}.`,
    );
  return { status: "available", capsuleId: pick.capsuleId, runFileSha256: sha, artifact: parsed.data };
}
