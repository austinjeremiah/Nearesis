import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginManifest } from "@nearesis/contracts";
import { definePlugin } from "@nearesis/plugin-sdk";
import type { InvocationContext, PluginModule } from "@nearesis/plugin-sdk";
import { startSandboxed } from "../sandbox.ts";
import { outsideConfinement } from "./confine.ts";
import { SANDBOX_IMAGE } from "./sandbox-image.ts";

/**
 * Sandboxed plugin execution (ch.08 sandbox, ch.12 "remote plugins need sandbox resource limits", FND-20261111-014).
 * The plugin module is never imported into the kernel process. Each invocation starts one container from the runner in
 * `sandbox.ts` (no network, read-only root, non-root, every capability dropped, pid/memory/CPU/tmpfs bounded) holding a
 * hash-verified copy of the artifact; the only way out is the line protocol in `sandbox-bootstrap.mjs`, and an outbound
 * request on it is performed by the kernel's own egress proxy under the manifest allowlist.
 */
export interface PluginSandboxConfig {
  /** Image reference or id; must already exist locally (`--pull never`). */
  image?: string;
  docker?: string;
}

export class PluginLimitError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginLimitError";
  }
}

const BOOTSTRAP = resolve(dirname(fileURLToPath(import.meta.url)), "sandbox-bootstrap.mjs");

/** Map container accounting to the `reason_code` the gateway reports (SEC12(b)). */
export function limitReason(
  exitCode: number | null,
  timedOut: boolean,
  errCode?: string,
  message?: string,
  memoryAtLimit = false,
): string | null {
  if (timedOut) return memoryAtLimit ? "PLUGIN_MEMORY_LIMIT" : "PLUGIN_CPU_LIMIT";
  if (errCode === "ENOSPC" || /ENOSPC|no space left/i.test(message ?? "")) return "PLUGIN_DISK_LIMIT";
  if (errCode === "EAGAIN" || /EAGAIN|Resource temporarily unavailable/i.test(message ?? ""))
    return "PLUGIN_PROCESS_LIMIT";
  if (exitCode === 137) return "PLUGIN_MEMORY_LIMIT";
  return null;
}

/** A PluginModule whose handlers execute in a container. `artifactPath` is the already hash-verified entrypoint. */
export function sandboxedModule(
  manifest: PluginManifest,
  artifactPath: string,
  cfg: PluginSandboxConfig = {},
): PluginModule {
  const handlers: Record<string, (input: unknown, ctx: InvocationContext) => Promise<unknown>> = {};
  for (const c of manifest.capabilities) {
    // The handler wrapper is kernel code: it starts the container (a child process) on the plugin's behalf, so it runs
    // outside the in-process confinement scope that guards untrusted handler bodies.
    handlers[c.id] = (input, ctx) => outsideConfinement(() => runBoxed(input, ctx));
    const runBoxed = async (input: unknown, ctx: InvocationContext): Promise<unknown> => {
      const dir = mkdtempSync(join(tmpdir(), "nearesis-plug-"));
      copyFileSync(artifactPath, join(dir, "entry.mjs"));
      const memoryMb = Math.max(32, manifest.resourceLimits.memoryMb);
      const timeoutMs = Math.max(500, Math.min(manifest.resourceLimits.cpuMs, 60_000) + 2_000);
      let settled: { ok: true; value: unknown } | { ok: false; code: string; message: string } | undefined;
      const session = startSandboxed(
        {
          image: cfg.image ?? SANDBOX_IMAGE,
          command: ["node", "/bootstrap/bootstrap.mjs"],
          readOnlyMounts: [
            { host: dir, container: "/plugin" },
            { host: BOOTSTRAP, container: "/bootstrap/bootstrap.mjs" },
          ],
          memoryMb,
          cpus: 0.5,
          pids: 32,
          tmpfsMb: 8,
          timeoutMs,
          ...(cfg.docker ? { docker: cfg.docker } : {}),
        },
        (line) => {
          let m: {
            op?: string;
            id?: number;
            url?: string;
            init?: unknown;
            value?: unknown;
            code?: string;
            message?: string;
          };
          try {
            m = JSON.parse(line);
          } catch {
            return;
          }
          if (m.op === "result") settled = { ok: true, value: m.value };
          else if (m.op === "error")
            settled = { ok: false, code: m.code ?? "PLUGIN_ERROR", message: m.message ?? "" };
          else if (m.op === "egress" && typeof m.id === "number") {
            const id = m.id;
            ctx
              .egress(String(m.url), (m.init ?? {}) as Parameters<typeof ctx.egress>[1])
              .then((res) =>
                session.send(
                  JSON.stringify({
                    op: "egress.result",
                    id,
                    ok: true,
                    res: {
                      status: res.status,
                      headers: res.headers,
                      url: res.url,
                      bodyB64: Buffer.from(res.body).toString("base64"),
                    },
                  }),
                ),
              )
              .catch((e: { reasonCode?: string; message?: string }) =>
                session.send(
                  JSON.stringify({
                    op: "egress.result",
                    id,
                    ok: false,
                    code: e.reasonCode ?? "EGRESS_ERROR",
                    message: String(e.message ?? "egress failed").slice(0, 300),
                  }),
                ),
              );
          }
        },
      );
      ctx.signal.addEventListener("abort", () => session.kill(), { once: true });
      session.send(
        JSON.stringify({
          op: "invoke",
          capability: ctx.capability,
          input,
          ctx: {
            requestId: ctx.requestId,
            workspaceId: ctx.workspaceId,
            principal: ctx.principal,
            capability: ctx.capability,
          },
        }),
      );
      try {
        const r = await session.done;
        if (settled?.ok) return settled.value;
        const reason = limitReason(
          r.exitCode,
          r.timedOut,
          settled && !settled.ok ? settled.code : undefined,
          settled && !settled.ok ? settled.message : r.stderr,
          r.memoryAtLimit === true,
        );
        if (reason) throw new PluginLimitError(reason, `sandbox limit: ${reason}`);
        throw new Error(settled && !settled.ok ? settled.message : `sandbox exited ${r.exitCode}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }
  return definePlugin({ handlers });
}
