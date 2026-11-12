import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { APP_ROOT, isCapsulePublic, loadCapsuleView, readManifest, verifyCapsule } from "@nearesis/capsule";

/**
 * Public, read-only MCP server over research capsules (ch.15 P09, V08).
 *
 * - Every tool is read-only (`readOnlyHint: true`); there are no write, sign, submit, transfer or query-execution tools.
 * - `public` tools answer any principal, including anonymous and foreign ones. `restricted` tools answer only a
 *   `member` principal and return a structured FORBIDDEN error to everyone else. Fail closed: the default principal
 *   resolver never returns `member`.
 * - Capsule ids and export names are validated, and files are located through the capsule manifest, never by joining
 *   caller-provided paths.
 */
export type PrincipalKind = "anonymous" | "foreign" | "member";
export interface Principal {
  id: string;
  kind: PrincipalKind;
}
export const ANONYMOUS: Principal = { id: "anonymous", kind: "anonymous" };

export interface PublicMcpOptions {
  capsuleRoot?: string;
  principal: Principal;
  /** Called for every tool call (audit). Receives no tool arguments, so nothing sensitive is logged. */
  onCall?: (e: { tool: string; principal: Principal; outcome: "ok" | "denied" | "error" }) => void;
}

const CAPSULE_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);
const EXPORTS = ["THESIS.md", "DATA.md", "LIMITATIONS.md"] as const;
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const PUBLIC_TOOLS = [
  "list_capsules",
  "get_capsule_summary",
  "get_claims",
  "get_result",
  "get_limitations",
  "get_export",
  "verify_capsule_local",
] as const;
export const RESTRICTED_TOOLS = [
  "get_raw_snapshot_rows",
  "get_research_run",
  "get_attestation_evidence",
] as const;

const ok = (v: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const err = (errorCode: string, reasonCode: string, message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ errorCode, reasonCode, message }) }],
});

