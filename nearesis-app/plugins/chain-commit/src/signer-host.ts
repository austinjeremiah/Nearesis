import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Starts the signer process with an EMPTY environment. The key travels on stdin only. */
export async function startSigner(
  privateKeyPem: string,
): Promise<{ port: number; child: ChildProcess; stop(): void }> {
  const file = join(dirname(fileURLToPath(import.meta.url)), "signer-process.ts");
  const child = spawn(process.execPath, [file], { env: {}, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.end(Buffer.from(privateKeyPem, "utf8").toString("base64") + "\n");
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (c: Buffer) => {
      buf += c.toString("utf8");
      const m = /PORT (\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    child.once("exit", () => reject(new Error("signer exited before it was ready")));
    setTimeout(() => reject(new Error("signer start timeout")), 15_000).unref();
  });
  return { port, child, stop: () => child.kill("SIGKILL") };
}
