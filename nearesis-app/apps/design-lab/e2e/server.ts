import { type ChildProcess, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ORIGIN = "http://127.0.0.1:3400";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function up(): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection({ host: "127.0.0.1", port: 3400 });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });
}
const run = (args: string[]) =>
  new Promise<void>((res, rej) => {
    const c = spawn("pnpm", args, { cwd: root, stdio: "inherit" });
    c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`pnpm ${args.join(" ")} exited ${code}`))));
  });

/**
 * Serves the PRODUCTION build (the C18 reference environment is a production build) on 127.0.0.1:3400. If something is
 * already listening it is used as is. Returns a stop function.
 */
export async function ensureServer(): Promise<() => void> {
  if (await up()) return () => undefined;
  await run(["exec", "vite", "build"]);
  const child: ChildProcess = spawn(
    "pnpm",
    ["exec", "vite", "preview", "--host", "127.0.0.1", "--port", "3400", "--strictPort"],
    { cwd: root, stdio: "ignore" },
  );
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 250));
  if (!(await up())) throw new Error("preview server did not start");
  return () => child.kill();
}
