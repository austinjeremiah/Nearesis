import {
  X509Certificate,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttestationEvidence } from "@nearesis/contracts";
import { attestationPayload, sha256Hex } from "../src/index.ts";
import type { testSigner } from "./helpers.ts";
import { makeEvidence } from "./helpers.ts";

/**
 * TEST-ONLY trust root and TDX quote minting. The PKI is generated locally with openssl, the quotes follow the real DCAP
 * v4 layout (see src/tdx.ts), and the whole thing is labelled fixture evidence: it chains to a root that is not Intel's.
 */
export interface FixturePki {
  chainPem: string;
  leafKey: KeyObject;
  rootSha256: string;
}

let cached: FixturePki | null = null;

function openssl(args: string[], cwd: string): void {
  const r = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr.slice(0, 200)}`);
}

export function fixturePki(): FixturePki {
  if (cached) return cached;
  const d = mkdtempSync(join(tmpdir(), "tdx-pki-"));
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  openssl(
    [
      "req",
      "-x509",
      ...ec,
      "-keyout",
      "root.key",
      "-out",
      "root.pem",
      "-subj",
      "/CN=Nearesis Test Root (fixture)",
      "-days",
      "3650",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-sha256",
    ],
    d,
  );
  writeFileSync(join(d, "ext.cnf"), "basicConstraints=critical,CA:TRUE\n");
  openssl(
    [
      "req",
      "-new",
      ...ec,
      "-keyout",
      "int.key",
      "-out",
      "int.csr",
      "-subj",
      "/CN=Nearesis Test Intermediate (fixture)",
    ],
    d,
  );
  openssl(
    [
      "x509",
      "-req",
      "-in",
      "int.csr",
      "-CA",
      "root.pem",
      "-CAkey",
      "root.key",
      "-CAcreateserial",
      "-out",
      "int.pem",
      "-days",
      "3650",
      "-extfile",
      "ext.cnf",
      "-sha256",
    ],
    d,
  );
  openssl(
    [
      "req",
      "-new",
      ...ec,
      "-keyout",
      "leaf.key",
      "-out",
      "leaf.csr",
      "-subj",
      "/CN=Nearesis Test PCK (fixture)",
    ],
    d,
  );
  openssl(
    [
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "int.pem",
      "-CAkey",
      "int.key",
      "-CAcreateserial",
      "-out",
      "leaf.pem",
      "-days",
      "3650",
      "-sha256",
    ],
    d,
  );
  const rd = (n: string) => readFileSync(join(d, n), "utf8");
  cached = {
    chainPem: `${rd("leaf.pem")}${rd("int.pem")}${rd("root.pem")}`,
    leafKey: createPrivateKey(rd("leaf.key")),
    rootSha256: createHash("sha256")
      .update(new X509Certificate(rd("root.pem")).raw)
      .digest("hex"),
  };
  return cached;
}

export const MRTD_GOOD = "ab".repeat(48);
export const MRTD_OTHER = "cd".repeat(48);

export interface QuoteOptions {
  pki?: FixturePki;
  mrTd?: string;
  debug?: boolean;
  /** 64 bytes of report data; default zeros. */
  reportData?: Buffer;
  /** Corrupt a byte of the quote signature after signing. */
  badQuoteSignature?: boolean;
}

export function mintTdxQuote(o: QuoteOptions = {}): Buffer {
  const pki = o.pki ?? fixturePki();
  const header = Buffer.alloc(48);
  header.writeUInt16LE(4, 0);
  header.writeUInt16LE(2, 2);
  header.writeUInt32LE(0x81, 4);
  const body = Buffer.alloc(584);
  if (o.debug) body[16 + 48 + 48 + 8] = 1;
  Buffer.from(o.mrTd ?? MRTD_GOOD, "hex").copy(body, 16 + 48 + 48 + 8 + 8 + 8);
  (o.reportData ?? Buffer.alloc(64)).copy(body, 584 - 64);
  const att = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = att.publicKey.export({ format: "jwk" });
  const attKey = Buffer.concat([Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  const sig = sign("sha256", Buffer.concat([header, body]), {
    key: att.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  if (o.badQuoteSignature) sig[0] = sig[0]! ^ 0xff;
  const qeAuth = randomBytes(32);
  const qeReport = Buffer.alloc(384);
  createHash("sha256")
    .update(attKey)
    .update(qeAuth)
    .digest()
    .copy(qeReport, 384 - 64);
  const qeSig = sign("sha256", qeReport, { key: pki.leafKey, dsaEncoding: "ieee-p1363" });
  const u16 = (n: number) => Buffer.from([n & 255, n >> 8]);
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const pem = Buffer.from(pki.chainPem, "utf8");
  const inner = Buffer.concat([u16(5), u32(pem.length), pem]);
  const certData = Buffer.concat([qeReport, qeSig, u16(qeAuth.length), qeAuth, inner]);
  const sigData = Buffer.concat([sig, attKey, u16(6), u32(certData.length), certData]);
  return Buffer.concat([header, body, u32(sigData.length), sigData]);
}

/** OutLayer-shaped evidence: a fixture TDX quote bound to the attestation payload. All other fields are valid. */
export function mintOutlayerEvidence(
  s: ReturnType<typeof testSigner>,
  io: { wasmSha256: string; inputSha256: string; outputSha256: string },
  o: {
    jobId?: string;
    at?: Date;
    quote?: QuoteOptions;
    bindToPayload?: boolean;
    truncateQuote?: number;
  } = {},
): AttestationEvidence {
  const base = makeEvidence(
    s,
    { provenance: "outlayer", network: "testnet", jobId: o.jobId ?? "fixture-job-1", ...io },
    o.at,
  );
  const reportData = Buffer.alloc(64);
  if (o.bindToPayload !== false) Buffer.from(sha256Hex(attestationPayload(base)), "hex").copy(reportData, 0);
  let q = mintTdxQuote({ ...(o.quote ?? {}), reportData });
  if (o.truncateQuote !== undefined) q = q.subarray(0, o.truncateQuote);
  return { ...base, quote: q.toString("base64") };
}
