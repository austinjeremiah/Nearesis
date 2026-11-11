import { createHash } from "node:crypto";
import type { Session } from "../auth.ts";
import type { Db } from "../db/pool.ts";
import { KernelError } from "../errors.ts";

const MAX_BYTES = 8_000_000;

/**
 * Tenant-scoped, content-addressed raw object store (ch.10 "shared immutable raw data stays content-addressed").
 * Identical bytes are stored once per tenant; branching never copies them, evidence refers to them by hash only.
 */
export class ObjectStore {
  constructor(private readonly db: Db) {}

  private ctx(s: Session) {
    return { orgId: s.principal.orgId, userId: s.userId, actorKind: s.principal.kind };
  }

  async put(session: Session, bytes: Uint8Array): Promise<{ hash: string; sizeBytes: number }> {
    if (bytes.length === 0 || bytes.length > MAX_BYTES)
      throw new KernelError("VALIDATION_FAILED", "OBJECT_SIZE", "Object size out of range.");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await this.db.tx(this.ctx(session), (tx) =>
      tx.query(
        "INSERT INTO raw_objects(org_id, hash, size_bytes, bytes) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [session.principal.orgId, hash, bytes.length, Buffer.from(bytes)],
      ),
    );
    return { hash, sizeBytes: bytes.length };
  }

  async stats(session: Session): Promise<{ count: number; bytes: number; hashes: string[] }> {
    return this.db.tx(this.ctx(session), async (tx) => {
      const r = await tx.query<{ hash: string; size_bytes: number }>(
        "SELECT hash, size_bytes FROM raw_objects WHERE org_id = $1 ORDER BY hash",
        [session.principal.orgId],
      );
      return {
        count: r.rows.length,
        bytes: r.rows.reduce((a, x) => a + x.size_bytes, 0),
        hashes: r.rows.map((x) => x.hash),
      };
    });
  }

  async exists(session: Session, hash: string): Promise<boolean> {
    return this.db.tx(this.ctx(session), async (tx) => {
      const r = await tx.query("SELECT 1 FROM raw_objects WHERE org_id = $1 AND hash = $2", [
        session.principal.orgId,
        hash,
      ]);
      return r.rows.length > 0;
    });
  }
}
