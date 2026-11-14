import { z } from "zod";
import { IsoDateTime, Uuid } from "./common.ts";

export const Role = z.enum(["owner", "admin", "analyst", "viewer"]);
export type Role = z.infer<typeof Role>;

export const Organization = z.strictObject({
  id: Uuid,
  name: z.string().min(1).max(200),
  policyVersion: z.number().int().positive(),
});
export type Organization = z.infer<typeof Organization>;

export const User = z.strictObject({
  id: Uuid,
  oidcSubject: z.string().min(1).max(255),
  displayName: z.string().max(200).optional(),
});
export type User = z.infer<typeof User>;

export const Membership = z.strictObject({ orgId: Uuid, userId: Uuid, role: Role });
export type Membership = z.infer<typeof Membership>;

export const NetworkScope = z.enum(["near-mainnet-read", "near-testnet", "fixture-only"]);

export const Workspace = z.strictObject({
  id: Uuid,
  orgId: Uuid,
  objective: z.string().min(1).max(4000),
  networkScope: NetworkScope,
  activeBranchId: Uuid,
  version: z.number().int().nonnegative(),
  createdBy: Uuid,
  createdAt: IsoDateTime,
  archivedAt: IsoDateTime.nullable(),
});
export type Workspace = z.infer<typeof Workspace>;

/** Server-resolved principal. Never accepted from clients/agents (ch.04, ch.20). */
export const Principal = z.strictObject({
  kind: z.enum(["human", "agent", "service"]),
  actorId: Uuid,
  orgId: Uuid,
  parentRunId: Uuid.optional(),
});
export type Principal = z.infer<typeof Principal>;
