/** Mainnet-style approval records: exact scope, single use, expiry, append-only (ch.17 gate step 2, ch.10 approvals). */
import { createHash } from "node:crypto";
import type { Network } from "./chain.ts";

export interface ApprovalScope {
  network: Network;
  contract: string;
  method: string;
  payloadHash: string;
  /** Maximum cost in yocto-style integer units, as a decimal string. */
  maxCost: string;
  /** The exact account that will sign; an approval for one signer never authorises another. */
  signer: string;
  /** Fee ceiling in the same units: the pre-flight fee estimate must not exceed it. */
  feeCeiling: string;
}
export interface ApprovalRecord {
  id: string;
  actionHash: string;
  scope: ApprovalScope;
  issuer: string;
  signers: string[];
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}
export type Denial =
  | "NO_APPROVAL"
  | "UNKNOWN_APPROVAL"
  | "SCOPE_MISMATCH"
  | "EXPIRED"
  | "ALREADY_USED"
  | "ISSUER_NOT_OWNER"
  | "TWO_PERSON_REQUIRED";

/** Hash over every scope field, so changing the network or the cost invalidates the approval. */
export function actionHash(s: ApprovalScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify([s.network, s.contract, s.method, s.payloadHash, s.maxCost, s.signer, s.feeCeiling]),
    )
    .digest("hex");
}

export class ApprovalStore {
  private readonly records: ApprovalRecord[] = [];
  /** Append-only audit trail of issuance, use and denials. */
  readonly audit: Array<{
    at: number;
    kind: "issued" | "used" | "denied";
    id: string | null;
    detail: string;
  }> = [];
  constructor(
    private readonly owners: string[],
    private readonly opts: { twoPerson?: boolean; now: () => number },
  ) {}
  issue(scope: ApprovalScope, issuer: string, signers: string[], ttlMs: number): ApprovalRecord {
    const now = this.opts.now();
    const rec: ApprovalRecord = {
      id: `appr-${this.records.length + 1}`,
      actionHash: actionHash(scope),
      scope,
      issuer,
      signers: [...new Set([issuer, ...signers])],
      createdAt: now,
      expiresAt: now + ttlMs,
      usedAt: null,
    };
    this.records.push(rec);
    this.audit.push({
      at: now,
      kind: "issued",
      id: rec.id,
      detail: `${scope.network}:${scope.contract}:${scope.method}`,
    });
    return rec;
  }
  get(id: string): ApprovalRecord | undefined {
    const r = this.records.find((x) => x.id === id);
    return r && structuredClone(r);
  }
  /** Verify without consuming (dry run). Returns a denial or null. */
  check(id: string | undefined, want: ApprovalScope): Denial | null {
    const d = this.evaluate(id, want);
    if (d) this.audit.push({ at: this.opts.now(), kind: "denied", id: id ?? null, detail: d });
    return d;
  }
  private evaluate(id: string | undefined, want: ApprovalScope): Denial | null {
    if (!id) return "NO_APPROVAL";
    const r = this.records.find((x) => x.id === id);
    if (!r) return "UNKNOWN_APPROVAL";
    if (!this.owners.includes(r.issuer)) return "ISSUER_NOT_OWNER";
    if (r.actionHash !== actionHash(want)) return "SCOPE_MISMATCH";
    if (r.usedAt !== null) return "ALREADY_USED";
    if (this.opts.now() > r.expiresAt) return "EXPIRED";
    if (this.opts.twoPerson && r.signers.filter((s) => this.owners.includes(s)).length < 2)
      return "TWO_PERSON_REQUIRED";
    return null;
  }
  /** Verify and consume atomically. Returns a denial or the consumed record. */
  consume(id: string | undefined, want: ApprovalScope): Denial | ApprovalRecord {
    const d = this.check(id, want);
    if (d) return d;
    const r = this.records.find((x) => x.id === id)!;
    r.usedAt = this.opts.now();
    this.audit.push({ at: r.usedAt, kind: "used", id: r.id, detail: r.actionHash.slice(0, 16) });
    return structuredClone(r);
  }
}
