/**
 * Server-only artifact loading for the thesis and capsule pages.
 *
 * R1's research artifacts and Engine A's capsule records are not published yet. Until they are, production builds
 * report `unavailable` with the reason. The only other source is a test-injected file: it is read at runtime, only
 * when NEARESIS_TEST_HOOKS=1, and is always relabelled SYNTHETIC. No synthetic content is compiled into the bundle.
 */
import { existsSync, readFileSync } from "node:fs";
import { type ArtifactsResponse, type CapsuleResponse, CapsuleView, ResearchArtifacts } from "./model.ts";

const PENDING_ARTIFACTS =
  "Research-engine artifacts are not published yet (packages/contracts research-artifacts seam is empty). No statistics are shown rather than invented ones.";
const PENDING_CAPSULE =
  "No research capsule record is available from the kernel yet. Nothing here is shown as verified.";

function testFile(env: string): unknown | null {
  if (process.env.NEARESIS_TEST_HOOKS !== "1") return null;
  const p = process.env[env];
  if (!p || !existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as unknown;
}

export function loadArtifacts(): ArtifactsResponse {
  const raw = testFile("NEARESIS_TEST_RESEARCH_ARTIFACTS");
  if (raw === null) return { status: "unavailable", reason: PENDING_ARTIFACTS };
  const parsed = ResearchArtifacts.safeParse(raw);
  if (!parsed.success)
    return {
      status: "unavailable",
      reason: `Artifact record failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  return { status: "available", artifacts: { ...parsed.data, sourceLabel: "SYNTHETIC" } };
}

export function loadCapsule(capsuleId: string | null): CapsuleResponse {
  const raw = testFile("NEARESIS_TEST_CAPSULE");
  if (raw === null) return { status: "unavailable", reason: PENDING_CAPSULE };
  const parsed = CapsuleView.safeParse(raw);
  if (!parsed.success)
    return {
      status: "unavailable",
      reason: `Capsule record failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  if (capsuleId && parsed.data.capsuleId !== capsuleId)
    return { status: "unavailable", reason: `Capsule ${capsuleId} not found.` };
  return { status: "available", capsule: { ...parsed.data, sourceLabel: "SYNTHETIC" } };
}
