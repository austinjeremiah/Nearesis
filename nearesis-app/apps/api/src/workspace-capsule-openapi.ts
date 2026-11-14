import { z } from "zod";
import type { RouteSpec } from "@nearesis/contracts";

const Body = z.strictObject({
  runId: z.uuid().describe("A COMPLETE run of this workspace with a ready interpretation"),
});

/**
 * Capsule from a workspace run (apps/api/src/workspace-capsule-routes.ts; series rule in packages/capsule/src/workspace-run.ts).
 * Spread into ROUTES by openapi-routes.ts.
 */
export const WORKSPACE_CAPSULE_ROUTES: RouteSpec[] = [
  {
    method: "post",
    path: "/v1/workspaces/:id/capsules",
    tag: "publication",
    summary: "Build a verifiable capsule from a COMPLETE workspace run (editor or above)",
    description:
      "Builds a real research capsule with the capsule builder from the run's panel result tables exactly as `GET /v1/workspaces/:id/panels/:hash/data` returns them (each file hashed in the snapshot, with source ids, metric versions, window and coverage). The verifier input is two aligned daily series chosen by a fixed rule: the pair of daily numeric panel columns (panel order, then column order) with the longest run of strictly consecutive shared days that have a value in both (at most the latest 4096 days; pairs with identical values are skipped), scaled exactly to integers (`unit` states the scale, for example `usd x10^6`). Metrics: `lag_pearson:7` when there are at least 9 days, `pearson`, `summary`. The capsule notes restate only the run's grounded findings whose numbers tie to cited result cells. The capsule id is deterministic from workspace and run, so a repeat returns the same capsule (200 instead of 201). `verification.wasm` is `crosschecked` only when a local wasmtime re-ran the pinned WASM, else `skipped_wasmtime_unavailable`. Errors: 404 RUN_NOT_IN_WORKSPACE, 403 INSUFFICIENT_ROLE, 422 RUN_NOT_COMPLETE, INTERPRETATION_NOT_READY, RUN_NOT_CAPSULABLE (fewer than two daily series, fewer than two shared consecutive days, or a scaled value above 1e15; the reason says which), 503 PANEL_DATA_UNAVAILABLE.",
    auth: "bearer",
    role: "writer",
    body: Body,
    headers: [
      { name: "Idempotency-Key", description: "Optional; the capsule id is already idempotent per run." },
    ],
    responses: {
      "201": {
        description:
          "{ capsuleId, capsuleHash, label, title, runId, created, verifier: { x: {name, unit, points}, y: {name, unit, points}, window: {from, to}, metrics }, verification: { local, wasm, checks, notes }, selection: { rule } }",
        untyped: true,
      },
      "200": { description: "The existing capsule of this run (same body, created: false)", untyped: true },
    },
  },
  {
    method: "get",
    path: "/v1/workspaces/:id/capsules",
    tag: "publication",
    summary: "The workspace's capsules with proof and publication status",
    auth: "bearer",
    responses: {
      "200": {
        description:
          "{ workspaceId, capsules: [{ capsuleId, capsuleHash, label, title, runId, createdAt, verifier, proofs: Proof[], publication: { state: none|published|unpublished, public, at, badge, versions: [{version, manifestHash, capsuleHash, signedAt, anchor}] } }] }",
        untyped: true,
      },
    },
  },
];
