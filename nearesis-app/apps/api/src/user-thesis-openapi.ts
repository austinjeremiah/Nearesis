import { z } from "zod";
import type { RouteSpec } from "@nearesis/contracts";
import { TestBody } from "./workspace-capsule-routes.ts";

const REFERENCE = "reference-near-intents";
const SUMMARY =
  "{ id, title, hypothesis, verdict: { status, headline }, kind: 'reference'|'workspace'|'imported', workspaceId|null, version, status: 'draft'|'published'|'unpublished', shareSlug|null, sourceThesisId|null, updatedAt, receipts: { verified, reproduced, drift, different, incomplete, mismatch } }";

/**
 * User theses (apps/api/src/user-thesis-routes.ts; document in apps/api/src/user-thesis/generate.ts). Spread into ROUTES by
 * openapi-routes.ts. Nothing here is charged and nothing calls a model or a chain.
 */
export const USER_THESIS_ROUTES: RouteSpec[] = [
  {
    method: "post",
    path: "/v1/workspaces/:id/theses",
    tag: "thesis",
    summary: "Build a thesis from a COMPLETE workspace run (editor or above; deterministic, no model call)",
    description:
      "Builds a `nearesis.thesis.v1` document with the fixed `relationship-v2` rule from the run's capsule (built first when absent, idempotent) and the workspace's hypothesis, monitors, markers and OutLayer proof state. The pair that is tested is, in this order: `test` of the request (chosenBy user), the test plan stored with the workspace's hypothesis, the question-matching chooser (for a run whose capsule was built before tests were named), and only then the original longest-overlap rule, which the document labels \"pair chosen by rule, not named for the question\". The claim under test is the plan's sentence (`doc.hypothesis`); the older descriptive hypothesis is `doc.context.draftHypothesis`. Verdicts: SUPPORTED, MIXED, NOT_SUPPORTED, INSUFFICIENT_DATA and INVALID_TEST (the two series are mechanically related: part of a whole, duplicates, or the outcome is a ratio whose numerator is the predictor; heuristic detection). `doc.test` carries plan, pairSelection, level, change, spearman, interval {lo, hi, loPpm, hiPpm, method, blockDays, resamples, seed}, relatedness, rounding, attestation (which numbers the verifier attests and which the API recomputes) and partOfWhole; every section has `references` (the exact pointers behind its [n] markers). `runId` defaults to the newest COMPLETE run with a ready interpretation. A repeat with unchanged inputs returns the same thesis and version. Errors: 404 workspace, 403 INSUFFICIENT_ROLE, 422 NO_COMPLETE_RUN / RUN_NOT_COMPLETE / INTERPRETATION_NOT_READY / RUN_NOT_CAPSULABLE / TEST_PAIR_UNAVAILABLE, 500 THESIS_BUILD_FAILED (a number without a pointer, or causal / bullish / significance wording).",
    auth: "bearer",
    role: "writer",
    body: z.strictObject({
      runId: z.uuid().optional(),
      test: TestBody.optional(),
      planLock: z
        .strictObject({ taskId: z.uuid() })
        .optional()
        .describe(
          "An agent task of the caller whose locked test plan this thesis tests (needs test and runId). The server reads the plan from the task and checks it: locked, hash of its canonical fields, same workspace, the task started this run, and test.statement is the plan's sentence; then doc.test.plan carries lockedAt, sha256, editedByUser and wouldCountAsWrong of the plan and Methods says it was locked before the investigation ran. 422 TEST_PLAN_LOCK_INVALID otherwise. Without planLock the plan is chosen at build and lockedAt is null.",
        ),
    }),
    headers: [
      {
        name: "Idempotency-Key",
        description: "Optional; the version is already idempotent per (workspace, run).",
      },
    ],
    responses: {
      "201": {
        description: "{ thesisId, version, status: 'draft'|'published', verdict: { status, headline } }",
        untyped: true,
      },
    },
  },
  {
    method: "get",
    path: "/v1/theses",
    tag: "thesis",
    summary: "The caller's theses, the ones they imported, and the pinned reference thesis (first)",
    auth: "bearer",
    responses: { "200": { description: `{ items: [${SUMMARY}] }`, untyped: true } },
  },
  {
    method: "post",
    path: "/v1/theses/import",
    tag: "thesis",
    summary: "Add a published thesis (by its share slug) to the caller's list; idempotent",
    auth: "bearer",
    body: z.strictObject({ slug: z.string() }),
    responses: {
      "200": {
        description: `{ thesisId, created, thesis: ${SUMMARY} }; 404 THESIS_NOT_FOUND for an unknown or unpublished slug`,
        untyped: true,
      },
    },
  },
  {
    method: "get",
    path: "/v1/theses/:id",
    tag: "thesis",
    summary: `A thesis with its document and receipts (owner organisation, importers; \`${REFERENCE}\` for everyone)`,
    description: `The document is \`nearesis.thesis.v1\`. For a reader outside the owning organisation \`doc.origin.workspaceId\`, \`runId\` and \`hypothesisId\` are null. \`doc.origin.question\` is the run's question. 404 THESIS_NOT_FOUND for another organisation's unimported thesis.`,
    auth: "bearer",
    responses: {
      "200": {
        description: `{ thesis: ${SUMMARY}, doc: nearesis.thesis.v1, receipts: [{ id, kind, outcome, userDisplay, createdAt, detail }] }`,
        untyped: true,
      },
    },
  },
  {
    method: "post",
    path: "/v1/theses/:id/publish",
    tag: "thesis",
    summary: "Publish a thesis for a public link (editor or above in the owning organisation)",
    description:
      "Requires the capsule to be available and an Evidence against section (the explicit untested note counts). The slug is kept across unpublish and republish. 422 THESIS_NOT_PUBLISHABLE.",
    auth: "bearer",
    role: "writer",
    responses: {
      "200": { description: "{ shareSlug, publicUrlPath: '/t/<slug>', status: 'published' }", untyped: true },
    },
  },
  {
    method: "post",
    path: "/v1/theses/:id/unpublish",
    tag: "thesis",
    summary: "Withdraw the public link of a thesis (editor or above)",
    auth: "bearer",
    role: "writer",
    responses: { "200": { description: "{ shareSlug, status: 'unpublished'|'draft' }", untyped: true } },
  },
  {
    method: "get",
    path: "/v1/public/theses/:slug",
    tag: "thesis",
    summary: "A published thesis, no sign-in (rate limited per IP)",
    description:
      "Never exposes organisation, workspace, run or user ids; the owner appears as a display name only. Unknown, unpublished and withdrawn slugs answer one identical 404.",
    auth: "none",
    responses: {
      "200": {
        description:
          "{ thesis: { id, title, hypothesis, verdict, kind, version, status, shareSlug, ownerDisplay, updatedAt }, doc, receipts: { verified, reproduced, drift, different, incomplete, mismatch } }",
        untyped: true,
      },
    },
  },
  {
    method: "get",
    path: "/v1/public/theses/:slug/files/*",
    tag: "thesis",
    summary:
      "THESIS.md, thesis.json, data/daily_series.csv, data/verifier-input.json or data/results.json of a published thesis (no sign-in)",
    auth: "none",
    responses: { "200": { description: "File bytes with x-thesis-sha256", untyped: true } },
  },
  {
    method: "post",
    path: "/v1/theses/:id/verify",
    tag: "thesis",
    summary: "Verify a thesis (signed in; free; no model or chain call); records a receipt",
    description:
      "Checks: document hash, schema, capsule identity and re-verification (verifyCapsule), every chart's data and file hash against the capsule snapshot, the test numbers recomputed from the frozen series, the OutLayer proof state when present. For the reference thesis: the files of thesis/build/HASHES.json against their recorded hashes.",
    auth: "bearer",
    responses: {
      "200": {
        description: "{ outcome: 'verified'|'mismatch', checks: [{ name, ok, detail }], receiptId }",
        untyped: true,
      },
    },
  },
  {
    method: "post",
    path: "/v1/theses/:id/rerun",
    tag: "thesis",
    summary:
      "Reproduce a thesis by re-executing its stored queries (deterministic; no model call, no chain call, nothing charged)",
    description:
      "Re-executes, as the caller and read-only, every stored panel query of the thesis's capsule snapshot with the SAME query definition and the SAME absolute window (never relative to today), through the same data service that produced them, under the caller's own organisation and a scope that names no workspace (the caller needs no access to the original workspace; a workspace-private source is reported as unavailable). The two verifier series are rebuilt from the SAME panels and columns the original used (no re-picking), `relationship-v1` or `relationship-v2` (as the thesis states; v2 also recomputes the change, rank and interval numbers and the mechanical-relation check) and every chart's first, last and peak are recomputed and compared with the stored document. `match`: every compared value equal. `drift`: same verdict, n and window but some value differs. `different`: verdict, n or window differ. `incomplete`: at least one query could not be re-executed (listed in `unavailable` with the reason); the rows cover only what could be compared and nothing is guessed. Records a `reproduce` receipt on the thesis. 404 THESIS_NOT_FOUND when the thesis is not visible; 422 REFERENCE_THESIS_OFFLINE (details.commands) for the reference thesis; 503 THESIS_SNAPSHOT_UNAVAILABLE when this server does not hold the capsule.",
    auth: "bearer",
    responses: {
      "200": {
        description:
          "{ outcome: 'match'|'drift'|'different'|'incomplete', rows: [{ what, original, reproduced, delta }], reran: { charts, queries, at, window: { from, to } }, unavailable: [{ chart, reason }], receiptId }",
        untyped: true,
      },
    },
  },
  {
    method: "post",
    path: "/v1/theses/:id/compare",
    tag: "thesis",
    summary:
      "Compare this (reproduced) thesis with the original it reproduces; records a reproduce receipt on the original",
    auth: "bearer",
    body: z.strictObject({
      against: z.string().describe("The ORIGINAL thesis id (own, imported or the reference)"),
    }),
    responses: {
      "200": {
        description:
          "{ outcome: 'match'|'drift'|'different', rows: [{ what, original, reproduced, delta }], receiptId }",
        untyped: true,
      },
    },
  },
  {
    method: "get",
    path: "/v1/theses/:id/receipts",
    tag: "thesis",
    summary: "Verification and reproduction receipts of a thesis",
    auth: "bearer",
    responses: {
      "200": {
        description:
          "{ receipts: [{ id, kind, outcome, userDisplay, createdAt, detail }], counts: { verified, reproduced, drift, different, incomplete, mismatch } }",
        untyped: true,
      },
    },
  },
  {
    method: "get",
    path: "/v1/theses/:id/files/*",
    tag: "thesis",
    summary:
      "THESIS.md (rendered from the document), thesis.json or a data file of a thesis the caller can open",
    auth: "bearer",
    responses: { "200": { description: "File bytes with x-thesis-sha256", untyped: true } },
  },
];
