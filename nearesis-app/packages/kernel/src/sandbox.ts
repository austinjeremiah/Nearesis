import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

/**
 * Read-only execution sandbox for code the platform did not write (quant jobs, third-party plugin workers; ch.08,
 * ch.12). One container per job with: no network at all, read-only root, every capability dropped, no privilege
 * escalation, non-root user, no IPC namespace, bounded processes/memory/CPU/time, a small non-executable scratch tmpfs,
 * only explicitly listed read-only inputs mounted, and only explicitly listed environment variables. Nothing from the
 * host environment or filesystem is visible unless the caller names it, and the caller cannot name sensitive paths.
 */
export class SandboxPolicyError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

export interface SandboxSpec {
  image: string;
  command: string[];
  stdin?: string;
  /** Read-only inputs: `host` is a real file/directory, mounted at absolute `container` path. */
  readOnlyMounts?: Array<{ host: string; container: string }>;
  /** The only environment the job sees. */
  env?: Record<string, string>;
  memoryMb?: number;
  cpus?: number;
  pids?: number;
  tmpfsMb?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Keep stdin open (line protocol with the host) instead of writing `stdin` once and closing. */
  interactive?: boolean;
  /** Docker CLI binary (tests only). */
  docker?: string;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  containerName: string;
}

const FORBIDDEN_HOST = [
  /^\/proc(\/|$)/,
  /^\/sys(\/|$)/,
  /^\/dev(\/|$)/,
  /^\/etc(\/|$)/,
  /^\/(private\/)?var\/run(\/|$)/,
  /docker\.sock$/,
  /(^|\/)\.(ssh|aws|gnupg|kube|docker|config|near-credentials)(\/|$)/,
  /(^|\/)\.env(\.|$)/,
];

function checkMount(host: string, container: string): string {
  if (!isAbsolute(container) || container === "/" || /[:\s,]/.test(container))
    throw new SandboxPolicyError(
      "SANDBOX_MOUNT_TARGET",
      "Container mount path must be absolute, not /, and free of separators.",
    );
  if (/^\/(proc|sys|dev|etc|run|var\/run|tmp)(\/|$)/.test(container))
    throw new SandboxPolicyError("SANDBOX_MOUNT_TARGET", "Container mount path is reserved.");
  if (!existsSync(host)) throw new SandboxPolicyError("SANDBOX_MOUNT_SOURCE", "Mount source does not exist.");
  const real = realpathSync(host);
  if (real === "/" || real === homedir() || FORBIDDEN_HOST.some((re) => re.test(real) || re.test(host)))
    throw new SandboxPolicyError("SANDBOX_MOUNT_SOURCE", "Mount source is a sensitive host path.");
  if (/[:,]/.test(real))
    throw new SandboxPolicyError("SANDBOX_MOUNT_SOURCE", "Mount source contains a separator.");
  return real;
}

/** The exact `docker run` argument list. Pure, so the policy is unit-testable without a container runtime. */
export function sandboxArgs(spec: SandboxSpec, name: string): string[] {
  if (!spec.image || /\s/.test(spec.image))
    throw new SandboxPolicyError("SANDBOX_IMAGE", "Invalid image reference.");
  if (spec.command.length === 0) throw new SandboxPolicyError("SANDBOX_COMMAND", "A command is required.");
  const mem = spec.memoryMb ?? 128;
  const args = [
    "run",
    "--rm",
    "--name",
    name,
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--ipc",
    "none",
    "--init",
    "--pids-limit",
    String(spec.pids ?? 64),
    "--memory",
    `${mem}m`,
    "--memory-swap",
    `${mem}m`,
    "--cpus",
    String(spec.cpus ?? 0.5),
    "--ulimit",
    "nofile=256:256",
    "--ulimit",
    "core=0",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${spec.tmpfsMb ?? 16}m`,
    "--workdir",
    "/tmp",
    "--log-driver",
    "none",
  ];
  for (const m of spec.readOnlyMounts ?? [])
    args.push(
      "--mount",
      `type=bind,source=${checkMount(m.host, m.container)},target=${m.container},readonly`,
    );
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\n\0]/.test(v))
      throw new SandboxPolicyError("SANDBOX_ENV", "Invalid environment entry.");
    args.push("--env", `${k}=${v}`);
  }
  if (spec.stdin !== undefined || spec.interactive) args.push("-i");
  args.push(spec.image, ...spec.command);
  return args;
}

export async function runSandboxed(spec: SandboxSpec): Promise<SandboxResult> {
  const name = `nearesis-sbx-${randomBytes(6).toString("hex")}`;
  const docker = spec.docker ?? "docker";
  const args = sandboxArgs(spec, name);
  const cap = spec.maxOutputBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    // The Docker CLI gets a minimal environment: the job never inherits the caller's secrets even indirectly.
    const child = spawn(docker, args, {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DOCKER_HOST: process.env.DOCKER_HOST ?? "",
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const take = (cur: string, c: Buffer) =>
      cur.length < cap ? cur + c.toString("utf8").slice(0, cap - cur.length) : cur;
    child.stdout.on("data", (c: Buffer) => (stdout = take(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = take(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      spawn(docker, ["kill", name], { stdio: "ignore" }).on("error", () => undefined);
    }, spec.timeoutMs ?? 20_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, containerName: name });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(spec.stdin ?? "");
  });
}

export interface SandboxSession {
  containerName: string;
  /** Write one line to the job's stdin. */
  send(line: string): void;
  /** Resolves when the container exits (or is killed by the timeout). */
  done: Promise<SandboxResult>;
  kill(): void;
}

/**
 * Interactive variant of `runSandboxed`: the job's stdout is delivered line by line to `onLine` while it runs and the host
 * can answer on stdin. The container still has no network and the same policy; this is the channel a sandboxed plugin
 * uses to ask the host's egress proxy for an outbound call.
 */
export function startSandboxed(spec: SandboxSpec, onLine: (line: string) => void): SandboxSession {
  const name = `nearesis-sbx-${randomBytes(6).toString("hex")}`;
  const docker = spec.docker ?? "docker";
  const args = sandboxArgs({ ...spec, interactive: true }, name);
  const cap = spec.maxOutputBytes ?? 1024 * 1024;
  const child = spawn(docker, args, {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DOCKER_HOST: process.env.DOCKER_HOST ?? "",
    } as unknown as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let buf = "";
  child.stdout.on("data", (c: Buffer) => {
    const t = c.toString("utf8");
    if (stdout.length < cap) stdout += t.slice(0, cap - stdout.length);
    buf += t;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
    if (buf.length > cap) buf = ""; // an unterminated flood is dropped, never buffered without bound
  });
  child.stderr.on("data", (c: Buffer) => {
    if (stderr.length < cap) stderr += c.toString("utf8").slice(0, cap - stderr.length);
  });
  const kill = () => {
    spawn(docker, ["kill", name], { stdio: "ignore" }).on("error", () => undefined);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, spec.timeoutMs ?? 20_000);
  child.stdin.on("error", () => undefined);
  if (spec.stdin !== undefined) child.stdin.write(spec.stdin);
  const done = new Promise<SandboxResult>((resolve, reject) => {
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, containerName: name });
    });
  });
  done.catch(() => undefined);
  return {
    containerName: name,
    send: (line) => {
      if (!child.stdin.destroyed) child.stdin.write(line + "\n");
    },
    done,
    kill,
  };
}
