import { randomBytes, randomUUID } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import type { Db } from "./db/pool.ts";
import { KernelError } from "./errors.ts";

/** NEP-413 prefix tag: 2^31 + 413. */
export const NEP413_TAG = 2147484061;
export const NEAR_CHALLENGE_TTL_MS = 5 * 60_000;
export const NEAR_CHALLENGE_MESSAGE = "Sign in to Nearesis";
export const NEAR_CHALLENGE_RECIPIENT = "nearesis";
const RPC_TIMEOUT_MS = 10_000;
const DEFAULT_RPC = "https://rpc.testnet.near.org";

export type NearAuthReason =
  | "CHALLENGE_INVALID"
  | "SIGNATURE_INVALID"
  | "KEY_NOT_FULL_ACCESS"
  | "ACCOUNT_NOT_FOUND"
  | "NETWORK_MISMATCH";

export interface Nep413Payload {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string | undefined;
}

const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const borshString = (s: string): Uint8Array => {
  const b = new TextEncoder().encode(s);
  return concat(u32le(b.length), b);
};

/** sha256( borsh_u32(2^31+413) || borsh(Payload) ): the digest a NEAR wallet signs for `signMessage`. */
export function nep413Hash(p: Nep413Payload): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const option = p.callbackUrl === undefined ? Uint8Array.of(0) : concat(Uint8Array.of(1), borshString(p.callbackUrl));
  return sha256(concat(u32le(NEP413_TAG), borshString(p.message), p.nonce, borshString(p.recipient), option));
}

/** `ed25519:<base58>` -> 32 key bytes, or null. */
export function parseNearPublicKey(key: string): Uint8Array | null {
  if (!key.startsWith("ed25519:")) return null;
  try {
    const raw = base58.decode(key.slice(8));
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

/** Verifies the ed25519 signature (base64) of a NEP-413 payload. Never throws. */
export function verifyNep413Signature(p: Nep413Payload, publicKey: string, signatureB64: string): boolean {
  const pk = parseNearPublicKey(publicKey);
  if (!pk) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureB64)) return false;
  const sig = Buffer.from(signatureB64, "base64");
  if (sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, nep413Hash(p), pk);
  } catch {
    return false;
  }
}

const NAMED_ACCOUNT = /^(?=.{2,64}$)[a-z\d]+(?:[-_][a-z\d]+)*(?:\.[a-z\d]+(?:[-_][a-z\d]+)*)*$/;
const IMPLICIT_ACCOUNT = /^[0-9a-f]{64}$/;
export const isWellFormedNearAccountId = (id: string): boolean => NAMED_ACCOUNT.test(id) || IMPLICIT_ACCOUNT.test(id);
export const isTestnetAccountId = (id: string): boolean =>
  IMPLICIT_ACCOUNT.test(id) || (id.endsWith(".testnet") && NAMED_ACCOUNT.test(id));

export interface NearVerifyInput {
  challengeId: string;
  accountId: string;
  publicKey: string;
  signature: string;
}

