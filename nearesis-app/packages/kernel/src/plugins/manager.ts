import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { CapabilityDecl, PluginManifest, Principal } from "@nearesis/contracts";
import {
  ManifestError,
  isPluginModule,
  majorOf,
  parseManifest,
  canonicalJson,
  sha256Hex,
  verifyManifestSignature,
} from "@nearesis/plugin-sdk";
import type { PluginModule } from "@nearesis/plugin-sdk";
import type { Db, Tx } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { INTEGRITY_REASON, IntegrityGuard } from "../integrity.ts";
import { writeAudit } from "../journal.ts";
import type { PluginSandboxConfig } from "./sandbox-exec.ts";
import { sandboxedModule } from "./sandbox-exec.ts";
import type { EgressDeps } from "../egress.ts";
import type { CommandContext, HandlerResult, PluginWorkspaceOps } from "../commands.ts";

export type PluginState = "installed" | "enabled" | "disabled" | "degraded" | "quarantined";
export type TrustMode = "production" | "dev_trust";

export interface PluginManagerConfig {
  trustMode: TrustMode;
  /** Defaults to process.env.NODE_ENV. dev_trust + "production" is refused. */
  nodeEnv?: string | undefined;
  /** publisher -> base64 SPKI ed25519 public keys. */
  trustedKeys: Record<string, string[]>;
  /** Entrypoints are resolved relative to this directory and may not escape it. */
  pluginRoot: string;
  /** Interfaces this engine provides, matched against manifest.requires. */
  engineInterfaces: string[];
  supportedApiVersions?: number[];
  quarantineAfterFailures?: number;
  healthTimeoutMs?: number;
  /**
   * Plugin execution policy. `isolation` decides per manifest: "confined" (default; in-process, network and process
   * primitives blocked outside `ctx.egress`) or "sandbox" (container without network, `sandbox-exec.ts`; the entrypoint
   * must be a self-contained ES module and is never imported into the kernel).
   */
  execution?: {
    isolation?: (manifest: PluginManifest) => "confined" | "sandbox";
    /**
     * Publishers whose signature-verified manifests may connect directly to the exact internal ip:port endpoints they
     * declare in `networkHosts` (the semantic layer, ClickHouse, Redis). Default none. Every other destination stays
     * refused for them, and an unsigned or unnamed publisher's internal entries grant nothing.
     */
    internalPublishers?: string[];
    sandbox?: PluginSandboxConfig;
    /** Resolver/dial hooks for `ctx.egress` (tests only; never set in production wiring). */
    egressDeps?: EgressDeps;
    /** Extra policy for `ctx.egress` (tests only, e.g. `allowInsecureHttp` against a local server). */
    egressPolicy?: { allowInsecureHttp?: boolean; timeoutMs?: number };
  };
}

export interface InstallationRow {
  id: string;
  pluginId: string;
  version: string;
  major: number;
  apiVersion: number;
  manifest: PluginManifest;
  /** sha256 of the canonical manifest recorded at install; null only for rows that predate it. */
  manifestSha256: string | null;
  trust: TrustMode;
  state: PluginState;
  stateReason: string | null;
  active: boolean;
  consecutiveFailures: number;
  lastHeartbeatAt: string | null;
  activatedFrom: string | null;
}

export interface ResolvedPlugin {
  installation: InstallationRow;
  capability: CapabilityDecl;
  module: PluginModule;
}

const INTERFACE_RE = /^[a-z][a-z0-9_.]*@\d+$/;

export const SUPPORTED_API_VERSIONS = [1];

/** Allowed state transitions (unit-tested). */
export const STATE_TRANSITIONS: Record<PluginState, readonly PluginState[]> = {
  installed: ["enabled", "disabled"],
  enabled: ["disabled", "degraded", "quarantined", "installed"],
  disabled: ["enabled", "installed"],
  degraded: ["enabled", "disabled", "quarantined", "installed"],
  quarantined: ["enabled", "disabled", "installed"],
};
export function canTransition(from: PluginState, to: PluginState): boolean {
  return from === to || STATE_TRANSITIONS[from].includes(to);
}

