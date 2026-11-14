import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Read one variable from the nearest ancestor `.env` (server-side only). The value is never logged. */
export function loadEnvVar(name: string, startDir: string = process.cwd()): string | undefined {
  if (process.env[name]) return process.env[name];
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const f = join(dir, ".env");
    if (existsSync(f)) {
      const m = readFileSync(f, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
      if (m) {
        const v = m[1]!.trim().replace(/^["']|["']$/g, "");
        return v.length > 0 ? v : undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
