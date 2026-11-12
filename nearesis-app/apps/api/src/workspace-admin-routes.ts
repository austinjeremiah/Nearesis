import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { KernelError, canAdmin, seedCanvasDocument } from "@nearesis/kernel";
import type { Session, Tx } from "@nearesis/kernel";
import {
  Uuid,
  assertWorkspace,
  audit,
  ctxOf,
  iso,
  parseBody,
  parseQuery,
  requireAdmin,
  requireWrite,
} from "./product-common.ts";
import type { ProductDeps } from "./product-common.ts";

const Role = z.enum(["owner", "admin", "analyst", "viewer"]);
const InviteRole = z.enum(["admin", "analyst", "viewer"]);
const Name = z.string().trim().min(1).max(120);
const Layout = z.strictObject({
  layoutMode: z.enum(["grid", "freeform"]),
  viewport: z.strictObject({
    zoom: z.number().min(0.1).max(10),
    x: z.number().min(-100000).max(100000),
    y: z.number().min(-100000).max(100000),
  }),
});
export const SettingsBody = z.strictObject({
  name: Name.optional(),
  description: z.string().trim().max(2000).nullable().optional(),
});
export const TemplateBody = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  name: Name,
  description: z.string().trim().max(2000).optional(),
  objectiveHint: z.string().trim().max(1000).optional(),
  canvasConfig: Layout,
});
export const FromTemplateBody = z.strictObject({
  templateId: z.string().min(1).max(120),
  name: Name,
  description: z.string().trim().max(2000).optional(),
  objective: z.string().trim().min(1).max(4000).optional(),
  networkScope: z.enum(["near-mainnet-read", "near-testnet", "fixture-only"]),
  idempotencyKey: z.string().min(8).max(200),
});
export const MemberPatch = z.strictObject({ role: Role });
export const InviteBody = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(320),
  role: InviteRole,
  workspaceId: Uuid.optional(),
  ttlHours: z.number().int().min(1).max(168).default(72),
});
export const TokenBody = z.strictObject({ token: z.string().min(20).max(400) });
export const PreviewQ = z.object({ token: z.string().min(20).max(400) });