export function createPublicMcpServer(opts: PublicMcpOptions): McpServer {
  const root = opts.capsuleRoot ?? process.env.NEARESIS_CAPSULE_DIR ?? join(APP_ROOT, ".data", "capsules");
  const server = new McpServer({ name: "nearesis-public", version: "1.0.0" });

  const dirOf = (id: string): string | null => {
    const d = join(root, id);
    // Only an explicitly published capsule is served (publication-state.json, matching ownership). Everything else,
    // drafts, failed, METHOD_NOT_VALIDATED, INSUFFICIENT_DATA and other tenants' unpublished capsules, does not exist here.
    return existsSync(join(d, "manifest.json")) && isCapsulePublic(d) ? d : null;
  };
  const manifestOf = (id: string) => {
    const d = dirOf(id);
    return d ? readManifest(d) : null;
  };
  const notFound = () => err("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");

  type Handler<A> = (args: A) => Promise<CallToolResult> | CallToolResult;
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    visibility: "public" | "restricted",
    shape: S,
    handler: Handler<z.infer<z.ZodObject<S>>>,
  ): void {
    server.registerTool(
      name,
      {
        description: `${description} [${visibility}]`,
        inputSchema: shape,
        annotations: READ_ONLY,
        _meta: { visibility },
      },
      (async (args: unknown) => {
        if (visibility === "restricted" && opts.principal.kind !== "member") {
          opts.onCall?.({ tool: name, principal: opts.principal, outcome: "denied" });
          return err("FORBIDDEN", "RESTRICTED_TOOL", "This tool is restricted to workspace members.");
        }
        try {
          const r = await handler(args as z.infer<z.ZodObject<S>>);
          opts.onCall?.({ tool: name, principal: opts.principal, outcome: r.isError ? "error" : "ok" });
          return r;
        } catch {
          opts.onCall?.({ tool: name, principal: opts.principal, outcome: "error" });
          return err("INTERNAL", "TOOL_FAILED", "The tool failed.");
        }
      }) as never,
    );
  }

  tool("list_capsules", "List published research capsules.", "public", {}, () => {
    const ids = existsSync(root) ? readdirSync(root).sort() : [];
    return ok({
      capsules: ids.flatMap((id) => {
        const m =
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id) && isCapsulePublic(join(root, id))
            ? readManifest(join(root, id))
            : null;
        return m ? [{ capsuleId: m.capsuleId, title: m.title, label: m.label, createdAt: m.createdAt }] : [];
      }),
    });
  });

  tool(
    "get_capsule_summary",
    "Title, label, hashes and verification status. Local verification and OutLayer status are separate fields.",
    "public",
    { capsuleId: CAPSULE_ID },
    async ({ capsuleId }) => {
      const d = dirOf(capsuleId);
      if (!d) return notFound();
      const v = await loadCapsuleView(d, { research: "skip", wasm: "skip" });
      if (!v) return notFound();
      return ok({
        capsuleId: v.capsuleId,
        title: v.title,
        label: v.sourceLabel,
        createdAt: v.createdAt,
        hashes: v.hashes,
        verification: {
          local: v.verification.local,
          outlayer: v.verification.outlayer,
          failures: v.verification.failures,
        },
      });
    },
  );

  tool(
    "get_claims",
    "Claims with their class and the result ids they cite.",
    "public",
    { capsuleId: CAPSULE_ID },
    ({ capsuleId }) => {
      const m = manifestOf(capsuleId);
      return m ? ok({ claims: m.claims }) : notFound();
    },
  );

  tool(
    "get_result",
    "One computed result: value, unit and computation.",
    "public",
    { capsuleId: CAPSULE_ID, resultId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/) },
    ({ capsuleId, resultId }) => {
      const m = manifestOf(capsuleId);
      if (!m) return notFound();
      const r = m.results.find((x) => x.id === resultId);
      return r ? ok(r) : err("NOT_FOUND", "RESULT_NOT_FOUND", "Result not found.");
    },
  );

  tool(
    "get_limitations",
    "The capsule's stated limitations.",
    "public",
    { capsuleId: CAPSULE_ID },
    ({ capsuleId }) => {
      const m = manifestOf(capsuleId);
      return m ? ok({ label: m.label, limitations: m.limitations }) : notFound();
    },
  );

  tool(
    "get_export",
    "A published markdown export (THESIS.md, DATA.md or LIMITATIONS.md).",
    "public",
    { capsuleId: CAPSULE_ID, name: z.enum(EXPORTS) },
    ({ capsuleId, name }) => {
      const m = manifestOf(capsuleId);
      const entry = m?.publication.files.find((f) => f.path === `exports/${name}`);
      if (!m || !entry) return notFound();
      return ok({
        name,
        sha256: entry.sha256,
        text: readFileSync(join(root, capsuleId, entry.path), "utf8"),
      });
    },
  );

  tool(
    "verify_capsule_local",
    "Recompute hashes and metrics locally. The result is labelled local; it is never an OutLayer proof.",
    "public",
    { capsuleId: CAPSULE_ID },
    async ({ capsuleId }) => {
      const d = dirOf(capsuleId);
      if (!d) return notFound();
      const r = await verifyCapsule(d, { research: "skip", wasm: "skip" });
      return ok({
        scope: "local",
        status: r.status,
        reportStatus: r.reportStatus,
        failures: r.failures,
        checks: r.checks,
      });
    },
  );

  tool(
    "get_raw_snapshot_rows",
    "Raw frozen snapshot rows (restricted).",
    "restricted",
    { capsuleId: CAPSULE_ID, limit: z.number().int().min(1).max(200).default(50) },
    ({ capsuleId, limit }) => {
      const m = manifestOf(capsuleId);
      const f = m?.snapshot.files.find((x) => x.path.endsWith(".csv"));
      if (!m || !f) return notFound();
      const lines = readFileSync(join(root, capsuleId, f.path), "utf8")
        .split("\n")
        .filter(Boolean);
      return ok({ path: f.path, sha256: f.sha256, header: lines[0], rows: lines.slice(1, 1 + limit) });
    },
  );

  tool(
    "get_research_run",
    "Full research run artifact (restricted).",
    "restricted",
    { capsuleId: CAPSULE_ID },
    ({ capsuleId }) => {
      const m = manifestOf(capsuleId);
      if (!m?.research) return notFound();
      return ok(JSON.parse(readFileSync(join(root, capsuleId, m.research.runFile.path), "utf8")));
    },
  );

  tool(
    "get_attestation_evidence",
    "Attestation evidence, if any (restricted).",
    "restricted",
    { capsuleId: CAPSULE_ID },
    ({ capsuleId }) => {
      const p = join(root, capsuleId, "attestation", "evidence.json");
      return dirOf(capsuleId) && existsSync(p)
        ? ok(JSON.parse(readFileSync(p, "utf8")))
        : err("NOT_FOUND", "NO_EVIDENCE", "No attestation evidence.");
    },
  );

  return server;
}
