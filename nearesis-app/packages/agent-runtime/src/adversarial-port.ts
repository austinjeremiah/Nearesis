import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdversarialPort, ProtocolResult } from "./graphs/adversarial.ts";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Runs `nearesis_research.adversarial_cli` (real Python engine, frozen preregistration) as a child process. The request
 * goes in on stdin and nothing from it is a threshold or seed: the engine reads those from the frozen document.
 */
export class PythonAdversarialPort implements AdversarialPort {
  constructor(private readonly cwd: string = APP_ROOT) {}

  private run<T>(req: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const p = spawn("uv", ["run", "python", "-m", "nearesis_research.adversarial_cli"], {
        cwd: this.cwd,
        env: { ...process.env, PYTHONPATH: "services/research" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      p.stdout.on("data", (b) => (out += String(b)));
      p.stderr.on("data", (b) => (err += String(b)));
      p.on("error", reject);
      p.on("close", (code) => {
        if (code !== 0) return reject(new Error(`adversarial_cli exit ${code}: ${err.slice(-600)}`));
        try {
          resolve(JSON.parse(out.trim().split("\n").pop()!) as T);
        } catch (e) {
          reject(e);
        }
      });
      p.stdin.end(JSON.stringify(req));
    });
  }

  engine() {
    return this.run<{
      status: string;
      evidenceStrength: string;
      frozenDocumentHash: string;
      intact: boolean;
    }>({
      op: "engine",
    });
  }
  protocol(req: Parameters<AdversarialPort["protocol"]>[0]): Promise<ProtocolResult> {
    return this.run<ProtocolResult>({ op: "protocol", ...req });
  }
}
