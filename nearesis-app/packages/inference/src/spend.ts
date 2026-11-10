import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InferenceError } from "./errors.ts";

/** Hard ceiling (ADR-20261110-003). Raising it requires a code change and new owner approval. */
export const MAX_BUDGET_USD = 5.0;

export function resolveBudgetUsd(env: string | undefined = process.env.NEAR_AI_BUDGET_USD): number {
  if (env === undefined || env.trim() === "") return MAX_BUDGET_USD;
  const n = Number(env);
  if (!Number.isFinite(n) || n < 0) return MAX_BUDGET_USD;
  return Math.min(n, MAX_BUDGET_USD);
}

export function credentialKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

interface Entry {
  id: string;
  at: string;
  model: string;
  requestId: string | null;
  status: "reserved" | "settled" | "released";
  worstCaseUsd: number;
  actualUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}
interface Store {
  credentials: Record<string, { entries: Entry[] }>;
}

export function defaultLedgerPath(): string {
  // packages/inference/src -> nearesis-app
  const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return join(appRoot, ".data", "spend", "near-ai.json");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cumulative per-credential spend ledger. Writes are atomic (tmp + rename) and serialised by a lock directory. */
export class SpendLedger {
  readonly path: string;
  readonly capUsd: number;
  private readonly keyHash: string;

  constructor(opts: { apiKey: string; path?: string; capUsd?: number }) {
    this.path = opts.path ?? defaultLedgerPath();
    this.capUsd = Math.min(opts.capUsd ?? resolveBudgetUsd(), MAX_BUDGET_USD);
    this.keyHash = credentialKey(opts.apiKey);
  }

  private async withLock<T>(fn: () => T): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    for (let i = 0; ; i++) {
      try {
        mkdirSync(lock);
        break;
      } catch {
        if (i > 200) {
          rmSync(lock, { recursive: true, force: true }); // stale after ~10s
        }
        await sleep(50);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }

  private read(): Store {
    if (!existsSync(this.path)) return { credentials: {} };
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Store;
    } catch {
      throw new InferenceError("BUDGET_EXCEEDED", "spend ledger unreadable; refusing to spend (fail closed)");
    }
  }

  private write(s: Store): void {
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.path);
  }

  private static committed(entries: Entry[]): number {
    return entries.reduce(
      (t, e) =>
        t + (e.status === "settled" ? (e.actualUsd ?? 0) : e.status === "reserved" ? e.worstCaseUsd : 0),
      0,
    );
  }

  async spentUsd(): Promise<number> {
    return this.withLock(() => SpendLedger.committed(this.read().credentials[this.keyHash]?.entries ?? []));
  }

  async remainingUsd(): Promise<number> {
    return Math.max(0, this.capUsd - (await this.spentUsd()));
  }

  /** Reserve the worst-case cost. Throws BUDGET_EXCEEDED, before anything is sent, if it does not fit. */
  async reserve(model: string, worstCaseUsd: number): Promise<string> {
    return this.withLock(() => {
      const s = this.read();
      const cred = (s.credentials[this.keyHash] ??= { entries: [] });
      const spent = SpendLedger.committed(cred.entries);
      if (!Number.isFinite(worstCaseUsd) || worstCaseUsd < 0 || spent + worstCaseUsd > this.capUsd + 1e-12) {
        throw new InferenceError(
          "BUDGET_EXCEEDED",
          `worst-case cost USD ${worstCaseUsd.toFixed(6)} exceeds remaining budget USD ${Math.max(0, this.capUsd - spent).toFixed(6)} (cap ${this.capUsd.toFixed(2)})`,
        );
      }
      const id = randomUUID();
      cred.entries.push({
        id,
        at: new Date().toISOString(),
        model,
        requestId: null,
        status: "reserved",
        worstCaseUsd,
        actualUsd: null,
        inputTokens: null,
        outputTokens: null,
      });
      this.write(s);
      return id;
    });
  }

  async settle(
    id: string,
    actual: { usd: number; inputTokens: number; outputTokens: number; requestId: string | null },
  ): Promise<void> {
    await this.withLock(() => {
      const s = this.read();
      const e = s.credentials[this.keyHash]?.entries.find((x) => x.id === id);
      if (!e) return;
      e.status = "settled";
      e.actualUsd = actual.usd;
      e.inputTokens = actual.inputTokens;
      e.outputTokens = actual.outputTokens;
      e.requestId = actual.requestId;
      this.write(s);
    });
  }

  /** The request was rejected before incurring cost (e.g. HTTP 402/4xx, network failure). */
  async release(id: string): Promise<void> {
    await this.withLock(() => {
      const s = this.read();
      const e = s.credentials[this.keyHash]?.entries.find((x) => x.id === id);
      if (!e) return;
      e.status = "released";
      this.write(s);
    });
  }
}
