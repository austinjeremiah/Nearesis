import { z } from "zod";
import type { HttpMethod, ResponseSpec, RouteSpec } from "@nearesis/contracts";
import {
  AmendBody,
  CreateBody as HypothesisCreate,
  ForkBody,
  FreezeBody,
  LinkBody,
  PatchBody,
} from "./hypothesis-routes.ts";
import {
  FromTemplateBody,
  InviteBody,
  MemberPatch,
  PreviewQ,
  SettingsBody,
  TemplateBody,
  TokenBody,
} from "./workspace-admin-routes.ts";
import { Q as SourceHealthQ } from "./source-health-routes.ts";
import { CreateBody as ThesisCreate, ExportQ, VersionQ } from "./thesis-routes.ts";

const R = (
  method: HttpMethod,
  path: string,
  tag: string,
  summary: string,
  extra: Partial<RouteSpec> & { ok?: ResponseSpec | string; status?: string } = {},
): RouteSpec => {
  const { ok, status, ...rest } = extra;
  const okResp: ResponseSpec =
    typeof ok === "string" || ok === undefined ? { description: ok ?? "OK", untyped: true } : ok;
  return { method, path, tag, summary, auth: "bearer", responses: { [status ?? "200"]: okResp }, ...rest };
};
const W = "/v1/workspaces/:id";

/**
 * Route table of the product-feature routes (apps/api/src/product-routes.ts). Spread into ROUTES by openapi-routes.ts.
 * Fields the backend cannot derive are `{state:"unknown", reason}` objects, never placeholders (see each route's description).
 */
