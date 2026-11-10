import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSigningKeyPair, signManifest } from "@nearesis/plugin-sdk";
import type { PluginManifest } from "@nearesis/contracts";
import { KernelError, installPluginFromRoot, loadTrustedKeys, readManifestFile } from "../src/index.ts";
import { FIXTURE_ROOT, TEST_KEY, TEST_PUBLISHER, createTestDb, makeManifest } from "./helpers/index.ts";
import type { TestDb } from "./helpers/index.ts";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db?.drop());

const trusted = { [TEST_PUBLISHER]: [TEST_KEY.publicKey] };
const rows = async (pluginId: string) =>
  (await db.admin.query("SELECT * FROM plugin_installations WHERE plugin_id = $1", [pluginId])).rows;
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(KernelError);
    return e as KernelError;
  }
  throw new Error("expected rejection");
};

describe("installPluginFromRoot (production trust)", () => {
  it("installs a signed plugin from its root, activates it, and is idempotent per version", async () => {
    const manifest = makeManifest({
      pluginId: "fx-plugin-echo",
      version: "1.0.0",
      entrypoint: "echo-1.0.0.ts",
    });
    const r1 = await installPluginFromRoot(db.app, { root: FIXTURE_ROOT, trustedKeys: trusted, manifest });
    expect(r1).toMatchObject({
      pluginId: "fx-plugin-echo",
      version: "1.0.0",
      outcome: "installed",
      state: "enabled",
      active: true,
    });
    const r2 = await installPluginFromRoot(db.app, { root: FIXTURE_ROOT, trustedKeys: trusted, manifest });
    expect(r2).toMatchObject({
      outcome: "already_installed",
      active: true,
      installationId: r1.installationId,
    });
    const all = await rows("fx-plugin-echo");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ trust: "production", state: "enabled", active: true });
  });

  it("rejects unsigned, wrongly signed and untrusted-publisher manifests; dev_trust is never reachable", async () => {
    const unsigned = makeManifest({
      pluginId: "fx-plugin-unsigned",
      version: "1.0.0",
      entrypoint: "unsigned.ts",
      sign: false,
    });
    expect(
      (
        await rejection(
          installPluginFromRoot(db.app, { root: FIXTURE_ROOT, trustedKeys: trusted, manifest: unsigned }),
        )
      ).reasonCode,
    ).toBe("SIGNATURE_MISSING_SIGNATURE");
    const other = generateSigningKeyPair();
    const base = makeManifest({
      pluginId: "fx-plugin-badsig",
      version: "1.0.0",
      entrypoint: "badsig.ts",
      sign: false,
    });
    const wrong = { ...base, signature: signManifest(base as PluginManifest, other.privateKey) };
    expect(
      (
        await rejection(
          installPluginFromRoot(db.app, { root: FIXTURE_ROOT, trustedKeys: trusted, manifest: wrong }),
        )
      ).reasonCode,
    ).toBe("SIGNATURE_INVALID_SIGNATURE");
    const good = makeManifest({ pluginId: "fx-plugin-badsig", version: "1.0.1", entrypoint: "badsig.ts" });
    expect(
      (
        await rejection(
          installPluginFromRoot(db.app, { root: FIXTURE_ROOT, trustedKeys: {}, manifest: good }),
        )
      ).reasonCode,
    ).toBe("SIGNATURE_UNTRUSTED_PUBLISHER");
    for (const id of ["fx-plugin-unsigned", "fx-plugin-badsig"]) expect(await rows(id)).toEqual([]);
  });

  it("a tampered entrypoint hash is rejected", async () => {
    const m = makeManifest({
      pluginId: "fx-plugin-tamper",
      version: "1.0.0",
      entrypoint: "echo-1.0.0.ts",
      mutate: (x) => (x.artifactSha256 = "0".repeat(64)),
    });
    expect(
      (
        await rejection(
          installPluginFromRoot(db.app, { root: FIXTURE_ROOT, trustedKeys: trusted, manifest: m }),
        )
      ).reasonCode,
    ).toBe("ARTIFACT_HASH_MISMATCH");
  });

  it("missing root and missing manifest file are reported, not thrown raw", async () => {
    expect(
      (
        await rejection(
          installPluginFromRoot(db.app, { root: join(FIXTURE_ROOT, "nope"), trustedKeys: trusted }),
        )
      ).reasonCode,
    ).toBe("PLUGIN_ROOT_MISSING");
    expect(() => readManifestFile(FIXTURE_ROOT)).toThrowError(/No signed manifest/);
  });
});

describe("loadTrustedKeys", () => {
  it("parses publisher keys and fails closed on malformed configuration", () => {
    expect(loadTrustedKeys({})).toEqual({});
    expect(loadTrustedKeys({ NEARESIS_PLUGIN_TRUSTED_KEYS: JSON.stringify({ p: ["a", "b"] }) })).toEqual({
      p: ["a", "b"],
    });
    for (const bad of [
      "not json",
      "[]",
      JSON.stringify({ p: [] }),
      JSON.stringify({ p: [1] }),
      JSON.stringify({ p: "k" }),
    ])
      expect(() => loadTrustedKeys({ NEARESIS_PLUGIN_TRUSTED_KEYS: bad })).toThrowError(KernelError);
  });
});

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const KERNEL_DIR = join(APP_ROOT, "packages", "kernel");
const NEAR_THESIS = join(APP_ROOT, "plugins", "near-thesis");

describe.skipIf(!existsSync(NEAR_THESIS))("plugin:install CLI with plugins/near-thesis", () => {
  const keys = generateSigningKeyPair();
  const run = (trustedKeys: Record<string, string[]>) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/plugins/install-cli.ts",
        "--",
        "--root",
        "plugins/near-thesis",
        "--build-manifest",
      ],
      {
        cwd: KERNEL_DIR,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          INIT_CWD: APP_ROOT,
          DATABASE_APP_URL: db.appUrl,
          NEARESIS_PLUGIN_TRUSTED_KEYS: JSON.stringify(trustedKeys),
          NEARESIS_PLUGIN_SIGNING_KEY: keys.privateKey,
          NEARESIS_PLUGIN_PUBLISHER: "nearesis",
          NODE_ENV: "test",
        },
      },
    );

  it("an untrusted signing key is rejected with a reason and no key material in output", () => {
    const r = run({ nearesis: [generateSigningKeyPair().publicKey] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("SIGNATURE_INVALID_SIGNATURE");
    expect(r.stdout + r.stderr).not.toContain(keys.privateKey);
  });

  it("installs near-thesis with production trust from trusted config, and re-running is a no-op", async () => {
    const r = run({ nearesis: [keys.publicKey] });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^installed: near-thesis@1\.0\.0 state=enabled active=true/);
    const all = await rows("near-thesis");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ trust: "production", state: "enabled", active: true });
    expect(all[0].manifest.capabilities.map((c: { id: string }) => c.id).sort()).toEqual([
      "canvas.preview@1",
      "semantic.discover@1",
      "semantic.query@1",
    ]);
    const again = run({ nearesis: [keys.publicKey] });
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/^already_installed: near-thesis@1\.0\.0/);
    expect(await rows("near-thesis")).toHaveLength(1);
    expect(r.stdout + r.stderr).not.toContain(keys.privateKey);
  }, 90_000);
});
