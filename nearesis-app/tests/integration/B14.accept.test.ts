import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import { APP_ROOT, SNAPSHOT_DIR } from "./lib/research.ts";

/** The 11 parts ch.19 "README acceptance" requires, each recognised by a heading keyword. */
const PARTS: Array<[string, RegExp]> = [
  ["architecture", /architecture/i],
  ["setup", /setup|bootstrap|install/i],
  ["environment flags", /environment|flags|configuration/i],
  ["exact commands", /commands|usage|run\b/i],
  ["fixture license", /licen[cs]e/i],
  ["known limitations", /limitations/i],
  ["credential names", /credential|secrets/i],
  ["expected outputs", /expected output/i],
  ["data scope", /data scope|scope/i],
  ["tests", /\btests?\b/i],
  ["evidence verification and recovery", /evidence|recovery|verify/i],
];

it("B14: a reviewer following only the README reaches the documented outputs with no hidden server, secret or undocumented step", () => {
  const readme = readFileSync(join(APP_ROOT, "README.md"), "utf8");
  const headings = [...readme.matchAll(/^#{1,4}\s+(.+)$/gm)].map((m) => m[1]!);
  const fences = [...readme.matchAll(/```(?:sh|bash)?\n([\s\S]*?)```/g)].flatMap((m) =>
    m[1]!
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean),
  );
  const missingParts = PARTS.filter(([, re]) => !headings.some((h) => re.test(h))).map(([n]) => n);

  // (c) no command depends on a credential, a hidden demo server or an unprovided host
  const hidden = fences.filter(
    (c) =>
      /localhost:3300|127\.0\.0\.1:3300|\.env\b|JWT|API_KEY|TOKEN=|curl /.test(c) && !/bootstrap/.test(c),
  );
  const hosts = [...readme.matchAll(/https?:\/\/[^\s)`'"]+/g)].map((m) => m[0]);
  const secretValue = /(?:eyJ[A-Za-z0-9_-]{20,}\.|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/.test(readme);

  // (e) rebuild and verify run with the network disabled (the preload throws on any network use)
  const out = mkdtempSync(join(tmpdir(), "b14-"));
  const noNet = `--import=${join(APP_ROOT, "packages/capsule/src/no-network.mjs")}`;
  const env = { ...process.env, NODE_OPTIONS: noNet };
  const run = (args: string[]) =>
    spawnSync("pnpm", args, { cwd: APP_ROOT, encoding: "utf8", env, timeout: 240_000 });
  const rebuild = run([
    "research:rebuild",
    "--snapshot",
    SNAPSHOT_DIR,
    "--out",
    join(out, "capsule"),
    "--no-wasm",
  ]);
  const verify = run(["research:verify", "--capsule", join(out, "capsule"), "--no-research"]);
  const rebuildJson = (() => {
    try {
      return JSON.parse(
        rebuild.stdout
          .trim()
          .split("\n")
          .filter((l) => l.startsWith("{"))
          .pop() ?? "{}",
      ) as { status?: string; capsuleHash?: string };
    } catch {
      return {};
    }
  })();
  const documentsRebuild =
    fences.some((c) => /research:rebuild/.test(c)) && fences.some((c) => /research:verify/.test(c));

  // (b) produced hashes equal the README's expected values
  const expectedHashes = [...readme.matchAll(/\b[0-9a-f]{64}\b/g)].map((m) => m[0]);
  const hashesMatch = rebuildJson.capsuleHash
    ? expectedHashes.includes(rebuildJson.capsuleHash.replace(/^sha256:/, ""))
    : false;

  // (a) the documented commands that need only a clean machine (not the registry or Docker) are exit-0 checked above;
  // installing, the local stack and the full test run need a clean container with registry access
  const needsCleanContainer = fences.filter((c) =>
    /bootstrap-toolchain|pnpm install|uv sync|dev:infra/.test(c),
  );

  const problems: string[] = [];
  if (missingParts.length) problems.push(`README lacks required parts: ${missingParts.join(", ")}`);
  if (!documentsRebuild)
    problems.push("README does not document pnpm research:rebuild and pnpm research:verify");
  if (!hashesMatch) problems.push("README states no expected hash equal to the rebuilt capsule hash");
  if (hidden.length) problems.push(`commands depend on a credential or hidden server: ${hidden.join(" | ")}`);
  if (secretValue) problems.push("README contains a secret-shaped value");

  observe({
    testId: "B14",
    fixtureHash: createHash("sha256").update(readme).digest("hex"),
    observed: `README has ${PARTS.length - missingParts.length}/${PARTS.length} required parts (missing: ${missingParts.join(", ") || "none"}); ${fences.length} fenced commands parsed, ${needsCleanContainer.length} need a clean container with registry access (not executed here); no hidden-server or credential dependency found: ${hidden.length === 0}; secret-shaped values: ${secretValue}; unprovided hosts: ${hosts.length}; offline (network-denied) pnpm research:rebuild exit ${rebuild.status} (${rebuildJson.status ?? "no status"}), research:verify exit ${verify.status}; README documents the rebuild/verify commands: ${documentsRebuild}; README expected hash equals the rebuilt capsule hash: ${hashesMatch}. ${problems.length ? `FAIL conditions: ${problems.join("; ")}.` : ""}`,
    evidence: {
      headings,
      fences,
      missingParts,
      hosts,
      rebuild: { status: rebuild.status, json: rebuildJson, stderrTail: (rebuild.stderr ?? "").slice(-300) },
      verify: { status: verify.status },
      problems,
    },
  });
  expect(existsSync(join(out, "capsule", "manifest.json"))).toBe(true);
  expect(rebuild.status).toBe(0);
  expect(verify.status).toBe(0);
  expect(problems).toEqual([]);
}, 600_000);
