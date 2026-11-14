import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { KernelError, canWrite, canAdmin, workspaceNotFound, writeAudit, zodDetails } from "@nearesis/kernel";
import type { Kernel, Session, Tx } from "@nearesis/kernel";

/** Shared plumbing of the product route files (hypotheses, claims, workspace admin, run detail, source health, thesis). */
export interface ProductDeps {
  kernel: Kernel;
  authenticate(req: FastifyRequest): Promise<Session>;
}

export const Uuid = z.uuid();

export const ctxOf = (s: Session) => ({ orgId: s.principal.orgId, userId: s.userId });

export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success)
    throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.", {
      details: zodDetails(r.error),
    });
  return r.data;
}

export function parseQuery<S extends z.ZodType>(schema: S, q: unknown): z.infer<S> {
  const r = schema.safeParse(q ?? {});
  if (!r.success)
    throw new KernelError("VALIDATION_FAILED", "INVALID_QUERY", "Invalid query parameters.", {
      details: zodDetails(r.error),
    });
  return r.data;
}

export function requireWrite(s: Session): void {
  if (!canWrite(s.role))
    throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Role cannot make this change.");
}
export function requireAdmin(s: Session): void {
  if (!canAdmin(s.role))
    throw new KernelError("FORBIDDEN", "INSUFFICIENT_ROLE", "Owner or admin role required.");
}

/** Foreign and unknown workspaces are one 404 (RLS hides foreign rows). */
export async function assertWorkspace(tx: Tx, workspaceId: string): Promise<{ id: string; orgId: string }> {
  if (!Uuid.safeParse(workspaceId).success) throw workspaceNotFound();
  const r = await tx.query<{ id: string; org_id: string }>(
    "SELECT id, org_id FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  if (!r.rows[0]) throw workspaceNotFound();
  return { id: r.rows[0].id, orgId: r.rows[0].org_id };
}

export const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();

export function audit(
  tx: Tx,
  s: Session,
  action: string,
  subject: string,
  detail: Record<string, unknown> = {},
  workspaceId?: string,
) {
  return writeAudit(tx, {
    orgId: s.principal.orgId,
    ...(workspaceId ? { workspaceId } : {}),
    actorId: s.userId,
    action,
    subject,
    outcome: "ok",
    reasonCode: null,
    detail,
  });
}

/** A field the backend could not derive is typed unknown with the reason, never a placeholder value. */
export type Known<T> =
  { state: "available"; value: T; source: string } | { state: "unknown"; reason: string };
export const known = <T>(value: T, source: string): Known<T> => ({ state: "available", value, source });
export const unknown = (reason: string): Known<never> => ({ state: "unknown", reason });