export const PRODUCT_ROUTES: RouteSpec[] = [
  // ---- hypotheses ---------------------------------------------------------------------------------------------------
  R(
    "get",
    `${W}/hypotheses`,
    "hypotheses",
    "Latest version of every hypothesis (verdict and strength come from linked verified research runs, else null)",
    { capability: "hypotheses" },
  ),
  R("post", `${W}/hypotheses`, "hypotheses", "Create a draft hypothesis", {
    role: "writer",
    body: HypothesisCreate,
    status: "201",
    capability: "hypotheses",
  }),
  R("get", `${W}/hypotheses/:hid`, "hypotheses", "A hypothesis with every version and its evidence links", {
    capability: "hypotheses",
  }),
  R(
    "patch",
    `${W}/hypotheses/:hid`,
    "hypotheses",
    "Edit the open draft; a frozen version is refused with 422 HYPOTHESIS_FROZEN",
    { role: "writer", body: PatchBody, capability: "hypotheses" },
  ),
  R(
    "post",
    `${W}/hypotheses/:hid/freeze`,
    "hypotheses",
    "Freeze the draft: sha256 content hash, optional preregistration hash link (verified against held documents or labelled user_supplied). Not a chain commitment",
    { role: "writer", body: FreezeBody, capability: "hypotheses" },
  ),
  R(
    "post",
    `${W}/hypotheses/:hid/amend`,
    "hypotheses",
    "Amend a frozen hypothesis: a new draft version chained to the frozen hash; the frozen row is never edited",
    { role: "writer", body: AmendBody, status: "201", capability: "hypotheses" },
  ),
  R(
    "post",
    `${W}/hypotheses/:hid/fork`,
    "hypotheses",
    "Fork into a new hypothesis line (copy of the latest version, lineage recorded)",
    { role: "writer", body: ForkBody, status: "201", capability: "hypotheses" },
  ),
  R(
    "post",
    `${W}/hypotheses/:hid/links`,
    "hypotheses",
    "Link an evidence-graph claim, a research run (experiment) or a run finding; append-only",
    { role: "writer", body: LinkBody, status: "201", capability: "hypotheses" },
  ),
  R(
    "get",
    `${W}/hypotheses/:hid/verify`,
    "hypotheses",
    "Recompute every frozen version's hash and compare with the stored one",
    { capability: "hypotheses" },
  ),

  // ---- claims and experiments ---------------------------------------------------------------------------------------
  R(
    "get",
    `${W}/claims`,
    "claims",
    "Claims of the evidence graph with verdict, strength and estimate (typed unknown where not derivable)",
    { capability: "claims" },
  ),
  R(
    "get",
    `${W}/claims/:cid`,
    "claims",
    "Claim detail: estimate, counterexamples, falsification criteria, strength, evidence, linked hypotheses and research runs",
    { capability: "claims" },
  ),
  R(
    "get",
    `${W}/experiments`,
    "claims",
    "Research runs as experiments: model comparison losses, method validation, reason codes (read-only over services/research artifacts, re-hashed)",
    { capability: "experiments" },
  ),
  R(
    "get",
    `${W}/experiments/:eid`,
    "claims",
    "One experiment: comparisons with inference records, robustness matrix, falsification, counter-evidence, limitations, provenance",
    { capability: "experiments" },
  ),

  // ---- workspace profile, templates, pins, collaborators ------------------------------------------------------------
  R(
    "get",
    `${W}/settings`,
    "workspace-admin",
    "Workspace profile: name, description, template, pinned (per user), archived, collaborators count",
    { capability: "workspace settings" },
  ),
  R("patch", `${W}/settings`, "workspace-admin", "Edit workspace name and description", {
    role: "writer",
    body: SettingsBody,
    capability: "workspace settings",
  }),
  R("put", `${W}/pin`, "workspace-admin", "Pin the workspace for the calling user", {
    capability: "workspace settings",
  }),
  R("delete", `${W}/pin`, "workspace-admin", "Unpin the workspace for the calling user", {
    capability: "workspace settings",
  }),
  R("post", `${W}/archive`, "workspace-admin", "Archive the workspace (owner/admin)", {
    role: "admin",
    capability: "workspace settings",
  }),
  R("post", `${W}/unarchive`, "workspace-admin", "Restore an archived workspace (owner/admin)", {
    role: "admin",
    capability: "workspace settings",
  }),
  R(
    "get",
    `${W}/collaborators`,
    "workspace-admin",
    "Collaborators (org members; membership is org-level) and, for admins, pending invites",
    { capability: "collaboration" },
  ),
  R("get", "/v1/me/pins", "workspace-admin", "Workspaces the caller pinned", {
    capability: "workspace settings",
  }),
  R(
    "get",
    "/v1/workspace-templates",
    "workspace-admin",
    "Built-in and org workspace templates (canvas config and starter questions; no data)",
    { capability: "workspace templates" },
  ),
  R("post", "/v1/workspace-templates", "workspace-admin", "Create an org workspace template (owner/admin)", {
    role: "admin",
    body: TemplateBody,
    status: "201",
    capability: "workspace templates",
  }),
  R(
    "post",
    "/v1/workspaces/from-template",
    "workspace-admin",
    "Create a workspace from a template: seeds the canvas layout config only (no panels, no data)",
    { role: "writer", body: FromTemplateBody, status: "201", capability: "workspace templates" },
  ),

  // ---- org settings and invites -------------------------------------------------------------------------------------
  R("get", "/v1/org", "org", "The caller's organization: name, member count, caller role, role names", {
    capability: "org settings",
  }),
  R("get", "/v1/org/members", "org", "Members and roles", { capability: "org settings" }),
  R(
    "patch",
    "/v1/org/members/:userId",
    "org",
    "Change a member's role (owner/admin; only an owner touches owners; the last owner stays)",
    { role: "admin", body: MemberPatch, capability: "org settings" },
  ),
  R(
    "delete",
    "/v1/org/members/:userId",
    "org",
    "Remove a member (owner/admin; the last owner cannot be removed)",
    { role: "admin", capability: "org settings" },
  ),
  R(
    "post",
    "/v1/org/invites",
    "org",
    "Create an invite with an HMAC-signed expiring token (returned once; only its hash is stored)",
    { role: "admin", body: InviteBody, status: "201", capability: "org settings" },
  ),
  R("get", "/v1/org/invites", "org", "Invites with state pending|accepted|revoked|expired (owner/admin)", {
    role: "admin",
    capability: "org settings",
  }),
  R("delete", "/v1/org/invites/:inviteId", "org", "Revoke a pending invite (owner/admin)", {
    role: "admin",
    capability: "org settings",
  }),
  R(
    "get",
    "/v1/invites/preview",
    "org",
    "Token-gated preview for the accept-invite page (no session): org name, role, state",
    { auth: "none", query: PreviewQ, capability: "org settings" },
  ),
  R(
    "post",
    "/v1/invites/accept",
    "org",
    "Accept an invite as the signed-in identity; single use; 422 INVITE_EXPIRED / INVITE_ALREADY_ACCEPTED / INVITE_REVOKED",
    { body: TokenBody, capability: "org settings" },
  ),

  // ---- run detail ---------------------------------------------------------------------------------------------------
  R(
    "get",
    "/v1/runs/:id/tasks",
    "runs",
    "Per-task detail: tool calls, charged/reserved cost (usd null = no ledger entry, not zero), rejected calls, times",
    { capability: "run detail" },
  ),

  // ---- source health depth ------------------------------------------------------------------------------------------
  R(
    "get",
    "/v1/sources/:sourceId/health",
    "sources",
    "Source health depth: watermark, hourly (or daily) coverage heatmap, error history, rate-limit history",
    { query: SourceHealthQ, capability: "source health" },
  ),
  R(
    "get",
    "/v1/sources/:sourceId/health/heatmap",
    "sources",
    "Coverage cells by day and hour plus the weekday x hour aggregate",
    { query: SourceHealthQ, capability: "source health" },
  ),
  R(
    "get",
    "/v1/sources/:sourceId/health/errors",
    "sources",
    "Error history grouped by code with first/last seen; quality gaps; not-attempted reasons",
    { query: SourceHealthQ, capability: "source health" },
  ),
  R(
    "get",
    "/v1/sources/:sourceId/health/rate-limits",
    "sources",
    "Recorded rate-limit history; `recorded:false` when ingestion keeps no such signal for the source; byteCeiling with ?workspaceId for BigQuery",
    { query: SourceHealthQ, capability: "source health" },
  ),

  // ---- thesis documents ---------------------------------------------------------------------------------------------
  R(
    "get",
    `${W}/thesis/documents`,
    "thesis",
    "Thesis documents with the latest version, digest and validation status",
    { capability: "thesis builder" },
  ),
  R(
    "post",
    `${W}/thesis/documents`,
    "thesis",
    "Create a thesis document, assembled from supported claims, frozen hypotheses, grounded findings, verified research runs and workspace capsules",
    { role: "writer", body: ThesisCreate, status: "201", capability: "thesis builder" },
  ),
  R(
    "get",
    `${W}/thesis/documents/:did`,
    "thesis",
    "A thesis version: content, markdown, digest, validation, version list",
    { query: VersionQ, capability: "thesis builder" },
  ),
  R(
    "post",
    `${W}/thesis/documents/:did/versions`,
    "thesis",
    "Re-assemble from the current workspace state as a new immutable version",
    { role: "writer", status: "201", capability: "thesis builder" },
  ),
  R(
    "post",
    `${W}/thesis/documents/:did/validate`,
    "thesis",
    "Dry-run validation against current state: is the latest version still current, and the checks",
    { capability: "thesis builder" },
  ),
  R(
    "get",
    `${W}/thesis/documents/:did/export`,
    "thesis",
    "Export a version as markdown or PDF with the content digest in x-content-digest",
    { query: ExportQ, capability: "thesis builder" },
  ),

  // ---- backend gaps found by the frontend workers --------------------------------------------------------------------
  R(
    "post",
    "/v1/notifications/read",
    "frontend",
    "Mark notifications read for the caller only: { ids: uuid[] } or { all: true }; returns marked, alreadyRead, notFound and the caller's unread count",
    { capability: "notifications read state" },
  ),
  R(
    "post",
    `${W}/notifications/read`,
    "monitoring",
    "Per-workspace equivalent of POST /v1/notifications/read (per user)",
    { capability: "notifications read state" },
  ),
  R(
    "get",
    "/v1/metrics/:key",
    "frontend",
    "Detail of a certified registry metric: definition, certification, semantic hash, sources (authored metrics are read through the workspace routes)",
    { capability: "registry metric detail" },
  ),
  R(
    "get",
    "/v1/metrics/:key/versions",
    "frontend",
    "Certified versions of a registry metric with their semantic hashes",
    {
      capability: "registry metric detail",
    },
  ),
  R(
    "post",
    `${W}/monitors/:ruleId/replay`,
    "monitoring",
    "Replay one rule over recorded daily metric values of the live layer for { from, to } (complete UTC days, at most 90); results labelled REPLAY, duplicates answered idempotently",
    { role: "writer", capability: "monitor replay" },
  ),
  ...(
    [
      [
        "daily",
        "Daily gas burnt, tokens burnt (exact yocto strings), gas price, conversion vs receipt-only burn, execution intensity, USD only from timestamped CoinGecko candles (else null with NO_TIMESTAMPED_PRICE)",
      ],
      ["totals", "Window sums of the daily economics"],
      ["receivers", "Gas and fee by executing account, top N (?top), folded remainder labelled"],
      [
        "percentiles",
        "Per-transaction fee percentiles where loaded (loaded:false and TX_DAILY_NOT_LOADED otherwise)",
      ],
      ["coverage", "source_coverage, quality gaps (REFUND_SPLIT_IS_PROXY etc.) and loaded row counts"],
    ] as const
  ).map(([k, summary]) =>
    R(
      "get",
      `/v1/economics/${k}`,
      "economics",
      `${summary}. Execution fees are never labelled protocol revenue`,
      {
        query: z.object({
          from: z.string().optional(),
          to: z.string().optional(),
          days: z.number().int().min(1).max(366).optional(),
          top: z.number().int().min(1).max(200).optional(),
        }),
        capability: "network economics",
      },
    ),
  ),
  R(
    "get",
    "/v1/capsules/:id/anchor",
    "publication",
    "Testnet commitment readback of a published capsule manifest (latest, or ?manifestHash=): verified | mismatch | not_committed | unavailable; read-only",
    { capability: "publication anchor readback" },
  ),
  R(
    "get",
    "/v1/public/publications/:id",
    "public",
    "Unauthenticated, rate-limited public view of an explicitly published capsule: hashes, verification labels, signing-key trust, anchors, documents. Withdrawn: 404 PUBLICATION_WITHDRAWN; no tenant data",
    { auth: "none", capability: "public publications" },
  ),
  R(
    "get",
    "/v1/public/publications/:id/exports/*",
    "public",
    "A published document of a public capsule (manifest-listed files only, hash-checked)",
    { auth: "none", capability: "public publications" },
  ),
];
