import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { IngestionError } from "../errors.ts";
import { sha256Hex } from "../hash.ts";

/** Content-addressed, write-once object store. Key = lowercase sha256 hex of the bytes. */
export interface ObjectStore {
  /** Stores bytes under their own SHA-256. Same bytes again is a no-op returning the same hash. */
  put(bytes: Uint8Array): Promise<{ hash: string; created: boolean }>;
  /** Stores bytes under an explicit key; throws ARCHIVE_IMMUTABLE if the key exists with different bytes or the key is not the bytes' hash. */
  putAt(key: string, bytes: Uint8Array): Promise<{ hash: string; created: boolean }>;
  get(hash: string): Promise<Uint8Array>;
  has(hash: string): Promise<boolean>;
}

const KEY_RE = /^[0-9a-f]{64}$/;

export class FsObjectStore implements ObjectStore {
  constructor(readonly root: string) {}

  pathFor(hash: string): string {
    if (!KEY_RE.test(hash)) throw new IngestionError("INVALID_INPUT", false, { reason: "bad object key" });
    return join(this.root, hash.slice(0, 2), hash);
  }

  async put(bytes: Uint8Array) {
    return this.putAt(sha256Hex(bytes), bytes);
  }

  async putAt(key: string, bytes: Uint8Array) {
    const path = this.pathFor(key);
    if (sha256Hex(bytes) !== key) {
      // The key is the content address. Bytes that do not hash to it can never be stored there.
      const exists = await this.has(key);
      throw new IngestionError("ARCHIVE_IMMUTABLE", false, {
        reason: exists ? "key exists with different bytes" : "bytes do not hash to the key",
        key,
      });
    }
    await mkdir(dirname(path), { recursive: true });
    // Create-exclusive: write a private temp file, then hard-link it into place (EEXIST if present).
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, bytes, { flag: "wx", mode: 0o444 });
    try {
      await link(tmp, path);
      return { hash: key, created: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const existing = await readFile(path);
      if (sha256Hex(existing) !== key) {
        throw new IngestionError("ARCHIVE_IMMUTABLE", false, {
          reason: "stored bytes do not match key",
          key,
        });
      }
      return { hash: key, created: false };
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  async get(hash: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(hash)));
  }

  async has(hash: string): Promise<boolean> {
    return stat(this.pathFor(hash)).then(
      () => true,
      () => false,
    );
  }
}

export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array) {
    return this.putAt(sha256Hex(bytes), bytes);
  }
  async putAt(key: string, bytes: Uint8Array) {
    if (sha256Hex(bytes) !== key)
      throw new IngestionError("ARCHIVE_IMMUTABLE", false, { reason: "bytes do not hash to the key", key });
    if (this.objects.has(key)) return { hash: key, created: false };
    this.objects.set(key, bytes);
    return { hash: key, created: true };
  }
  async get(hash: string) {
    const b = this.objects.get(hash);
    if (!b) throw new IngestionError("INVALID_INPUT", false, { reason: "missing object", key: hash });
    return b;
  }
  async has(hash: string) {
    return this.objects.has(hash);
  }
}