function mapRow(r: Record<string, unknown>): InstallationRow {
  return {
    id: r.id as string,
    pluginId: r.plugin_id as string,
    version: r.version as string,
    major: r.major as number,
    apiVersion: r.api_version as number,
    manifest: r.manifest as PluginManifest,
    manifestSha256: (r.manifest_sha256 as string | null) ?? null,
    trust: r.trust as TrustMode,
    state: r.state as PluginState,
    stateReason: (r.state_reason as string | null) ?? null,
    active: r.active as boolean,
    consecutiveFailures: r.consecutive_failures as number,
    lastHeartbeatAt: r.last_heartbeat_at ? new Date(r.last_heartbeat_at as string).toISOString() : null,
    activatedFrom: (r.activated_from as string | null) ?? null,
  };
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map(Number);
  const pb = b.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

export class PluginManager implements PluginWorkspaceOps {
  private readonly modules = new Map<string, PluginModule>();
  private readonly supported: number[];
  private readonly quarantineAfter: number;

  constructor(
    private readonly db: Db,
    readonly config: PluginManagerConfig,
  ) {
    const env = config.nodeEnv ?? process.env.NODE_ENV;
    if (config.trustMode === "dev_trust" && env === "production") {
      throw new KernelError(
        "FORBIDDEN",
        "DEV_TRUST_IN_PRODUCTION",
        "dev_trust plugin trust is refused when NODE_ENV=production.",
      );
    }
    this.supported = config.supportedApiVersions ?? SUPPORTED_API_VERSIONS;
    this.quarantineAfter = config.quarantineAfterFailures ?? 3;
  }

  // ---------------------------------------------------------------- install

  async install(actorId: string | null, rawManifest: unknown): Promise<InstallationRow> {
    const pid = (rawManifest as { pluginId?: unknown } | null)?.pluginId;
    const subject = typeof pid === "string" ? pid : "unknown";
    const reject = async (
      reasonCode: string,
      message: string,
      code: KernelError["code"] = "VALIDATION_FAILED",
    ) => {
      await this.db.txGlobal((tx) =>
        writeAudit(tx, {
          orgId: null,
          actorId,
          action: "plugin.install_rejected",
          subject,
          outcome: "denied",
          reasonCode,
          detail: { message },
        }),
      );
      return new KernelError(code, reasonCode, message);
    };

    let manifest: PluginManifest;
    try {
      manifest = parseManifest(rawManifest);
    } catch (e) {
      if (e instanceof ManifestError) throw await reject("MANIFEST_INVALID", e.message);
      throw e;
    }

    // Trust gate: runs BEFORE the entrypoint is read or imported (K05).
    let trust: TrustMode = "production";
    const env = this.config.nodeEnv ?? process.env.NODE_ENV;
    if (this.config.trustMode === "dev_trust" && env === "production") {
      throw await reject("DEV_TRUST_IN_PRODUCTION", "dev_trust is refused in production.", "FORBIDDEN");
    }
    if (manifest.signature) {
      const check = verifyManifestSignature(manifest, this.config.trustedKeys);
      if (!check.ok) {
        throw await reject(
          `SIGNATURE_${check.reason}`,
          `Plugin signature rejected: ${check.reason}.`,
          "FORBIDDEN",
        );
      }
    } else if (this.config.trustMode === "production") {
      throw await reject(
        "SIGNATURE_MISSING_SIGNATURE",
        "Unsigned plugins are rejected in production trust mode.",
        "FORBIDDEN",
      );
    } else {
      trust = "dev_trust";
    }

    if (!this.supported.includes(manifest.apiVersion)) {
      throw await reject(
        "ABI_UNSUPPORTED",
        `Plugin targets apiVersion ${manifest.apiVersion}; this kernel supports ${this.supported.join(", ")}. ` +
          `Upgrade the kernel to a release supporting apiVersion ${manifest.apiVersion}, or rebuild the plugin for apiVersion ${this.supported[this.supported.length - 1]}.`,
        "VALIDATION_FAILED",
      );
    }

    // Artifact integrity, then (and only then) import.
    const entry = resolve(this.config.pluginRoot, manifest.entrypoint);
    const rel = relative(resolve(this.config.pluginRoot), entry);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw await reject("ENTRYPOINT_OUTSIDE_ROOT", "Entrypoint escapes the plugin root.");
    let bytes: Buffer;
    try {
      bytes = readFileSync(entry);
    } catch {
      throw await reject("ENTRYPOINT_MISSING", "Entrypoint file not found.");
    }
    if (sha256Hex(bytes) !== manifest.artifactSha256) {
      throw await reject(
        "ARTIFACT_HASH_MISMATCH",
        "Entrypoint does not match manifest artifactSha256.",
        "FORBIDDEN",
      );
    }
    let mod: PluginModule;
    if (this.isolationOf(manifest) === "sandbox") {
      // Never import untrusted code into the kernel process; the handlers run in a container.
      mod = sandboxedModule(manifest, entry, this.config.execution?.sandbox);
    } else {
      try {
        const imported = (await import(/* @vite-ignore */ entry)) as { default?: unknown };
        if (!isPluginModule(imported.default)) throw new Error("default export is not a plugin module");
        mod = imported.default;
      } catch (e) {
        throw await reject("PLUGIN_LOAD_FAILED", `Plugin failed to load: ${(e as Error).message}`);
      }
    }
    const missing = manifest.capabilities
      .filter((c) => typeof mod.handlers[c.id] !== "function")
      .map((c) => c.id);
    if (missing.length)
      throw await reject("HANDLER_MISSING", `No handler for declared capabilities: ${missing.join(", ")}`);

    // Dependency check: a plugin requiring a missing engine interface is installed disabled, kernel keeps booting.
    const unmet = manifest.requires.filter((r) => !this.config.engineInterfaces.includes(r));
    const state: PluginState = unmet.length ? "disabled" : "installed";
    const reason = unmet.length
      ? `Requires engine interface ${unmet.join(", ")}, which this kernel does not provide.`
      : null;

    const id = randomUUID();
    try {
      await this.db.txGlobal(async (tx) => {
        await tx.query(
          `INSERT INTO plugin_installations(id, plugin_id, version, major, api_version, manifest, trust, state, state_reason, installed_by, manifest_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            manifest.pluginId,
            manifest.version,
            majorOf(manifest.version),
            manifest.apiVersion,
            JSON.stringify(manifest),
            trust,
            state,
            reason,
            actorId,
            sha256Hex(canonicalJson(manifest)),
          ],
        );
        await writeAudit(tx, {
          orgId: null,
          actorId,
          action: "plugin.installed",
          subject: `${manifest.pluginId}@${manifest.version}`,
          outcome: "ok",
          detail: { trust, state, requires: manifest.requires },
        });
        if (trust === "dev_trust") {
          await writeAudit(tx, {
            orgId: null,
            actorId,
            action: "plugin.dev_trust_install",
            subject: `${manifest.pluginId}@${manifest.version}`,
            outcome: "ok",
            detail: { warning: "unsigned plugin accepted under dev_trust" },
          });
        }
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "ALREADY_INSTALLED",
          `${manifest.pluginId}@${manifest.version} is already installed.`,
        );
      }
      throw e;
    }
    this.modules.set(id, mod);
    return (await this.getInstallation(id))!;
  }

  // ---------------------------------------------------------------- lookups

  async getInstallation(id: string): Promise<InstallationRow | undefined> {
    const r = await this.db.txGlobal((tx) =>
      tx.query("SELECT * FROM plugin_installations WHERE id = $1", [id]),
    );
    return r.rows[0] ? mapRow(r.rows[0]) : undefined;
  }

  async findInstallation(pluginId: string, version: string): Promise<InstallationRow | undefined> {
    const r = await this.db.txGlobal((tx) =>
      tx.query("SELECT * FROM plugin_installations WHERE plugin_id = $1 AND version = $2", [
        pluginId,
        version,
      ]),
    );
    return r.rows[0] ? mapRow(r.rows[0]) : undefined;
  }

  async activeInstallation(pluginId: string): Promise<InstallationRow | undefined> {
    const r = await this.db.txGlobal((tx) =>
      tx.query("SELECT * FROM plugin_installations WHERE plugin_id = $1 AND active", [pluginId]),
    );
    return r.rows[0] ? mapRow(r.rows[0]) : undefined;
  }

  /** Load (or re-load after restart) the plugin module, re-verifying trust and artifact hash first. */
  async moduleFor(inst: InstallationRow): Promise<PluginModule> {
    await this.verifyManifestIntegrity(inst);
    const cached = this.modules.get(inst.id);
    if (cached) return cached;
    if (inst.trust === "production") {
      const check = verifyManifestSignature(inst.manifest, this.config.trustedKeys);
      if (!check.ok)
        throw new KernelError(
          "FORBIDDEN",
          `SIGNATURE_${check.reason}`,
          "Plugin signature no longer verifies.",
        );
    }
    const entry = resolve(this.config.pluginRoot, inst.manifest.entrypoint);
    if (sha256Hex(readFileSync(entry)) !== inst.manifest.artifactSha256) {
      throw new KernelError("FORBIDDEN", "ARTIFACT_HASH_MISMATCH", "Plugin artifact changed on disk.");
    }
    if (this.isolationOf(inst.manifest) === "sandbox") {
      const boxed = sandboxedModule(inst.manifest, entry, this.config.execution?.sandbox);
      this.modules.set(inst.id, boxed);
      return boxed;
    }
    const imported = (await import(/* @vite-ignore */ entry)) as { default?: unknown };
    if (!isPluginModule(imported.default))
      throw new KernelError("INTERNAL", "PLUGIN_LOAD_FAILED", "Plugin failed to load.");
    this.modules.set(inst.id, imported.default);
    return imported.default;
  }

  /**
   * The stored manifest must still hash to the value recorded at install, on every use (including cached modules): a
   * byte changed in the database is quarantined and the plugin is not run. Pre-existing rows without a recorded hash
   * are bound on first use and the binding is audited.
   */
  private async verifyManifestIntegrity(inst: InstallationRow): Promise<void> {
    const actual = sha256Hex(canonicalJson(inst.manifest));
    const scope = { orgId: null, userId: null };
    const guard = new IntegrityGuard(this.db);
    if (inst.manifestSha256 === null) {
      await guard.assertNotQuarantined(scope, "plugin_manifest", inst.id);
      await this.db.txGlobal(async (tx) => {
        await tx.query(
          "UPDATE plugin_installations SET manifest_sha256 = $2 WHERE id = $1 AND manifest_sha256 IS NULL",
          [inst.id, actual],
        );
        await writeAudit(tx, {
          orgId: null,
          action: "plugin.manifest_hash_bound",
          subject: `${inst.pluginId}@${inst.version}`,
          outcome: "ok",
          detail: { manifestSha256: actual },
        });
      });
      return;
    }
    await guard.verify(scope, "plugin_manifest", inst.id, inst.manifestSha256, actual);
  }

  isolationOf(manifest: PluginManifest): "confined" | "sandbox" {
    return this.config.execution?.isolation?.(manifest) ?? "confined";
  }

  // ---------------------------------------------------------------- lifecycle

  private async setState(
    tx: Tx,
    inst: InstallationRow,
    to: PluginState,
    reason: string | null,
    extra = "",
  ): Promise<void> {
    if (!canTransition(inst.state, to)) {
      throw new KernelError(
        "DOMAIN_INVARIANT",
        "INVALID_STATE_TRANSITION",
        `Cannot move plugin from ${inst.state} to ${to}.`,
      );
    }
    await tx.query(`UPDATE plugin_installations SET state = $2, state_reason = $3${extra} WHERE id = $1`, [
      inst.id,
      to,
      reason,
    ]);
  }

  /** Enable the plugin globally. Activates `version` if no version is active yet; otherwise it must be the active one. */
  async enable(actorId: string | null, pluginId: string, version?: string): Promise<InstallationRow> {
    const id = await this.db.txGlobal(async (tx) => {
      await tx.query("SELECT 1 FROM plugin_installations WHERE plugin_id = $1 FOR UPDATE", [pluginId]);
      const rows = (
        await tx.query("SELECT * FROM plugin_installations WHERE plugin_id = $1", [pluginId])
      ).rows.map(mapRow);
      const active = rows.find((r) => r.active);
      const target = version
        ? rows.find((r) => r.version === version)
        : (active ?? rows.sort((a, b) => cmpSemver(b.version, a.version))[0]);
      if (!target) throw new KernelError("NOT_FOUND", "PLUGIN_NOT_INSTALLED", "Plugin is not installed.");
      if (active && active.id !== target.id) {
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "ANOTHER_VERSION_ACTIVE",
          "Another version is active; use upgrade.",
        );
      }
      const unmet = target.manifest.requires.filter((r) => !this.config.engineInterfaces.includes(r));
      if (unmet.length) {
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "DEPENDENCY_MISSING",
          `Requires engine interface ${unmet.join(", ")}.`,
        );
      }
      await this.setState(tx, target, "enabled", null, ", active = true, consecutive_failures = 0");
      await writeAudit(tx, {
        orgId: null,
        actorId,
        action: "plugin.enabled",
        subject: `${pluginId}@${target.version}`,
        outcome: "ok",
      });
      return target.id;
    });
    return (await this.getInstallation(id))!;
  }

  /** Disable the active version. Invocations are denied (and audited) until re-enabled. */
  async disable(
    actorId: string | null,
    pluginId: string,
    reason = "disabled by operator",
  ): Promise<InstallationRow> {
    const id = await this.db.txGlobal(async (tx) => {
      const r = await tx.query(
        "SELECT * FROM plugin_installations WHERE plugin_id = $1 AND active FOR UPDATE",
        [pluginId],
      );
      if (!r.rows[0])
        throw new KernelError("NOT_FOUND", "PLUGIN_NOT_ACTIVE", "Plugin has no active version.");
      const inst = mapRow(r.rows[0]);
      await this.setState(tx, inst, "disabled", reason);
      await writeAudit(tx, {
        orgId: null,
        actorId,
        action: "plugin.disabled",
        subject: `${pluginId}@${inst.version}`,
        outcome: "ok",
        detail: { reason },
      });
      return inst.id;
    });
    return (await this.getInstallation(id))!;
  }

  async upgrade(
    actorId: string | null,
    pluginId: string,
    toVersion: string,
    opts: { migration?: string } = {},
  ): Promise<{ from: string; to: string }> {
    try {
      return await this.db.txGlobal(async (tx) => {
        const rows = (
          await tx.query("SELECT * FROM plugin_installations WHERE plugin_id = $1 FOR UPDATE", [pluginId])
        ).rows.map(mapRow);
        const cur = rows.find((r) => r.active);
        const target = rows.find((r) => r.version === toVersion);
        if (!cur) throw new KernelError("NOT_FOUND", "PLUGIN_NOT_ACTIVE", "Plugin has no active version.");
        if (!target)
          throw new KernelError(
            "NOT_FOUND",
            "VERSION_NOT_INSTALLED",
            `Version ${toVersion} is not installed.`,
          );
        if (cmpSemver(target.version, cur.version) <= 0) {
          throw new KernelError(
            "VALIDATION_FAILED",
            "UPGRADE_NOT_NEWER",
            "Target version is not newer; use rollback.",
          );
        }
        const unmet = target.manifest.requires.filter((r) => !this.config.engineInterfaces.includes(r));
        if (unmet.length)
          throw new KernelError(
            "DOMAIN_INVARIANT",
            "DEPENDENCY_MISSING",
            `Requires engine interface ${unmet.join(", ")}.`,
          );
        const breaking = target.major !== cur.major || target.apiVersion !== cur.apiVersion;
        let repinned = 0;
        if (breaking) {
          const dep = await tx.query(
            "SELECT count(*)::int AS n FROM operator_plugin_dependents() WHERE plugin_id = $1 AND pinned_major = $2",
            [pluginId, cur.major],
          );
          if ((dep.rows[0]?.n ?? 0) > 0 && !opts.migration) {
            throw new KernelError(
              "DOMAIN_INVARIANT",
              "ABI_MAJOR_CHANGE_REQUIRES_MIGRATION",
              `Upgrading ${pluginId} from ${cur.version} to ${target.version} is a breaking change for workspaces pinned to ${cur.major}.x; declare a migration.`,
              { nextAction: "Provide a declared migration for the major change." },
            );
          }
          repinned = (
            await tx.query("SELECT operator_repin_workspaces($1,$2,$3) AS n", [
              pluginId,
              cur.major,
              target.major,
            ])
          ).rows[0].n;
        }
        await tx.query(
          "UPDATE plugin_installations SET active = false, state = 'installed', state_reason = $2 WHERE id = $1",
          [cur.id, `superseded by ${target.version}`],
        );
        await tx.query(
          "UPDATE plugin_installations SET active = true, state = 'enabled', state_reason = NULL, activated_from = $2, consecutive_failures = 0 WHERE id = $1",
          [target.id, cur.id],
        );
        await writeAudit(tx, {
          orgId: null,
          actorId,
          action: "plugin.upgraded",
          subject: pluginId,
          outcome: "ok",
          detail: {
            actor: actorId,
            from: cur.version,
            to: target.version,
            migration: opts.migration ?? null,
            repinnedWorkspaces: repinned,
          },
        });
        return { from: cur.version, to: target.version };
      });
    } catch (e) {
      if (e instanceof KernelError && e.reasonCode === "ABI_MAJOR_CHANGE_REQUIRES_MIGRATION") {
        await this.db.txGlobal((tx) =>
          writeAudit(tx, {
            orgId: null,
            actorId,
            action: "plugin.upgrade_denied",
            subject: pluginId,
            outcome: "denied",
            reasonCode: e.reasonCode,
            detail: { to: toVersion },
          }),
        );
      }
      throw e;
    }
  }

  async rollback(actorId: string | null, pluginId: string): Promise<{ from: string; to: string | null }> {
    return this.db.txGlobal(async (tx) => {
      const rows = (
        await tx.query("SELECT * FROM plugin_installations WHERE plugin_id = $1 FOR UPDATE", [pluginId])
      ).rows.map(mapRow);
      const cur = rows.find((r) => r.active);
      if (!cur) throw new KernelError("NOT_FOUND", "PLUGIN_NOT_ACTIVE", "Plugin has no active version.");
      if (cur.manifest.rollbackStrategy === "disable") {
        await this.setState(tx, cur, "disabled", "rolled back by disabling");
        await writeAudit(tx, {
          orgId: null,
          actorId,
          action: "plugin.rolled_back",
          subject: pluginId,
          outcome: "ok",
          detail: { actor: actorId, from: cur.version, to: null, strategy: "disable" },
        });
        return { from: cur.version, to: null };
      }
      const prev = rows.find((r) => r.id === cur.activatedFrom);
      if (!prev)
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "NO_PREVIOUS_VERSION",
          "There is no previous version to roll back to.",
        );
      if (prev.major !== cur.major) {
        await tx.query("SELECT operator_repin_workspaces($1,$2,$3)", [pluginId, cur.major, prev.major]);
      }
      await tx.query(
        "UPDATE plugin_installations SET active = false, state = 'installed', state_reason = $2, activated_from = NULL WHERE id = $1",
        [cur.id, `rolled back to ${prev.version}`],
      );
      await tx.query(
        "UPDATE plugin_installations SET active = true, state = 'enabled', state_reason = NULL, consecutive_failures = 0 WHERE id = $1",
        [prev.id],
      );
      await writeAudit(tx, {
        orgId: null,
        actorId,
        action: "plugin.rolled_back",
        subject: pluginId,
        outcome: "ok",
        detail: {
          actor: actorId,
          from: cur.version,
          to: prev.version,
          strategy: cur.manifest.rollbackStrategy,
        },
      });
      return { from: cur.version, to: prev.version };
    });
  }

  // ---------------------------------------------------------------- health

  /** Record a health result for an installation. Repeated failures degrade, then quarantine. */
  async recordHealth(installationId: string, ok: boolean, detail = ""): Promise<InstallationRow> {
    await this.db.txGlobal(async (tx) => {
      const r = await tx.query("SELECT * FROM plugin_installations WHERE id = $1 FOR UPDATE", [
        installationId,
      ]);
      if (!r.rows[0]) return;
      const inst = mapRow(r.rows[0]);
      if (ok) {
        await tx.query(
          "UPDATE plugin_installations SET last_heartbeat_at = now(), consecutive_failures = 0 WHERE id = $1",
          [inst.id],
        );
        if (inst.state === "degraded") {
          await this.setState(tx, inst, "enabled", null);
          await tx.query(
            "UPDATE plugin_incidents SET resolved_at = now() WHERE installation_id = $1 AND resolved_at IS NULL AND kind = 'health_check_failed'",
            [inst.id],
          );
        }
        return;
      }
      await this.failure(tx, inst, "health_check_failed", detail, false);
    });
    return (await this.getInstallation(installationId))!;
  }

  /** Open an incident, bump the failure counter, degrade (immediately if `degradeNow`) and quarantine at the threshold. */
  async failure(
    tx: Tx,
    inst: InstallationRow,
    kind: string,
    detail: string,
    degradeNow: boolean,
  ): Promise<void> {
    const failures = inst.consecutiveFailures + 1;
    await tx.query(
      "INSERT INTO plugin_incidents(id, plugin_id, installation_id, kind, detail) VALUES ($1,$2,$3,$4,$5)",
      [randomUUID(), inst.pluginId, inst.id, kind, detail.slice(0, 500)],
    );
    await tx.query("UPDATE plugin_installations SET consecutive_failures = $2 WHERE id = $1", [
      inst.id,
      failures,
    ]);
    if (inst.state === "quarantined" || inst.state === "disabled" || inst.state === "installed") return;
    if (failures >= this.quarantineAfter) {
      await this.setState(tx, inst, "quarantined", `${failures} consecutive failures: ${kind}`);
      await writeAudit(tx, {
        orgId: null,
        action: "plugin.quarantined",
        subject: `${inst.pluginId}@${inst.version}`,
        outcome: "ok",
        reasonCode: kind,
        detail: { failures },
      });
    } else if (degradeNow || kind === "health_check_failed") {
      await this.setState(tx, inst, "degraded", `${kind}: ${detail.slice(0, 200)}`);
    }
  }

  /** Gateway hook: record an invocation failure/timeout against the exact installation that ran. */
  async reportInvocationFailure(
    installationId: string,
    kind: string,
    detail: string,
    degradeNow: boolean,
  ): Promise<void> {
    await this.db.txGlobal(async (tx) => {
      const r = await tx.query("SELECT * FROM plugin_installations WHERE id = $1 FOR UPDATE", [
        installationId,
      ]);
      if (r.rows[0]) await this.failure(tx, mapRow(r.rows[0]), kind, detail, degradeNow);
    });
  }

  async reportInvocationSuccess(installationId: string): Promise<void> {
    await this.db.txGlobal((tx) =>
      tx.query(
        "UPDATE plugin_installations SET consecutive_failures = 0 WHERE id = $1 AND state = 'enabled'",
        [installationId],
      ),
    );
  }

  /** Run the plugin's health probe (module.health). */
  async checkHealth(installationId: string): Promise<InstallationRow> {
    const inst = await this.getInstallation(installationId);
    if (!inst) throw new KernelError("NOT_FOUND", "PLUGIN_NOT_INSTALLED", "Plugin is not installed.");
    try {
      const mod = await this.moduleFor(inst);
      if (mod.health) {
        await Promise.race([
          Promise.resolve(mod.health()),
          new Promise((_, rej) =>
            setTimeout(
              () => rej(new Error("health check timed out")),
              this.config.healthTimeoutMs ?? 5000,
            ).unref(),
          ),
        ]);
      }
      return await this.recordHealth(installationId, true);
    } catch (e) {
      return this.recordHealth(installationId, false, (e as Error).message);
    }
  }

  /** Operator action: put a quarantined plugin back into service. */
  async release(actorId: string | null, pluginId: string): Promise<void> {
    await this.db.txGlobal(async (tx) => {
      const r = await tx.query(
        "SELECT * FROM plugin_installations WHERE plugin_id = $1 AND active FOR UPDATE",
        [pluginId],
      );
      if (!r.rows[0])
        throw new KernelError("NOT_FOUND", "PLUGIN_NOT_ACTIVE", "Plugin has no active version.");
      const inst = mapRow(r.rows[0]);
      await this.setState(tx, inst, "enabled", null, ", consecutive_failures = 0");
      await tx.query(
        "UPDATE plugin_incidents SET resolved_at = now() WHERE installation_id = $1 AND resolved_at IS NULL",
        [inst.id],
      );
      await writeAudit(tx, {
        orgId: null,
        actorId,
        action: "plugin.released",
        subject: `${pluginId}@${inst.version}`,
        outcome: "ok",
      });
    });
  }

  /** Boot: re-evaluate dependencies for every installation. Never throws on a bad plugin. */
  async boot(): Promise<void> {
    const rows = (await this.db.txGlobal((tx) => tx.query("SELECT * FROM plugin_installations"))).rows.map(
      mapRow,
    );
    for (const inst of rows) {
      const unmet = inst.manifest.requires.filter(
        (r) => !this.config.engineInterfaces.includes(r) || !INTERFACE_RE.test(r),
      );
      if (unmet.length && inst.state !== "disabled") {
        await this.db.txGlobal((tx) =>
          tx.query("UPDATE plugin_installations SET state = 'disabled', state_reason = $2 WHERE id = $1", [
            inst.id,
            `Requires engine interface ${unmet.join(", ")}, which this kernel does not provide.`,
          ]),
        );
      }
    }
  }

  // ---------------------------------------------------------------- workspace enablement (command handlers)

  async enableInWorkspace(ctx: CommandContext, pluginId: string): Promise<HandlerResult> {
    const inst = await this.activeInstallation(pluginId);
    if (!inst || inst.state === "disabled" || inst.state === "quarantined") {
      throw new KernelError(
        "DOMAIN_INVARIANT",
        "PLUGIN_NOT_AVAILABLE",
        "Plugin is not available for enabling.",
      );
    }
    await ctx.tx.query(
      `INSERT INTO workspace_plugins(workspace_id, org_id, plugin_id, pinned_major, enabled, enabled_by)
       VALUES ($1,$2,$3,$4,true,$5)
       ON CONFLICT (workspace_id, plugin_id) DO UPDATE SET enabled = true, pinned_major = EXCLUDED.pinned_major, enabled_by = EXCLUDED.enabled_by, updated_at = now()`,
      [ctx.workspace.id, ctx.workspace.orgId, pluginId, inst.major, ctx.session.userId],
    );
    return {
      eventType: "plugin.enabled",
      data: { pluginId, version: inst.version },
      result: { pluginId, major: inst.major },
    };
  }

  async disableInWorkspace(ctx: CommandContext, pluginId: string): Promise<HandlerResult> {
    const r = await ctx.tx.query(
      "UPDATE workspace_plugins SET enabled = false, updated_at = now() WHERE workspace_id = $1 AND plugin_id = $2",
      [ctx.workspace.id, pluginId],
    );
    if (r.rowCount === 0)
      throw new KernelError("NOT_FOUND", "PLUGIN_NOT_ENABLED", "Plugin is not enabled in this workspace.");
    return { eventType: "plugin.disabled", data: { pluginId }, result: { pluginId } };
  }

  // ---------------------------------------------------------------- resolution + discovery

  /**
   * Resolve a capability for a workspace. Returns either the resolved plugin (version object captured here, so
   * in-flight calls keep it across upgrades) or a machine-readable denial.
   */
  async resolve(
    tx: Tx,
    workspaceId: string,
    capabilityId: string,
  ): Promise<
    | { ok: true; resolved: ResolvedPlugin }
    | { ok: false; reasonCode: string; message: string; installation?: InstallationRow }
  > {
    const r = await tx.query(
      `SELECT * FROM plugin_installations WHERE active AND manifest->'capabilities' @> $1::jsonb`,
      [JSON.stringify([{ id: capabilityId }])],
    );
    if (!r.rows[0]) return { ok: false, reasonCode: "CAPABILITY_NOT_FOUND", message: "No such capability." };
    const inst = mapRow(r.rows[0]);
    const wp = await tx.query(
      "SELECT enabled, pinned_major FROM workspace_plugins WHERE workspace_id = $1 AND plugin_id = $2",
      [workspaceId, inst.pluginId],
    );
    if (!wp.rows[0])
      return {
        ok: false,
        reasonCode: "PLUGIN_NOT_ENABLED",
        message: "Capability is not enabled for this workspace.",
        installation: inst,
      };
    if (!wp.rows[0].enabled || inst.state === "disabled" || inst.state === "installed") {
      return { ok: false, reasonCode: "PLUGIN_DISABLED", message: "Plugin is disabled.", installation: inst };
    }
    if (inst.state === "quarantined") {
      return {
        ok: false,
        reasonCode: "PLUGIN_QUARANTINED",
        message: "Plugin is quarantined.",
        installation: inst,
      };
    }
    if (wp.rows[0].pinned_major !== inst.major) {
      return {
        ok: false,
        reasonCode: "PLUGIN_VERSION_PIN_MISMATCH",
        message: "Workspace is pinned to a different major version.",
        installation: inst,
      };
    }
    const capability = inst.manifest.capabilities.find((c) => c.id === capabilityId)!;
    let module: PluginModule;
    try {
      module = await this.moduleFor(inst);
    } catch (e) {
      return {
        ok: false,
        reasonCode:
          e instanceof KernelError && e.reasonCode === INTEGRITY_REASON
            ? INTEGRITY_REASON
            : "PLUGIN_LOAD_FAILED",
        message: (e as Error).message,
        installation: inst,
      };
    }
    return { ok: true, resolved: { installation: inst, capability, module } };
  }

  /** Capabilities visible to a workspace: only those of plugins enabled for it, and currently live. */
  async listCapabilities(
    principal: Principal,
    userId: string,
    workspaceId: string,
  ): Promise<
    Array<{
      capability: string;
      pluginId: string;
      version: string;
      category: string;
      sideEffect: string;
      state: PluginState;
    }>
  > {
    return this.db.tx({ orgId: principal.orgId, userId, actorKind: principal.kind }, async (tx) => {
      const ws = await tx.query("SELECT id FROM workspaces WHERE id = $1", [workspaceId]);
      if (!ws.rows[0]) throw new KernelError("FORBIDDEN", "ACCESS_DENIED", "Access denied.");
      const r = await tx.query(
        `SELECT pi.* FROM workspace_plugins wp JOIN plugin_installations pi ON pi.plugin_id = wp.plugin_id AND pi.active
         WHERE wp.workspace_id = $1 AND wp.enabled AND pi.state IN ('enabled','degraded') AND wp.pinned_major = pi.major
         ORDER BY pi.plugin_id`,
        [workspaceId],
      );
      return r.rows.map(mapRow).flatMap((inst) =>
        inst.manifest.capabilities.map((c) => ({
          capability: c.id,
          pluginId: inst.pluginId,
          version: inst.version,
          category: c.category,
          sideEffect: c.sideEffect,
          state: inst.state,
        })),
      );
    });
  }

  // ---------------------------------------------------------------- inspect

  async inspect(): Promise<EngineInspection> {
    return this.db.txGlobal(async (tx) => {
      const inst = (
        await tx.query("SELECT * FROM plugin_installations ORDER BY plugin_id, version")
      ).rows.map(mapRow);
      const deps = (
        await tx.query(
          "SELECT plugin_id, workspace_id FROM operator_plugin_dependents() ORDER BY workspace_id",
        )
      ).rows;
      const inc = (
        await tx.query(
          "SELECT id, installation_id, kind, detail, opened_at FROM plugin_incidents WHERE resolved_at IS NULL ORDER BY opened_at",
        )
      ).rows;
      return {
        kernel: {
          supportedApiVersions: this.supported,
          trustMode: this.config.trustMode,
          engineInterfaces: [...this.config.engineInterfaces].sort(),
        },
        plugins: inst.map((i) => ({
          pluginId: i.pluginId,
          version: i.version,
          state: i.state,
          stateReason: i.stateReason,
          trust: i.trust,
          active: i.active,
          lastHeartbeatAt: i.lastHeartbeatAt,
          liveCapabilities:
            i.active && (i.state === "enabled" || i.state === "degraded")
              ? i.manifest.capabilities.map((c) => c.id).sort()
              : [],
          dependentWorkspaces: deps
            .filter((d) => d.plugin_id === i.pluginId && i.active)
            .map((d) => d.workspace_id as string),
          openIncidents: inc
            .filter((x) => x.installation_id === i.id)
            .map((x) => ({
              id: x.id as string,
              kind: x.kind as string,
              detail: x.detail as string,
              openedAt: new Date(x.opened_at).toISOString(),
            })),
        })),
      };
    });
  }
}

export interface EngineInspection {
  kernel: { supportedApiVersions: number[]; trustMode: TrustMode; engineInterfaces: string[] };
  plugins: Array<{
    pluginId: string;
    version: string;
    state: PluginState;
    stateReason: string | null;
    trust: TrustMode;
    active: boolean;
    lastHeartbeatAt: string | null;
    liveCapabilities: string[];
    dependentWorkspaces: string[];
    openIncidents: Array<{ id: string; kind: string; detail: string; openedAt: string }>;
  }>;
}
