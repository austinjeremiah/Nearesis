import { sha256Hex } from "./canonical.ts";

/**
 * Capability-lease brokerage for agent tasks (FND-20261110-030). Every agent principal that invokes a tool holds a
 * kernel lease: the director task holds the run's workspace grant, every child task holds a lease DERIVED from its
 * parent (never wider, K10), and plan validation runs as a semantic_analyst principal with its own child lease.
 * No `service` principal ever invokes a tool.
 */
export interface LeaseRequest {
  tenantId: string;
  workspaceId: string;
  runId: string;
  /** the agent actor id (task id, or a deterministic validator id) that will hold the leases */
  taskId: string;
  role?: string;
  capabilities: string[];
}
export interface LeaseBroker {
  /** Root (workspace-grant) leases for the run's director task. Idempotent. */
  ensureRoot(a: LeaseRequest): Promise<void>;
  /** Child leases derived from the parent task's leases; capabilities the parent lacks are not granted. Idempotent. */
  ensureChild(a: LeaseRequest & { parentTaskId: string }): Promise<void>;
  /** Revokes every lease the task holds (kernel revocation path). */
  revokeTask(a: { tenantId: string; workspaceId: string; runId: string; taskId: string }): Promise<number>;
  hasGrant(a: {
    tenantId: string;
    workspaceId: string;
    taskId: string;
    capability: string;
  }): Promise<boolean>;
}

/** Deterministic validator actor for the run's plan-validation discover call (a semantic_analyst principal). */
export function validatorActorId(runId: string): string {
  const h = sha256Hex(`plan-validator:${runId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface Requester {
  userId: string;
  role: "owner" | "admin" | "analyst" | "viewer";
}