export interface NearAuthOptions {
  rpcUrl?: string | undefined;
  /** Test seam; default global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface NearChallenge {
  challengeId: string;
  message: string;
  recipient: string;
  nonce: string;
  network: "testnet";
  expiresAt: string;
}

const fail = (reason: NearAuthReason, message: string): never => {
  throw new KernelError("UNAUTHENTICATED", reason, message);
};

/** NEP-413 wallet sign-in against NEAR testnet. Mainnet is not supported. */
export class NearAuthService {
  private readonly rpc: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  constructor(
    private readonly db: Db,
    opts: NearAuthOptions = {},
  ) {
    this.rpc = opts.rpcUrl ?? process.env.NEARESIS_NEAR_RPC ?? DEFAULT_RPC;
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async issueChallenge(): Promise<NearChallenge> {
    const id = randomUUID();
    const nonce = randomBytes(32);
    const expires = new Date(this.now() + NEAR_CHALLENGE_TTL_MS);
    await this.db.txGlobal((tx) =>
      tx.query(
        "INSERT INTO near_auth_challenges(id, nonce, message, recipient, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, nonce, NEAR_CHALLENGE_MESSAGE, NEAR_CHALLENGE_RECIPIENT, new Date(this.now()), expires],
      ),
    );
    return {
      challengeId: id,
      message: NEAR_CHALLENGE_MESSAGE,
      recipient: NEAR_CHALLENGE_RECIPIENT,
      nonce: nonce.toString("base64"),
      network: "testnet",
      expiresAt: expires.toISOString(),
    };
  }

  /** Runs checks 1-4 of the contract. Consumes the challenge first, so any later failure still burns it. */
  async verify(input: NearVerifyInput): Promise<{ accountId: string; publicKey: string }> {
    const nowD = new Date(this.now());
    const ch = await this.db.txGlobal(async (tx) =>
      (
        await tx.query<{ nonce: Buffer; message: string; recipient: string }>(
          "UPDATE near_auth_challenges SET used_at = $2 WHERE id = $1 AND used_at IS NULL AND expires_at > $2 RETURNING nonce, message, recipient",
          [input.challengeId, nowD],
        )
      ).rows[0],
    );
    if (!ch) return fail("CHALLENGE_INVALID", "The sign-in challenge is unknown, used or expired.");
    const ok = verifyNep413Signature(
      { message: ch.message, nonce: new Uint8Array(ch.nonce), recipient: ch.recipient },
      input.publicKey,
      input.signature,
    );
    if (!ok) return fail("SIGNATURE_INVALID", "The signature does not match the challenge.");
    if (!isTestnetAccountId(input.accountId))
      return fail("NETWORK_MISMATCH", "Only NEAR testnet accounts can sign in.");
    await this.requireFullAccessKey(input.accountId, input.publicKey);
    return { accountId: input.accountId, publicKey: input.publicKey };
  }

  private async requireFullAccessKey(accountId: string, publicKey: string): Promise<void> {
    let body: {
      result?: { permission?: unknown };
      error?: { cause?: { name?: string }; data?: unknown; message?: string };
    };
    try {
      const res = await this.fetchFn(this.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "nearesis",
          method: "query",
          params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
        }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`rpc ${res.status}`);
      body = (await res.json()) as typeof body;
    } catch {
      throw new KernelError("UPSTREAM_DEGRADED", "NEAR_RPC_UNAVAILABLE", "The NEAR RPC is unavailable.", {
        retryable: true,
      });
    }
    if (body.error) {
      const name = body.error.cause?.name;
      const text = typeof body.error.data === "string" ? body.error.data : "";
      if (name === "UNKNOWN_ACCESS_KEY" || /access key/i.test(text))
        return fail("KEY_NOT_FULL_ACCESS", "The key is not an access key of this account.");
      if (name === "UNKNOWN_ACCOUNT" || /does not exist/i.test(text))
        return fail("ACCOUNT_NOT_FOUND", "The account does not exist on testnet.");
      throw new KernelError("UPSTREAM_DEGRADED", "NEAR_RPC_UNAVAILABLE", "The NEAR RPC is unavailable.", {
        retryable: true,
      });
    }
    if (body.result?.permission !== "FullAccess")
      return fail("KEY_NOT_FULL_ACCESS", "The key is not a full-access key of this account.");
  }

  /** Verify, then find or provision the user. Returns what a session needs. */
  async signIn(input: NearVerifyInput): Promise<{ userId: string; orgId: string; accountId: string; created: boolean }> {
    const v = await this.verify(input);
    const row = await this.db.txGlobal(async (tx) =>
      (
        await tx.query<{ user_id: string; org_id: string; created: boolean }>(
          "SELECT user_id, org_id, created FROM near_auth_provision($1)",
          [v.accountId],
        )
      ).rows[0],
    );
    if (!row) throw new KernelError("INTERNAL", "PROVISION_FAILED", "Could not provision the account.");
    await this.audit(row.org_id, row.user_id, "auth.near.signed_in", v.accountId, { created: row.created });
    return { userId: row.user_id, orgId: row.org_id, accountId: v.accountId, created: row.created };
  }

  /** Verify, then link the account to the current user. */
  async link(userId: string, orgId: string, input: NearVerifyInput): Promise<{ accountId: string; userId: string }> {
    const v = await this.verify(input);
    try {
      await this.db.tx({ orgId, userId }, async (tx) => {
        const cur = (
          await tx.query<{ near_account_id: string | null }>("SELECT near_account_id FROM users WHERE id = $1", [
            userId,
          ])
        ).rows[0];
        if (cur?.near_account_id && cur.near_account_id !== v.accountId)
          throw new KernelError("STALE_VERSION", "USER_ALREADY_LINKED", "This user already has a linked NEAR account.");
        if (!cur?.near_account_id)
          await tx.query("UPDATE users SET near_account_id = $2 WHERE id = $1", [userId, v.accountId]);
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new KernelError("STALE_VERSION", "ACCOUNT_ALREADY_LINKED", "This NEAR account belongs to another user.");
      throw e;
    }
    await this.audit(orgId, userId, "auth.near.linked", v.accountId, {});
    return { accountId: v.accountId, userId };
  }

  private async audit(orgId: string, userId: string, action: string, subject: string, detail: object): Promise<void> {
    await this.db.tx({ orgId, userId }, (tx) =>
      tx.query(
        "INSERT INTO audit_events(id, org_id, actor_id, action, subject, outcome, detail) VALUES ($1,$2,$3,$4,$5,'ok',$6)",
        [randomUUID(), orgId, userId, action, subject, JSON.stringify(detail)],
      ),
    );
  }
}
