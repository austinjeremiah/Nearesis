import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Runs the real Python engine for one acceptance case and returns its measurements (JSON on stdout). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- measurement JSON is asserted field by field in each test
export function runCase(id: string, module = "accept_cases"): any {
  const r = spawnSync("uv", ["run", "python", "-m", `nearesis_research.${module}`, id], {
    cwd: APP_ROOT,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: "services/research" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`python case ${id} failed: ${(r.stderr ?? "").slice(-800)}`);
  const line = r.stdout.trim().split("\n").pop() as string;
  return JSON.parse(line);
}
