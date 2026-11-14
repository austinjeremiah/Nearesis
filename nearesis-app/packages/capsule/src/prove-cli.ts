/**
 * pnpm research:prove --capsule <id|dir> [--live] [--out <dir>] [--budget-near 0.01] [--resume-tx <hash>]
 *
 * Default (no --live): reproduces the capsule's computation locally under wasmtime and writes a proof labelled
 * "reproduced / not_requested". It submits nothing.
 * --live: submits the capsule's canonical input to the pinned WASM on OutLayer TESTNET (account majorlynx5104.testnet, key
 * from the repo-root .env, never printed), cost-gated as `outlayer_job`, fetches and verifies the TDX attestation under
 * the pinned policy and cross-checks it against the local run. Requires NEARESIS_ACCEPT_LIVE=1 as well.
 * Exit codes: 0 attested (or reproduced when not live), 3 not attested / not reproduced, 4 refused, 2 usage.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { SpendGate } from "@nearesis/contracts";
import type { OutlayerLivePolicy } from "./attest-outlayer.ts";
import { APP_ROOT, DEFAULT_WASM } from "./build.ts";
import { TestnetOutlayerChain } from "./outlayer-chain.ts";
import { ProveRefused, proveCapsule, type SpendEntry } from "./outlayer-prove.ts";
import { ROOT_ENV_FILE, appendSpendEntry } from "./prove-support.ts";

const { values: a } = parseArgs({
  args: process.argv.slice(2),
  options: {
    capsule: { type: "string" },
    live: { type: "boolean" },
    out: { type: "string" },
    "budget-near": { type: "string" },
    account: { type: "string" },
    "resume-tx": { type: "string" },
  },
});
const abs = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);
const ACCOUNT = a.account ?? "majorlynx5104.testnet";
const ROOT_ENV = ROOT_ENV_FILE;

/** A capsule directory, or an id that resolves to a published archive or a built directory. */
function resolveCapsule(spec: string): string {
  if (existsSync(join(abs(spec), "manifest.json"))) return abs(spec);
  const dirs = [join(APP_ROOT, ".data", "capsules", spec)];
  const pub = join(APP_ROOT, ".data", "published");
  if (existsSync(pub))
    for (const ch of readdirSync(pub))
      for (const v of readdirSync(join(pub, ch)).filter((n) => n.startsWith("v-"))) {
        const f = join(pub, ch, v, "research-capsules", `${spec}.tar.zst`);
        if (existsSync(f)) {
          const out = join(APP_ROOT, ".data", "proofs", "_capsules", spec);
          mkdirSync(out, { recursive: true });
          const r = spawnSync("sh", ["-c", `zstd -dc "${f}" | tar -xf - -C "${out}"`]);
          if (r.status !== 0) throw new Error("could not extract the capsule archive");
          return out;
        }
      }
  for (const d of dirs) if (existsSync(join(d, "manifest.json"))) return d;
  throw new Error(`capsule not found: ${spec}`);
}

async function main(): Promise<number> {
  if (!a.capsule) {
    console.error("usage: research:prove --capsule <id|dir> [--live] [--out <dir>] [--budget-near 0.01]");
    return 2;
  }
  const capsuleDir = resolveCapsule(a.capsule);
  const policy = JSON.parse(
    readFileSync(
      join(APP_ROOT, "services", "outlayer-verifier", "policy", "outlayer-live-policy.json"),
      "utf8",
    ),
  ) as OutlayerLivePolicy;
  const outDir = abs(a.out ?? join(APP_ROOT, ".data", "proofs"));
  let live;
  let closeGate: (() => Promise<void>) | undefined;
  if (a.live) {
    if (process.env.NEARESIS_ACCEPT_LIVE !== "1") {
      console.error("--live needs NEARESIS_ACCEPT_LIVE=1 (it spends testnet NEAR)");
      return 2;
    }
    const chain = new TestnetOutlayerChain({ account: ACCOUNT, envFile: ROOT_ENV });
    let gate: SpendGate | undefined;
    if (process.env.NEARESIS_COST_CONTROL === "1") {
      const mod = (await import("../../../services/ingestion/src/cost/ambient.ts")) as {
        installSpendGateFromEnv: () => Promise<{ gate: SpendGate; close: () => Promise<void> } | undefined>;
      };
      const g = await mod.installSpendGateFromEnv();
      gate = g?.gate;
      closeGate = g?.close;
    }
    const pending: Array<Promise<void>> = [];
    live = {
      chain,
      ...(gate ? { gate } : {}),
      ...(a["resume-tx"] ? { resume: { txHash: a["resume-tx"] } } : {}),
      budgetYocto: BigInt(Math.round(Number(a["budget-near"] ?? "0.01") * 1e6)) * 10n ** 18n,
      recordSpend: (e: SpendEntry) => {
        pending.push(appendSpendEntry(e, chain));
      },
    };
    try {
      const doc = await proveCapsule({ capsuleDir, wasmPath: DEFAULT_WASM, policy, outDir, live });
      await Promise.all(pending);
      console.log(JSON.stringify(doc, null, 2));
      return doc.labels.attestation === "attested" ? 0 : 3;
    } finally {
      await closeGate?.();
    }
  }
  const doc = await proveCapsule({ capsuleDir, wasmPath: DEFAULT_WASM, policy, outDir });
  console.log(JSON.stringify(doc, null, 2));
  return doc.labels.reproduction === "reproduced" ? 0 : 3;
}

try {
  process.exit(await main());
} catch (e) {
  if (e instanceof ProveRefused) {
    console.error(JSON.stringify({ status: "REFUSED", code: e.code, detail: e.message }));
    process.exit(4);
  }
  throw e;
}
