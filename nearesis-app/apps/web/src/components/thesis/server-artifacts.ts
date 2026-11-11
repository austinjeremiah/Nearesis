/**
 * Server-only loader for the thesis page's research results: R1's `ResearchRunArtifact`, as published inside a research
 * capsule and served by the kernel API (`GET /v1/capsules/:id/research-run`, tenant-scoped, hash-checked against the
 * capsule manifest by the API). The capsule is the one requested, or the latest the caller may see. The run is
 * validated against the contract here before anything is rendered. There is no synthetic fallback.
 */
import { ResearchRunArtifact } from "@nearesis/contracts";
import { upstream } from "../../lib/server/upstream.ts";
import type { ArtifactsResponse } from "./model.ts";

const CAPSULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
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
        : "No research capsule has been published for this workspace, so there are no research results to show.",
    );
  if (!CAPSULE_ID.test(pick.capsuleId)) return unavailable("Capsule id is not valid.");
  const rr = await upstream(`/v1/capsules/${encodeURIComponent(pick.capsuleId)}/research-run`);
  if (!rr.ok) {
    const body = (await rr.json().catch(() => ({}))) as { reasonCode?: string };
    if (body.reasonCode === "RESEARCH_RUN_HASH_MISMATCH")
      return unavailable("Research run file does not match the capsule manifest hash; not shown.");
    if (body.reasonCode === "RESEARCH_RUN_NOT_FOUND")
      return unavailable(`Capsule ${pick.capsuleId} carries no research run.`);
    return unavailable(`Research run request failed (${rr.status}).`);
  }
  const parsed = ResearchRunArtifact.safeParse(await rr.json());
  if (!parsed.success)
    return unavailable(
      `Research run failed contract validation at ${parsed.error.issues[0]?.path.join(".") ?? "?"}.`,
    );
  return {
    status: "available",
    capsuleId: pick.capsuleId,
    runFileSha256: rr.headers.get("x-capsule-sha256"),
    artifact: parsed.data,
  };
}
