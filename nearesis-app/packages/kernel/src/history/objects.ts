import { createHash } from "node:crypto";
import type { Session } from "../auth.ts";
import type { Db } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { IntegrityGuard } from "../integrity.ts";

const MAX_BYTES = 8_000_000;

/**
 * Tenant-scoped, content-addressed raw object store (ch.10 "shared immutable raw data stays content-addressed").
 * Identical bytes are stored once per tenant; branching never copies them, evidence refers to them by hash only.
 */
export class ObjectStore {
  private readonly integrity: IntegrityGuard;
  constructor(private readonly db: Db) {
    this.integrity = new IntegrityGuard(db);
  }

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

  /**
   * Reads an object by hash. The bytes are re-hashed before they are returned: a stored byte that no longer matches its
   * address is quarantined and the read fails with `integrity_error` (ch.12 "tamper one input byte").
   */
  async get(session: Session, hash: string): Promise<Uint8Array | null> {
    const scope = { orgId: session.principal.orgId, userId: session.userId };
    await this.integrity.assertNotQuarantined(scope, "archive_object", hash);
    const bytes = await this.db.tx(this.ctx(session), async (tx) => {
      const r = await tx.query<{ bytes: Buffer }>(
        "SELECT bytes FROM raw_objects WHERE org_id = $1 AND hash = $2",
        [session.principal.orgId, hash],
      );
      return r.rows[0]?.bytes ?? null;
    });
    if (!bytes) return null;
    const actual = createHash("sha256").update(bytes).digest("hex");
    await this.integrity.verify(scope, "archive_object", hash, hash, actual);
    return new Uint8Array(bytes);
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