/** Built-in templates. They carry canvas config and a starter-question list only: no panels, no data, no results. */
export const BUILTIN_TEMPLATES = [
  {
    id: "blank",
    name: "Blank workspace",
    description: "Empty grid canvas.",
    objectiveHint: null as string | null,
    starterQuestions: [] as string[],
    canvasConfig: { layoutMode: "grid" as const, viewport: { zoom: 1, x: 0, y: 0 } },
  },
  {
    id: "near-investment-thesis",
    requiredPlugins: ["near-thesis"] as string[],
    name: "NEAR Investment Thesis",
    description:
      "Grid canvas for a preregistered, evidence-first thesis (hypotheses, forecasts, robustness, capsule).",
    objectiveHint:
      "Does NEAR-native activity have durable demand beyond transient cross-chain execution volume?",
    starterQuestions: [
      "Does lagged completed Intents volume improve out-of-sample forecasts of organic NEAR activity?",
      "How concentrated is Intents volume by asset pair and by account cohort?",
    ],
    canvasConfig: { layoutMode: "grid" as const, viewport: { zoom: 1, x: 0, y: 0 } },
  },
  {
    id: "freeform-exploration",
    name: "Freeform exploration",
    description: "Freeform canvas for open-ended exploration before anything is registered.",
    objectiveHint: null,
    starterQuestions: [],
    canvasConfig: { layoutMode: "freeform" as const, viewport: { zoom: 0.8, x: 0, y: 0 } },
  },
];

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export const tokenHashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** Token = inv1.<inviteId>.<expiryEpochSeconds>.<hmac>. The HMAC key lives in the database (invite_secret()). */
export function signInviteToken(secret: string, id: string, expSec: number): string {
  const body = `inv1.${id}.${expSec}`;
  return `${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;
}
export function verifyInviteToken(
  secret: string,
  token: string,
  nowMs: number,
): { id: string; expSec: number } {
  const bad = () => new KernelError("VALIDATION_FAILED", "INVITE_TOKEN_INVALID", "Invalid invite token.");
  const p = token.split(".");
  if (p.length !== 4 || p[0] !== "inv1" || !Uuid.safeParse(p[1]).success || !/^\d{1,12}$/.test(p[2]!))
    throw bad();
  const expect = createHmac("sha256", secret).update(`inv1.${p[1]}.${p[2]}`).digest();
  let got: Buffer;
  try {
    got = Buffer.from(p[3]!, "base64url");
  } catch {
    throw bad();
  }
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) throw bad();
  if (Number(p[2]) * 1000 <= nowMs)
    throw new KernelError("DOMAIN_INVARIANT", "INVITE_EXPIRED", "This invite has expired.", {
      nextAction: "Ask an admin to send a new invite.",
    });
  return { id: p[1]!, expSec: Number(p[2]) };
}

export interface WorkspaceAdminOptions extends ProductDeps {
  now?: () => number;
}

const stateErr = (state: string) =>
  state === "expired"
    ? new KernelError("DOMAIN_INVARIANT", "INVITE_EXPIRED", "This invite has expired.", {
        nextAction: "Ask an admin to send a new invite.",
      })
    : state === "accepted"
      ? new KernelError("DOMAIN_INVARIANT", "INVITE_ALREADY_ACCEPTED", "This invite was already used.")
      : state === "revoked"
        ? new KernelError("DOMAIN_INVARIANT", "INVITE_REVOKED", "This invite was revoked.")
        : new KernelError("NOT_FOUND", "INVITE_NOT_FOUND", "No such invite.");

/**
 * Workspace profile, templates, pinning, collaborators, org members and invites (frontend audit s4 item 9).
 * Membership is org-level in this model, so collaborators of a workspace are the members of its org; `scope: "org"` says so.
 *   GET   /v1/workspaces/:id/settings            PATCH same {name?, description?}
 *   PUT|DELETE /v1/workspaces/:id/pin            POST /v1/workspaces/:id/archive|unarchive (owner/admin)
 *   GET   /v1/workspaces/:id/collaborators
 *   GET   /v1/workspace-templates                POST same (owner/admin, org template)
 *   POST  /v1/workspaces/from-template           create + seed canvas CONFIG
 *   GET   /v1/me/pins
 *   GET   /v1/org, /v1/org/members               PATCH|DELETE /v1/org/members/:userId
 *   POST|GET /v1/org/invites                     DELETE /v1/org/invites/:inviteId
 *   GET   /v1/invites/preview?token=   (no session; token-gated)      POST /v1/invites/accept {token} (session of an existing identity)
 */
export const workspaceAdminRoutes: FastifyPluginAsync<WorkspaceAdminOptions> = async (
  app,
  { kernel, authenticate, now },
) => {
  const clock = now ?? Date.now;
  type P = { Params: { id: string } };

  async function settingsView(tx: Tx, s: Session, id: string) {
    const w = (
      await tx.query<{
        id: string;
        org_id: string;
        objective: string;
        network_scope: string;
        name: string | null;
        description: string | null;
        template_id: string | null;
        archived_at: Date | null;
        created_at: Date;
        created_by: string;
      }>(
        "SELECT id, org_id, objective, network_scope, name, description, template_id, archived_at, created_at, created_by FROM workspaces WHERE id = $1",
        [id],
      )
    ).rows[0];
    if (!w) throw new KernelError("NOT_FOUND", "NOT_FOUND", "Not found.");
    const pin = (
      await tx.query("SELECT 1 FROM workspace_pins WHERE workspace_id = $1 AND user_id = $2", [id, s.userId])
    ).rows[0];
    const members = (
      await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM memberships WHERE org_id = $1", [
        w.org_id,
      ])
    ).rows[0]!;
    const tpl = w.template_id
      ? (BUILTIN_TEMPLATES.find((t) => t.id === w.template_id)?.name ?? w.template_id)
      : null;
    return {
      workspaceId: w.id,
      name: w.name,
      displayName: w.name ?? w.objective.slice(0, 80),
      description: w.description,
      objective: w.objective,
      networkScope: w.network_scope,
      template: w.template_id ? { id: w.template_id, name: tpl } : null,
      pinned: !!pin,
      archived: w.archived_at !== null,
      archivedAt: iso(w.archived_at),
      createdAt: iso(w.created_at),
      createdBy: w.created_by,
      collaborators: Number(members.n),
      collaboratorScope: "org" as const,
      myRole: s.role,
    };
  }

  app.get<P>("/v1/workspaces/:id/settings", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) =>
      settingsView(tx, s, (await assertWorkspace(tx, req.params.id)).id),
    );
  });

  app.patch<P>("/v1/workspaces/:id/settings", async (req) => {
    const s = await authenticate(req);
    requireWrite(s);
    const b = parseBody(SettingsBody, req.body);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, req.params.id);
      if (b.name !== undefined)
        await tx.query("UPDATE workspaces SET name = $2 WHERE id = $1", [ws.id, b.name]);
      if (b.description !== undefined)
        await tx.query("UPDATE workspaces SET description = $2 WHERE id = $1", [ws.id, b.description]);
      await audit(
        tx,
        s,
        "workspace.profile_updated",
        `workspace:${ws.id}`,
        { fields: Object.keys(b) },
        ws.id,
      );
      return settingsView(tx, s, ws.id);
    });
  });

  for (const m of ["put", "delete"] as const)
    app[m]<P>("/v1/workspaces/:id/pin", async (req) => {
      const s = await authenticate(req);
      return kernel.db.tx(ctxOf(s), async (tx) => {
        const ws = await assertWorkspace(tx, req.params.id);
        if (m === "put")
          await tx.query(
            "INSERT INTO workspace_pins(org_id, user_id, workspace_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
            [ws.orgId, s.userId, ws.id],
          );
        else
          await tx.query("DELETE FROM workspace_pins WHERE user_id = $1 AND workspace_id = $2", [
            s.userId,
            ws.id,
          ]);
        return { workspaceId: ws.id, pinned: m === "put" };
      });
    });

  app.get("/v1/me/pins", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => ({
      pins: (
        await tx.query<{ workspace_id: string; pinned_at: Date }>(
          "SELECT p.workspace_id, p.pinned_at FROM workspace_pins p JOIN workspaces w ON w.id = p.workspace_id WHERE p.user_id = $1 ORDER BY p.pinned_at DESC",
          [s.userId],
        )
      ).rows.map((r) => ({ workspaceId: r.workspace_id, pinnedAt: iso(r.pinned_at) })),
    }));
  });

  for (const act of ["archive", "unarchive"] as const)
    app.post<P>(`/v1/workspaces/:id/${act}`, async (req) => {
      const s = await authenticate(req);
      requireAdmin(s);
      return kernel.db.tx(ctxOf(s), async (tx) => {
        const ws = await assertWorkspace(tx, req.params.id);
        await tx.query(
          `UPDATE workspaces SET archived_at = ${act === "archive" ? "COALESCE(archived_at, now())" : "NULL"} WHERE id = $1`,
          [ws.id],
        );
        await audit(tx, s, `workspace.${act}d`, `workspace:${ws.id}`, {}, ws.id);
        return settingsView(tx, s, ws.id);
      });
    });

  app.get<P>("/v1/workspaces/:id/collaborators", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const ws = await assertWorkspace(tx, req.params.id);
      const members = (
        await tx.query<{ user_id: string; role: string; display_name: string | null }>(
          "SELECT m.user_id, m.role, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.role, u.display_name",
          [ws.orgId],
        )
      ).rows;
      const invites = canAdmin(s.role)
        ? (
            await tx.query<{ id: string; email: string; role: string; expires_at: Date }>(
              "SELECT id, email, role, expires_at FROM org_invites WHERE org_id = $1 AND (workspace_id = $2 OR workspace_id IS NULL) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC",
              [ws.orgId, ws.id],
            )
          ).rows.map((i) => ({ inviteId: i.id, email: i.email, role: i.role, expiresAt: iso(i.expires_at) }))
        : null;
      return {
        workspaceId: ws.id,
        scope: "org" as const,
        collaborators: members.map((m) => ({
          userId: m.user_id,
          displayName: m.display_name,
          role: m.role,
          you: m.user_id === s.userId,
        })),
        pendingInvites: invites,
      };
    });
  });

  // ------------------------------------------------------------------------------------------------ templates
  app.get("/v1/workspace-templates", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const org = (
        await tx.query<{
          id: string;
          key: string;
          name: string;
          description: string | null;
          objective_hint: string | null;
          canvas_config: unknown;
          created_at: Date;
        }>(
          "SELECT id, key, name, description, objective_hint, canvas_config, created_at FROM workspace_templates ORDER BY created_at",
        )
      ).rows;
      return {
        templates: [
          ...BUILTIN_TEMPLATES.map((t) => ({ ...t, kind: "builtin" as const })),
          ...org.map((t) => ({
            id: t.id,
            key: t.key,
            kind: "org" as const,
            name: t.name,
            description: t.description,
            objectiveHint: t.objective_hint,
            starterQuestions: [] as string[],
            canvasConfig: t.canvas_config,
          })),
        ],
      };
    });
  });

  app.post("/v1/workspace-templates", async (req, reply) => {
    const s = await authenticate(req);
    requireAdmin(s);
    const b = parseBody(TemplateBody, req.body);
    const out = await kernel.db.tx(ctxOf(s), async (tx) => {
      if (BUILTIN_TEMPLATES.some((t) => t.id === b.key))
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "TEMPLATE_KEY_RESERVED",
          "That key belongs to a built-in template.",
        );
      const id = randomUUID();
      const r = await tx.query<{ id: string }>(
        `INSERT INTO workspace_templates(id, org_id, key, name, description, objective_hint, canvas_config, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (org_id, key) DO NOTHING RETURNING id`,
        [
          id,
          s.principal.orgId,
          b.key,
          b.name,
          b.description ?? null,
          b.objectiveHint ?? null,
          JSON.stringify(b.canvasConfig),
          s.userId,
        ],
      );
      if (!r.rows[0])
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "TEMPLATE_KEY_EXISTS",
          "A template with that key already exists.",
        );
      await audit(tx, s, "workspace_template.created", `template:${id}`, { key: b.key });
      return { id, key: b.key, kind: "org" as const, name: b.name, canvasConfig: b.canvasConfig };
    });
    return reply.status(201).send(out);
  });

  app.post("/v1/workspaces/from-template", async (req, reply) => {
    const s = await authenticate(req);
    requireWrite(s);
    const b = parseBody(FromTemplateBody, req.body);
    // Resolve the template under the caller's tenant context (an org template of another org is invisible).
    const tpl = await kernel.db.tx(ctxOf(s), async (tx) => {
      const builtin = BUILTIN_TEMPLATES.find((t) => t.id === b.templateId);
      if (builtin)
        return {
          id: builtin.id,
          objectiveHint: builtin.objectiveHint,
          layout: builtin.canvasConfig,
          requiredPlugins: (builtin as { requiredPlugins?: string[] }).requiredPlugins ?? [],
        };
      const r = Uuid.safeParse(b.templateId).success
        ? (
            await tx.query<{
              id: string;
              objective_hint: string | null;
              canvas_config: z.infer<typeof Layout>;
            }>("SELECT id, objective_hint, canvas_config FROM workspace_templates WHERE id = $1", [
              b.templateId,
            ])
          ).rows[0]
        : undefined;
      if (!r) throw new KernelError("NOT_FOUND", "TEMPLATE_NOT_FOUND", "No such template.");
      return {
        id: r.id,
        objectiveHint: r.objective_hint,
        layout: Layout.parse(r.canvas_config),
        requiredPlugins: [] as string[],
      };
    });
    const objective = b.objective ?? tpl.objectiveHint;
    if (!objective)
      throw new KernelError(
        "VALIDATION_FAILED",
        "OBJECTIVE_REQUIRED",
        "This template has no default objective; provide one.",
        { details: [{ path: "objective", issue: "required" }] },
      );
    const created = await kernel.workspaces.create(
      s,
      { objective, networkScope: b.networkScope, idempotencyKey: b.idempotencyKey },
      { requiredPlugins: tpl.requiredPlugins },
    );
    // Idempotent second step: a retry with the same idempotency key finds the profile and canvas already in place.
    const out = await kernel.db.tx(ctxOf(s), async (tx) => {
      const w = (
        await tx.query<{ org_id: string; active_branch_id: string }>(
          "SELECT org_id, active_branch_id FROM workspaces WHERE id = $1",
          [created.workspaceId],
        )
      ).rows[0]!;
      await tx.query("UPDATE workspaces SET name = $2, description = $3, template_id = $4 WHERE id = $1", [
        created.workspaceId,
        b.name,
        b.description ?? null,
        tpl.id,
      ]);
      const has = (
        await tx.query("SELECT 1 FROM canvas_documents WHERE workspace_id = $1 AND branch_id = $2", [
          created.workspaceId,
          w.active_branch_id,
        ])
      ).rows[0];
      if (!has)
        await seedCanvasDocument(tx, {
          orgId: w.org_id,
          workspaceId: created.workspaceId,
          branchId: w.active_branch_id,
          layout: tpl.layout,
        });
      await audit(
        tx,
        s,
        "workspace.created_from_template",
        `workspace:${created.workspaceId}`,
        { template: tpl.id },
        created.workspaceId,
      );
      return settingsView(tx, s, created.workspaceId);
    });
    return reply.status(201).send({
      ...out,
      version: created.version,
      seeded: { canvasConfig: tpl.layout, panels: 0, data: "none" },
    });
  });

  // ------------------------------------------------------------------------------------------------ org + members
  app.get("/v1/org", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const o = (
        await tx.query<{ id: string; name: string }>("SELECT id, name FROM organizations WHERE id = $1", [
          s.principal.orgId,
        ])
      ).rows[0];
      if (!o) throw new KernelError("NOT_FOUND", "NOT_FOUND", "Not found.");
      const n = (
        await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM memberships WHERE org_id = $1", [o.id])
      ).rows[0]!;
      return { orgId: o.id, name: o.name, memberCount: Number(n.n), myRole: s.role, roles: Role.options };
    });
  });

  app.get("/v1/org/members", async (req) => {
    const s = await authenticate(req);
    return kernel.db.tx(ctxOf(s), async (tx) => ({
      members: (
        await tx.query<{ user_id: string; role: string; display_name: string | null }>(
          "SELECT m.user_id, m.role, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.role, u.display_name, m.user_id",
          [s.principal.orgId],
        )
      ).rows.map((m) => ({
        userId: m.user_id,
        displayName: m.display_name,
        role: m.role,
        you: m.user_id === s.userId,
      })),
    }));
  });

  async function guardOwnerRules(
    tx: Tx,
    s: Session,
    target: { user_id: string; role: string },
    next: string | null,
  ) {
    // Only an owner may touch an owner or grant owner; the org always keeps at least one owner.
    if ((target.role === "owner" || next === "owner") && s.role !== "owner")
      throw new KernelError("FORBIDDEN", "OWNER_REQUIRED", "Only an owner can change owner memberships.");
    if (target.role === "owner" && next !== "owner") {
      const n = (
        await tx.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM memberships WHERE org_id = $1 AND role = 'owner'",
          [s.principal.orgId],
        )
      ).rows[0]!;
      if (Number(n.n) <= 1)
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "LAST_OWNER",
          "The organization must keep at least one owner.",
        );
    }
  }
  const memberOf = async (tx: Tx, s: Session, userId: string) => {
    const r = Uuid.safeParse(userId).success
      ? (
          await tx.query<{ user_id: string; role: string }>(
            "SELECT user_id, role FROM memberships WHERE org_id = $1 AND user_id = $2",
            [s.principal.orgId, userId],
          )
        ).rows[0]
      : undefined;
    if (!r) throw new KernelError("NOT_FOUND", "MEMBER_NOT_FOUND", "No such member.");
    return r;
  };

  app.patch<{ Params: { userId: string } }>("/v1/org/members/:userId", async (req) => {
    const s = await authenticate(req);
    requireAdmin(s);
    const b = parseBody(MemberPatch, req.body);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const t = await memberOf(tx, s, req.params.userId);
      await guardOwnerRules(tx, s, t, b.role);
      await tx.query("UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2", [
        s.principal.orgId,
        t.user_id,
        b.role,
      ]);
      await audit(tx, s, "org.member_role_changed", `user:${t.user_id}`, { from: t.role, to: b.role });
      return { userId: t.user_id, role: b.role };
    });
  });

  app.delete<{ Params: { userId: string } }>("/v1/org/members/:userId", async (req) => {
    const s = await authenticate(req);
    requireAdmin(s);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const t = await memberOf(tx, s, req.params.userId);
      await guardOwnerRules(tx, s, t, null);
      await tx.query("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2", [
        s.principal.orgId,
        t.user_id,
      ]);
      await audit(tx, s, "org.member_removed", `user:${t.user_id}`, { role: t.role });
      return { userId: t.user_id, removed: true };
    });
  });

  // ------------------------------------------------------------------------------------------------ invites
  const secretOf = async (tx: Tx) =>
    (await tx.query<{ s: string }>("SELECT invite_secret() AS s")).rows[0]!.s;

  app.post("/v1/org/invites", async (req, reply) => {
    const s = await authenticate(req);
    requireAdmin(s);
    const b = parseBody(InviteBody, req.body);
    const out = await kernel.db.tx(ctxOf(s), async (tx) => {
      if (b.workspaceId) await assertWorkspace(tx, b.workspaceId);
      const id = randomUUID();
      const expSec = Math.floor(clock() / 1000) + b.ttlHours * 3600;
      const token = signInviteToken(await secretOf(tx), id, expSec);
      await tx.query(
        `INSERT INTO org_invites(id, org_id, workspace_id, email, role, token_hash, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7),$8)`,
        [id, s.principal.orgId, b.workspaceId ?? null, b.email, b.role, tokenHashOf(token), expSec, s.userId],
      );
      await audit(
        tx,
        s,
        "org.invite_created",
        `invite:${id}`,
        { role: b.role, workspaceId: b.workspaceId ?? null, expiresInHours: b.ttlHours },
        b.workspaceId,
      );
      return {
        inviteId: id,
        email: b.email,
        role: b.role,
        workspaceId: b.workspaceId ?? null,
        expiresAt: new Date(expSec * 1000).toISOString(),
        /** Shown once: only its hash is stored. Deliver it to the invitee out of band. */
        token,
        acceptPath: `/accept-invite?token=${token}`,
      };
    });
    return reply.status(201).send(out);
  });

  app.get("/v1/org/invites", async (req) => {
    const s = await authenticate(req);
    requireAdmin(s);
    return kernel.db.tx(ctxOf(s), async (tx) => ({
      invites: (
        await tx.query<{
          id: string;
          email: string;
          role: string;
          workspace_id: string | null;
          expires_at: Date;
          accepted_at: Date | null;
          revoked_at: Date | null;
          created_at: Date;
          state: string;
        }>(
          `SELECT id, email, role, workspace_id, expires_at, accepted_at, revoked_at, created_at,
                  CASE WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= now() THEN 'expired' ELSE 'pending' END AS state
             FROM org_invites WHERE org_id = $1 ORDER BY created_at DESC LIMIT 200`,
          [s.principal.orgId],
        )
      ).rows.map((i) => ({
        inviteId: i.id,
        email: i.email,
        role: i.role,
        workspaceId: i.workspace_id,
        state: i.state,
        expiresAt: iso(i.expires_at),
        acceptedAt: iso(i.accepted_at),
        revokedAt: iso(i.revoked_at),
        createdAt: iso(i.created_at),
      })),
    }));
  });

  app.delete<{ Params: { inviteId: string } }>("/v1/org/invites/:inviteId", async (req) => {
    const s = await authenticate(req);
    requireAdmin(s);
    return kernel.db.tx(ctxOf(s), async (tx) => {
      const r = Uuid.safeParse(req.params.inviteId).success
        ? await tx.query(
            "UPDATE org_invites SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND org_id = $3 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id",
            [req.params.inviteId, s.userId, s.principal.orgId],
          )
        : { rows: [] };
      if (!r.rows[0])
        throw new KernelError("NOT_FOUND", "INVITE_NOT_FOUND", "No pending invite with that id.");
      await audit(tx, s, "org.invite_revoked", `invite:${req.params.inviteId}`);
      return { inviteId: req.params.inviteId, revoked: true };
    });
  });

  /** Token-gated preview for the accept page. Reveals the org name, role and state of THIS invite only. */
  app.get("/v1/invites/preview", async (req) => {
    const q = parseQuery(PreviewQ, req.query);
    const secret = await kernel.db.txGlobal(secretOf);
    verifyInviteToken(secret, q.token, clock());
    const r = await kernel.db.txGlobal(
      async (tx) =>
        (
          await tx.query<{
            invite_id: string;
            org_name: string;
            workspace_id: string | null;
            role: string;
            email: string;
            expires_at: Date;
            state: string;
          }>("SELECT * FROM invite_lookup($1)", [tokenHashOf(q.token)])
        ).rows[0],
    );
    if (!r) throw new KernelError("NOT_FOUND", "INVITE_NOT_FOUND", "No such invite.");
    return {
      inviteId: r.invite_id,
      orgName: r.org_name,
      role: r.role,
      workspaceId: r.workspace_id,
      email: r.email,
      expiresAt: iso(r.expires_at),
      state: r.state,
    };
  });

  app.post("/v1/invites/accept", async (req) => {
    const s = await authenticate(req);
    const b = parseBody(TokenBody, req.body);
    const secret = await kernel.db.txGlobal(secretOf);
    verifyInviteToken(secret, b.token, clock());
    const r = await kernel.db.txGlobal(
      async (tx) =>
        (
          await tx.query<{
            outcome: string;
            org_id: string | null;
            role: string | null;
            workspace_id: string | null;
          }>(
            "SELECT out_outcome AS outcome, out_org_id AS org_id, out_role AS role, out_workspace_id AS workspace_id FROM invite_accept($1, $2)",
            [tokenHashOf(b.token), s.userId],
          )
        ).rows[0],
    );
    if (!r || r.outcome === "not_found")
      throw new KernelError("NOT_FOUND", "INVITE_NOT_FOUND", "No such invite.");
    if (r.outcome !== "accepted_now") throw stateErr(r.outcome);
    return { accepted: true, orgId: r.org_id, role: r.role, workspaceId: r.workspace_id };
  });
};
