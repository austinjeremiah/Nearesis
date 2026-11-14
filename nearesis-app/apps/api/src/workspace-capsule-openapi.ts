import { z } from "zod";
import type { RouteSpec } from "@nearesis/contracts";
import { TestBody } from "./workspace-capsule-routes.ts";

const Body = z.strictObject({
  runId: z.uuid().describe("A COMPLETE run of this workspace with a ready interpretation"),
  test: TestBody.optional().describe(
    "The two daily series to test, named by panel query hash and column (x predictor, y outcome, optional lagDays 0 to 30 meaning x leads y, optional expectedSign and statement). Used instead of the rule; the selection record says who chose it (user unless chosenBy says otherwise). A different test of the same run is a different capsule.",
  ),
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
      "Builds a real research capsule with the capsule builder from the run's panel result tables exactly as `GET /v1/workspaces/:id/panels/:hash/data` returns them (each file hashed in the snapshot, with source ids, metric versions, window and coverage). The verifier input is two aligned daily series. They are the pair named by `test` when given; otherwise the pair the question asks about (the deterministic chooser matches the words of the workspace objective against panel titles and column names, skipping pairs that are part of a whole, duplicates or ratios of each other, with at least 30 shared days); and only when neither applies the original rule (the first pair of daily numeric panel columns, panel order then column order, with the longest run of strictly consecutive shared days that have a value in both, at most the latest 4096 days, identical pairs skipped). The selection record (`run-panels.json#/selection`) holds `chosenBy`, `namedForQuestion` and the test plan; a capsule chosen by the original rule records neither. Values are scaled exactly to integers (`unit` states the scale, for example `usd_x1e6`, an id the pinned WASM verifier accepts); a series that needs more than six decimal places AND does not fit exactly (above 1e15 after scaling) is rounded half-even to six decimals first, and the rounding (decimals kept, largest absolute difference) is recorded per series in the selection record. Capsules built before these rules keep their hashes. Metrics: `lag_pearson:7` when there are at least 9 days, `pearson`, `summary`. The capsule notes restate only the run's grounded findings whose numbers tie to cited result cells. The capsule id is deterministic from workspace and run, so a repeat returns the same capsule (200 instead of 201). `verification.wasm` is `crosschecked` only when a local wasmtime re-ran the pinned WASM, else `skipped_wasmtime_unavailable`. Errors: 404 RUN_NOT_IN_WORKSPACE, 403 INSUFFICIENT_ROLE, 422 RUN_NOT_COMPLETE, INTERPRETATION_NOT_READY, TEST_PAIR_UNAVAILABLE (a named series is not a daily numeric column of the run), RUN_NOT_CAPSULABLE (fewer than two daily series, fewer than two shared consecutive days, or a scaled value above 1e15; the reason says which), 503 PANEL_DATA_UNAVAILABLE.",
    auth: "bearer",
    role: "writer",
    body: Body,
    headers: [
      { name: "Idempotency-Key", description: "Optional; the capsule id is already idempotent per run." },
    ],
    responses: {
      "201": {
        description:
          "{ capsuleId, capsuleHash, label, title, runId, created, verifier: { x: {name, unit, points}, y: {name, unit, points}, window: {from, to}, metrics }, verification: { local, wasm, checks, notes }, selection: { rule, chosenBy: 'planner'|'user'|'rule'|'legacy', namedForQuestion, plan: TestPlan|null, rounding } }",
        untyped: true,
      },
      "200": { description: "The existing capsule of this run (same body, created: false)", untyped: true },
    },
  },
  {
    method: "post",
    path: "/v1/workspaces/:id/test-plan/resolve",
    tag: "publication",
    summary:
      "Find the two series a test plan names among a finished run's real daily series (no model, nothing written)",
    description:
      "Matches xLabel and yLabel against the daily numeric columns of the COMPLETE run's panels by name only: every concept word of a label (stemmed; generic words such as daily, count, total dropped) must be found in the column name or panel title and at least one in the column name; an exact match of the column wins. `resolved` (by: name) when each label matches exactly one series and the two share at least two days; `ambiguous` otherwise, with the candidate series (ids and names only, best matches first, at most 40) so the caller can propose a pair by id; `missing` when the run has no daily series or the pair shares fewer than two days. With `proposal` ({ x, y } as panel hash and column) the pair is validated against the real candidates (both exist, are different series, share days and are not mechanically related) and answered `resolved` (by: model) or `rejected` with the reason. Errors: 404 workspace or RUN_NOT_IN_WORKSPACE, 422 RUN_NOT_COMPLETE or RUN_NOT_CAPSULABLE (no result panels), 503 PANEL_DATA_UNAVAILABLE.",
    auth: "bearer",
    body: z.strictObject({
      runId: z.uuid(),
      xLabel: z.string().min(1).max(60),
      yLabel: z.string().min(1).max(60),
      proposal: z
        .strictObject({
          x: z.strictObject({
            panelHash: z.string().regex(/^[0-9a-f]{64}$/),
            column: z.string().min(1).max(200),
          }),
          y: z.strictObject({
            panelHash: z.string().regex(/^[0-9a-f]{64}$/),
            column: z.string().min(1).max(200),
          }),
        })
        .optional(),
    }),
    responses: {
      "200": {
        description:
          "{ status: 'resolved', by: 'name'|'model', x: Series, y: Series } | { status: 'ambiguous', matches: { x: 'one'|'many'|'none', y }, candidates: Series[] } | { status: 'missing', missing: 'x'|'y', label, reason } | { status: 'rejected', reason }; Series = { panelHash, panelTitle, column, unit, days }",
        untyped: true,
      },
    },
  },
  {
    method: "get",
    path: "/v1/workspaces/:id/runs/:runId/query-notes",
    tag: "publication",
    summary: "Why each panel of a run was drawn, as the run recorded it (empty when it recorded none)",
    description:
      "Reads the composer's plan of the run: a panel has a note only when the plan entry of that panel carries a reason. Nothing is invented. `complete` is true only when every panel has one.",
    auth: "bearer",
    responses: {
      "200": {
        description: "{ runId, panels: number, notes: [{ panelTitle, why }], complete: boolean }",
        untyped: true,
      },
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
