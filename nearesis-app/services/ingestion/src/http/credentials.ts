import { readFileSync } from "node:fs";
import { IngestionError } from "../errors.ts";

/**
 * The only way adapters obtain credentials. Counts every read (D15e / D16g). Values are held privately and are never
 * exposed through enumeration, JSON serialisation or inspection.
 */
export class CredentialSource {
  readonly #values: Map<string, string>;
  readonly #reads: Map<string, number> = new Map();
  readonly #denied: boolean;

  private constructor(values: Map<string, string>, denied: boolean) {
    this.#values = values;
    this.#denied = denied;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): CredentialSource {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(env)) if (v) m.set(k, v);
    return new CredentialSource(m, false);
  }

  /** Parses a dotenv-style file server-side; values are kept private to this object. */
  static fromDotenv(path: string, fallbackEnv: NodeJS.ProcessEnv = process.env): CredentialSource {
    const m = new Map<string, string>();
    for (const [k, v] of Object.entries(fallbackEnv)) if (v) m.set(k, v);
    try {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const mm = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!mm || line.trimStart().startsWith("#")) continue;
        let v = mm[2] ?? "";
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
          v = v.slice(1, -1);
        if (v && !m.has(mm[1] as string)) m.set(mm[1] as string, v);
      }
    } catch {
      /* no .env: fine */
    }
    return new CredentialSource(m, false);
  }

  static fromMap(values: Record<string, string>): CredentialSource {
    return new CredentialSource(new Map(Object.entries(values)), false);
  }

  /** Replay mode: any access is a violation and is counted. */
  static denyAll(): CredentialSource {
    return new CredentialSource(new Map(), true);
  }

  get(name: string): string | undefined {
    this.#reads.set(name, (this.#reads.get(name) ?? 0) + 1);
    if (this.#denied)
      throw new IngestionError("AUTH_REJECTED", false, {
        reason: "credential access denied in replay mode",
        name,
      });
    return this.#values.get(name);
  }

  has(name: string): boolean {
    return this.#values.has(name) && !this.#denied;
  }

  get readCount(): number {
    let n = 0;
    for (const v of this.#reads.values()) n += v;
    return n;
  }

  report(): { totalReads: number; byName: Record<string, number> } {
    return { totalReads: this.readCount, byName: Object.fromEntries(this.#reads) };
  }

  toJSON(): string {
    return "[CredentialSource]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[CredentialSource]";
  }
}
