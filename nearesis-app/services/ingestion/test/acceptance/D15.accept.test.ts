import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import { fixtureHash } from "@nearesis/test-fixtures";
import { expect, it } from "vitest";

const ID = "fx.snapshot.p02-baseline";
const PKG = join(import.meta.dirname, "..", "..");
const CRED = [
  "INTENTS_EXPLORER_JWT",
  "INTENTS_1CLICK_JWT",
  "COINGECKO_API_KEY",
  "NEAR_AI_API_KEY",
  "OUTLAYER_PAYMENT_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "CLOUDSDK_CONFIG",
  "CLOUDSDK_CORE_PROJECT",
];

function sanitizedEnv(home: string, report: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!CRED.includes(k) && !/^(GOOGLE_|GCLOUD_|CLOUDSDK_)/.test(k)) env[k] = v;
  env.HOME = home; // hides gcloud ADC (~/.config/gcloud)
  env.NEARESIS_EGRESS_REPORT = report;
  return env;
}

// D15: Credential-free offline fixture replay of the whole acquisition layer
it("replays the full snapshot with no credentials, no egress, and the manifest digest", () => {
  const home = mkdtempSync(join(tmpdir(), "d15-home-"));
  const report = join(home, "egress.json");
  const deny = join(PKG, "src", "testing", "deny-egress.ts");
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", deny, "src/cli/replay.ts", "--snapshot", ID],
    { cwd: PKG, encoding: "utf8", env: sanitizedEnv(home, report) },
  );
  expect(run.status).toBe(0); // (a)
  const egress = JSON.parse(readFileSync(report, "utf8")) as { attempts: number; calls: string[] };
  expect(egress.attempts).toBe(0); // (b)
  const out = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as {
    digest: string;
    expectedDigest: string;
    digestMatches: boolean;
    manifestSha256: string;
    adapterModes: Record<string, string>;
    credentialReads: number;
    labelledRows: number;
    unlabelledRows: number;
    rowCounts: Record<string, number>;
  };
  expect(Object.keys(out.adapterModes).sort()).toEqual([
    "coingecko",
    "intents-1click",
    "near-bigquery",
    "near-contract-registry",
    "near-explorer",
  ]);
  expect(Object.values(out.adapterModes).every((m) => m === "replay")).toBe(true); // (c)
  expect(out.digestMatches).toBe(true); // (d)
  expect(out.digest).toBe(out.expectedDigest);
  expect(out.credentialReads).toBe(0); // (e)
  for (const k of CRED) expect(sanitizedEnv(home, report)[k]).toBeUndefined();

  // (c) every labelled table row carries SYNTHETIC or RECORDED
  const labels = { bad: out.unlabelledRows, total: out.labelledRows };
  expect(labels.bad).toBe(0);
  expect(labels.total).toBeGreaterThan(50);

  // control: the interceptor really denies and counts attempts
  const ctl = join(home, "control.mts");
  writeFileSync(
    ctl,
    `try { await fetch("https://example.com/"); } catch {}\nimport net from "node:net"; try { net.connect(80, "127.0.0.1"); } catch {}`,
  );
  const c = spawnSync(process.execPath, ["--import", "tsx", "--import", deny, ctl], {
    cwd: PKG,
    encoding: "utf8",
    env: sanitizedEnv(home, join(home, "e3.json")),
  });
  const cr = JSON.parse(readFileSync(join(home, "e3.json"), "utf8")) as { attempts: number };
  expect(cr.attempts).toBe(2);
  expect(c.status).not.toBe(0);

  observe({
    testId: "D15",
    observed: `child replay of ${ID} with all credential env vars unset, HOME isolated and deny-all egress interceptor: exit 0, attempted connections 0, adapters all mode=replay, ${labels.total} labelled rows (0 unlabelled), digest ${out.digest} == manifest, credential reads 0; control run proved the interceptor counts attempts (2)`,
    fixtureHash: fixtureHash(ID),
    evidence: {
      exitCode: run.status,
      egressAttempts: egress.attempts,
      adapterModes: out.adapterModes,
      digest: out.digest,
      manifestSha256: out.manifestSha256,
      credentialReads: out.credentialReads,
      labelledRows: labels.total,
      interceptorControlAttempts: cr.attempts,
    },
  });
}, 120_000);
