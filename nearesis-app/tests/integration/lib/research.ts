import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const run = (args: string[]) => {
  const r = spawnSync("uv", ["run", "python", ...args], {
    cwd: APP_ROOT,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: "services/research" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`research engine failed: ${(r.stderr ?? "").slice(-600)}`);
  return r.stdout.trim();
};

/** The preregistration the engine will evaluate (frozen hash of the exact document). */
export function preregistrationHash(seed = 20261111): string {
  return run([
    "-c",
    `from nearesis_research.prereg import default_prereg, prereg_hash; print(prereg_hash(default_prereg(${seed})))`,
  ]);
}

/** The single final evaluation (real engine on the synthetic fixture); returns the bundle directory. */
export function evaluate(out: string, fixture: "signal" | "nosignal" = "signal", seed = 20261111) {
  const line = run([
    "-m",
    "nearesis_research.cli",
    "run",
    "--fixture",
    fixture,
    "--seed",
    String(seed),
    "--out",
    out,
  ])
    .split("\n")
    .pop()!;
  const meta = JSON.parse(line) as { status: string; evidenceStrength: string; narrative: string };
  const artifact = JSON.parse(readFileSync(join(out, "research_run.json"), "utf8")) as Record<
    string,
    unknown
  >;
  return { meta, artifact };
}

export const SNAPSHOT_DIR = join(APP_ROOT, "packages/capsule/fixtures/snapshot-synthetic");

/** The frozen Q18 sign-flip rule, evaluated by the research engine itself (robustness.apply_sign_flip_rule). */
export function signFlipRule(primaryDelta: number, variantDelta: number, status = "SUPPORTED") {
  const rows = JSON.stringify({
    top_1pct_accounts_removed: { status: "OK", estimates: [{ name: "all", delta_mae: variantDelta }] },
  });
  const out = run([
    "-c",
    `import json; from nearesis_research.robustness import apply_sign_flip_rule as r; print(json.dumps(r(${primaryDelta}, json.loads('${rows}'), '${status}')))`,
  ]);
  return JSON.parse(out.split("\n").pop()!) as {
    flips: string[];
    headlineBefore: string;
    headlineAfter: string;
  };
}
