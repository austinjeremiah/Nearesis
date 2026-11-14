import type { Db } from "./db/pool.ts";
import { KernelError } from "./errors.ts";
import { vetUrl } from "./egress.ts";
import type { EgressDeps } from "./egress.ts";
import { writeAudit } from "./journal.ts";
import type { Session } from "./auth.ts";

/**
 * Third-party MCP endpoint policy (ch.12 "Vulnerability management": third-party MCP endpoints are default denied until
 * reviewed). Registration is refused unless a human with write rights recorded a review of that exact endpoint; an
 * accepted registration carries only the scopes the review approved (the intersection with what was requested), and the
 * endpoint must still pass the SSRF vetting before it is usable. Every decision is audited.
 */
export interface McpReview {
  endpoint: string;
  approvedScopes: string[];
  reviewer: string;
  reference: string;
}
export interface McpRegistration {
  endpoint: string;
  scopes: string[];
  registeredBy: string;
}

export class McpEndpointPolicy {
  private readonly reviews = new Map<string, McpReview>();
  private readonly registered = new Map<string, McpRegistration>();
  constructor(
    private readonly db: Db,
    private readonly deps: EgressDeps = {},
  ) {}

  private key(endpoint: string): string {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.host}${u.pathname}`;
  }

  async recordReview(
    reviewer: Session,
    r: { endpoint: string; approvedScopes: string[]; reference: string },
  ): Promise<McpReview> {
    if (reviewer.principal.kind !== "human" || !["owner", "admin"].includes(reviewer.role))
      throw new KernelError(
        "FORBIDDEN",
        "MCP_REVIEW_FORBIDDEN",
        "Only an owner or admin may record a review.",
      );
    if (!r.reference.trim())
      throw new KernelError("VALIDATION_FAILED", "MCP_REVIEW_REFERENCE", "A review reference is required.");
    const review: McpReview = { ...r, reviewer: reviewer.userId };
    this.reviews.set(this.key(r.endpoint), review);
    await this.db.tx({ orgId: reviewer.principal.orgId, userId: reviewer.userId }, (tx) =>
      writeAudit(tx, {
        orgId: reviewer.principal.orgId,
        actorId: reviewer.userId,
        action: "mcp.review.recorded",
        subject: this.key(r.endpoint),
        outcome: "ok",
        detail: { scopes: r.approvedScopes, reference: r.reference },
      }),
    );
    return review;
  }

  async register(
    actor: Session,
    r: { endpoint: string; requestedScopes: string[] },
  ): Promise<McpRegistration> {
    const audit = (
      outcome: "ok" | "denied",
      reasonCode: string | null,
      detail: Record<string, unknown> = {},
    ) =>
      this.db.tx({ orgId: actor.principal.orgId, userId: actor.userId }, (tx) =>
        writeAudit(tx, {
          orgId: actor.principal.orgId,
          actorId: actor.userId,
          action: outcome === "ok" ? "mcp.registered" : "mcp.registration.denied",
          subject: r.endpoint.slice(0, 200),
          outcome,
          reasonCode,
          detail,
        }),
      );
    let key: string;
    try {
      key = this.key(r.endpoint);
    } catch {
      await audit("denied", "MCP_INVALID_URL");
      throw new KernelError("VALIDATION_FAILED", "MCP_INVALID_URL", "Endpoint is not a valid URL.");
    }
    const review = this.reviews.get(key);
    if (!review) {
      await audit("denied", "MCP_NOT_REVIEWED");
      throw new KernelError(
        "FORBIDDEN",
        "MCP_NOT_REVIEWED",
        "Third-party MCP endpoints are denied until reviewed.",
      );
    }
    const host = new URL(r.endpoint);
    try {
      await vetUrl(
        r.endpoint,
        { allowHosts: [`${host.hostname}${host.port ? `:${host.port}` : ""}`] },
        this.deps,
      );
    } catch (e) {
      const code = (e as { reasonCode?: string }).reasonCode ?? "EGRESS_DENIED";
      await audit("denied", code);
      throw new KernelError("FORBIDDEN", code, "Endpoint failed egress vetting.");
    }
    const scopes = r.requestedScopes.filter((s) => review.approvedScopes.includes(s));
    const reg: McpRegistration = { endpoint: key, scopes, registeredBy: actor.userId };
    this.registered.set(key, reg);
    await audit("ok", null, { scopes, narrowedFrom: r.requestedScopes });
    return reg;
  }

  isRegistered(endpoint: string): boolean {
    return this.registered.has(this.key(endpoint));
  }
}
