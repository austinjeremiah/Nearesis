/**
 * Shared helpers for the integrated milestone demonstration (`pnpm demo:milestone`).
 * Everything here is evidence plumbing: a step recorder, process management, coordination events, API calls.
 * Secrets are never printed: .env is loaded into process.env only and never echoed.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPO_ROOT = resolve(APP_ROOT, "..");
export const BIBLE = join(REPO_ROOT, "NEARESIS_Build_Bible");
export const RELEASES = join(BIBLE, "reports", "RELEASES");

export type StepStatus = "PASS" | "FAIL" | "BLOCKED";
export type StepMode = "fixture-backed" | "live" | "fixture-backed + live" | "n/a";

export interface StepResult {
  n: number;
  name: string;
  mode: StepMode;
  status: StepStatus;
  startedAt: string;
  ms: number;
  detail: string;
  /** Evidence paths relative to the run directory, plus small inline facts. */
  evidence: string[];
  facts: Record<string, unknown>;
  /** For BLOCKED: owner and the OPEN integration-queue summary. */
  owner?: string;
}

export interface StepOutcome {
  status: StepStatus;
  detail: string;
  evidence?: string[];
  facts?: Record<string, unknown>;
  owner?: string;
}

export function loadEnv(): void {
  const p = join(REPO_ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

/** Resolve a dependency that only a workspace package declares (the root package has no such deps). */
export function requireFrom<T = unknown>(pkgDir: string, name: string): T {
  return createRequire(join(APP_ROOT, pkgDir, "package.json"))(name) as T;
}

export class Recorder {
  readonly results: StepResult[] = [];
  readonly dir: string;
  readonly logs: string;
  readonly shots: string;
  constructor(
    readonly runId: string,
    readonly session = "A11",
  ) {
    this.dir = join(RELEASES, `MILESTONE-${runId}`);
    this.logs = join(this.dir, "logs");
    this.shots = join(this.dir, "screenshots");
    mkdirSync(this.logs, { recursive: true });
    mkdirSync(this.shots, { recursive: true });
  }
  rel(p: string): string {
    return p.startsWith(this.dir) ? p.slice(this.dir.length + 1) : p;
  }
  writeJson(file: string, v: unknown): string {
    const p = join(this.dir, file);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
    return file;
  }
  coord(kind: string, subject: string, detail?: string): void {
    const args = [
      "coord",
      "event",
      "--engine",
      "ENGINE_A",
      "--session",
      this.session,
      "--kind",
      kind,
      "--subject",
      subject,
    ];
    if (detail) args.push("--detail", detail.slice(0, 480));
    spawnSync("pnpm", args, { cwd: APP_ROOT, encoding: "utf8" });
  }
  async step(n: number, name: string, mode: StepMode, fn: () => Promise<StepOutcome>): Promise<StepResult> {
    const t0 = Date.now();
    const startedAt = new Date().toISOString();
    let o: StepOutcome;
    try {
      o = await fn();
    } catch (e) {
      o = {
        status: "FAIL",
        detail: `exception: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600),
      };
    }
    const r: StepResult = {
      n,
      name,
      mode,
      status: o.status,
      startedAt,
      ms: Date.now() - t0,
      detail: o.detail,
      evidence: o.evidence ?? [],
      facts: o.facts ?? {},
      ...(o.owner ? { owner: o.owner } : {}),
    };
    this.results.push(r);
    console.log(
      `[${String(n).padStart(2, "0")}] ${r.status.padEnd(7)} ${mode.padEnd(20)} ${name} (${r.ms} ms) - ${r.detail}`,
    );
    this.coord(
      r.status === "PASS" ? "task.completed" : r.status === "FAIL" ? "test.failed" : "test.blocked",
      `demo.step.${String(n).padStart(2, "0")}`,
      `${r.status} ${mode}: ${name} - ${r.detail}`,
    );
    this.writeJson("steps.json", this.results);
    return r;
  }
  blocked(n: number, name: string, mode: StepMode, owner: string, detail: string): Promise<StepResult> {
    return this.step(n, name, mode, async () => ({ status: "BLOCKED", detail, owner }));
  }
}

export interface Child {
  proc: ChildProcess;
  log: string;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export function spawnLogged(
  rec: Recorder,
  label: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Child {
  const log = join(rec.logs, `${label}.log`);
  const out = createWriteStream(log);
  const proc = spawn(cmd, args, {
    cwd: opts.cwd ?? APP_ROOT,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  proc.stdout?.pipe(out);
  proc.stderr?.pipe(out);
  return {
    proc,
    log,
    stop: (signal = "SIGTERM") =>
      new Promise((res) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return res();
        proc.once("exit", () => res());
        // Own process group: pnpm/tsx/next spawn grandchildren that must die with the demo (no orphaned servers).
        const killGroup = (sig: NodeJS.Signals) => {
          try {
            process.kill(-(proc.pid as number), sig);
          } catch {
            proc.kill(sig);
          }
        };
        killGroup(signal);
        setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) killGroup("SIGKILL");
        }, 8000).unref();
      }),
  };
}

export async function waitFor(
  what: string,
  probe: () => Promise<boolean>,
  timeoutMs: number,
  everyMs = 500,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await probe()) return;
    } catch {
      /* not ready yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Health probe over node:http with a hard timeout (a hung server must never crash or stall the demo). */
export const httpOk = (url: string): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const req = httpGet(url, { timeout: 5000 }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 599) < 500);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}
export async function api<T = unknown>(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: r.status, body: body as T };
}

export const gitHead = (): string =>
  spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();

/** True when nothing can be bound on the port (it is held by another process, responsive or not). */
export const portBusy = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "127.0.0.1");
  });
