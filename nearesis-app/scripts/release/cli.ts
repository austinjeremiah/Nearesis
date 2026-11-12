/**
 * Release tooling CLI (read-only, offline).
 *   tsx scripts/release/cli.ts manifest [--out DIR]   build manifest, rollback manifest and SBOM record; print validation problems
 *   tsx scripts/release/cli.ts check FILE              validate a manifest file
 *   tsx scripts/release/cli.ts build-images --label L [--ref REF] [--no-cache]   build api, worker, web locally from a clean export (never pushed)
 *   tsx scripts/release/cli.ts promote --label L                                  point the local `live` tags at that build
 *   tsx scripts/release/cli.ts preflight --network testnet|mainnet --contract C --method M --payload HEX64 --signer S --max-cost N --fee-ceiling N --balance-ceiling N
 *       read-only dry pre-flight (chain id read from the RPC, balance, fee estimate, on-chain readback of the payload); never signs or broadcasts
 *   tsx scripts/release/cli.ts approval-request ...                                exact-scope approval request for the owner to sign off (see MAINNET-CHECKLIST)
 *   tsx scripts/release/cli.ts rollback --manifest F --rollback F [--dry-run]     verify then move `live` to the previous release
 * There is no `release` or `broadcast` command: signing and writes are human-only.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, validateManifest, validateRollback } from "./manifest.ts";
import type { ReleaseManifest, RollbackManifest } from "./manifest.ts";
import { readSec11Sbom } from "./sbom.ts";
import { buildImages, readBuildRecord, realRun, writeSbom } from "./images.ts";
import type { BuildRecord, ImageName } from "./images.ts";
import { promote, rollback } from "./rollback.ts";
import { actionHash } from "./approval.ts";
import { LivePreflightChain } from "./near-live-chain.ts";
import { runRelease, Ledger } from "./release.ts";
import { ApprovalStore } from "./approval.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "manifest") {
  const out = rest[rest.indexOf("--out") + 1] ?? join(root, ".data", "release");
  const sbom = readSec11Sbom(root);
  const { manifest, rollback } = buildManifest({
    root,
    sbomSha256: sbom?.sbomSha256 ?? null,
    expectedMaxSpend: "0.05 NEAR",
    balanceCeiling: "10",
    feeCeiling: "1",
  });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "release-manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(out, "rollback-manifest.json"), JSON.stringify(rollback, null, 2));
  writeFileSync(
    join(out, "sbom-record.json"),
    JSON.stringify(sbom ?? { sbomSha256: null, note: "SEC11 evidence not found" }, null, 2),
  );
  console.log(
    JSON.stringify(
      { out, problems: [...validateManifest({ ...manifest }), ...validateRollback(rollback, manifest)] },
      null,
      2,
    ),
  );
} else if (cmd === "check") {
  const m = JSON.parse(readFileSync(rest[0]!, "utf8")) as ReleaseManifest;
  const p = validateManifest({ ...m });
  console.log(JSON.stringify(p, null, 2));
  process.exit(p.length ? 1 : 0);
} else if (cmd === "build-images") {
  const flag = (n: string) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : undefined);
  const label = flag("label") ?? "candidate";
  const rec = buildImages({
    repoRoot: resolve(root, ".."),
    appDir: "nearesis-app",
    ref: flag("ref") ?? "HEAD",
    label,
    outDir: join(root, ".data", "release", label),
    noCache: rest.includes("--no-cache"),
  });
  console.log(
    JSON.stringify(
      {
        label,
        gitSha: rec.gitSha,
        images: Object.fromEntries(Object.entries(rec.images).map(([k, v]) => [k, v.digest])),
        sbom: rec.sbom,
        vulnerabilityScan: rec.vulnerabilityScan,
      },
      null,
      2,
    ),
  );
} else if (cmd === "preflight" || cmd === "approval-request") {
  const flag = (n: string) => {
    const v = rest[rest.indexOf(`--${n}`) + 1];
    if (!rest.includes(`--${n}`) || v === undefined) throw new Error(`missing --${n}`);
    return v;
  };
  const network = flag("network") as "testnet" | "mainnet";
  if (network !== "testnet" && network !== "mainnet") throw new Error("--network must be testnet or mainnet");
  const scope = {
    network,
    contract: flag("contract"),
    method: flag("method"),
    payloadHash: flag("payload"),
    maxCost: flag("max-cost"),
    signer: flag("signer"),
    feeCeiling: flag("fee-ceiling"),
  };
  if (cmd === "approval-request") {
    const req = {
      kind: "approval-request",
      scope,
      actionHash: actionHash(scope),
      note: "The owner approves exactly this scope by recording issuer, expiry and a signature outside this tool. Any change to any field changes actionHash and invalidates the approval.",
    };
    const out = join(root, ".data", "release", `approval-request-${network}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(req, null, 2) + "\n");
    console.log(JSON.stringify({ out, actionHash: req.actionHash }, null, 2));
  } else {
    const chain = new LivePreflightChain(network);
    const pol = {
      expectedChainId: { sandbox: "sandbox", testnet: "testnet", mainnet: "mainnet" },
      allowlist: { contracts: [scope.contract], methods: [scope.method] },
      balanceCeiling: BigInt(flag("balance-ceiling")),
      feeCeiling: BigInt(scope.feeCeiling),
      signer: scope.signer,
      approvalRequiredOn: [],
      intentWindow: 0,
    };
    // A dry run never consumes an approval and the live adapter has no write path; the approval gate itself is not exercised here.
    const approvals = new ApprovalStore([], { now: () => Date.now() });
    const res = await runRelease(
      {
        chain,
        approvals,
        ledger: new Ledger(join(root, ".data", "release", "preflight-ledger.json")),
        policy: pol,
      },
      {
        network,
        contract: scope.contract,
        method: scope.method,
        payloadHash: scope.payloadHash,
        maxCost: scope.maxCost,
        mode: "dry-run",
      },
    );
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.status === "DRY_RUN_OK" ? 0 : 1);
  }
} else if (cmd === "sbom") {
  const label = rest[rest.indexOf("--label") + 1] ?? "candidate";
  const dir = join(root, ".data", "release", label);
  const rec = readBuildRecord(dir) as BuildRecord;
  rec.sbom = writeSbom(realRun, resolve(root, ".."), "nearesis-app", rec, dir);
  writeFileSync(join(dir, "build-record.json"), JSON.stringify(rec, null, 2) + "\n");
  console.log(JSON.stringify(rec.sbom, null, 2));
} else if (cmd === "promote") {
  const label = rest[rest.indexOf("--label") + 1] ?? "candidate";
  const rec = readBuildRecord(join(root, ".data", "release", label)) as BuildRecord;
  const images = Object.fromEntries(Object.entries(rec.images).map(([k, v]) => [k, v.digest])) as Record<
    ImageName,
    string
  >;
  console.log(JSON.stringify(promote(realRun, images), null, 2));
} else if (cmd === "rollback") {
  const flag = (n: string) => rest[rest.indexOf(`--${n}`) + 1]!;
  const res = rollback({
    current: JSON.parse(readFileSync(flag("manifest"), "utf8")) as ReleaseManifest,
    rollback: JSON.parse(readFileSync(flag("rollback"), "utf8")) as RollbackManifest,
    dryRun: rest.includes("--dry-run"),
  });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.applied || res.dryRun ? (res.plan.ok ? 0 : 1) : 1);
} else {
  console.error("usage: cli.ts manifest [--out DIR] | check FILE | build-images | promote | rollback");
  process.exit(2);
}
