import { X509Certificate, createHash, createPublicKey, verify } from "node:crypto";
import type { QuoteVerifier } from "./attestation.ts";

/**
 * Intel TDX quote verification (DCAP quote format version 4, ECDSA-256-with-P-256).
 *
 * Layout (Intel "TDX DCAP Quote Generation Library and Quote Verification Library", quote v4):
 *   Header (48 bytes): version u16 (=4), attestationKeyType u16 (=2, ECDSA-256-P256), teeType u32 (=0x81, TDX),
 *     qeSvn u16, pceSvn u16, qeVendorId[16], userData[20].
 *   TD Report body (584 bytes): teeTcbSvn[16], mrSeam[48], mrSignerSeam[48], seamAttributes[8], tdAttributes[8],
 *     xfam[8], mrTd[48], mrConfigId[48], mrOwner[48], mrOwnerConfig[48], rtmr0..3[4*48], reportData[64].
 *   sigDataLen u32, then signature data: ecdsaSignature[64] (r||s), attestationPublicKey[64] (x||y), certDataType u16
 *     (=6, QE report certification data), certDataSize u32, then QE report certification data: qeReport[384],
 *     qeReportSignature[64], qeAuthDataSize u16, qeAuthData[n], inner certDataType u16 (=5, PCK certificate chain,
 *     PEM), inner certDataSize u32, PEM chain (leaf PCK, intermediate, root).
 *
 * Checks performed here, in order:
 *   1. structure and sizes (truncation or trailing garbage is `QUOTE_MALFORMED`)
 *   2. version, key type, TEE type
 *   3. TD attributes DEBUG bit (bit 0) must be clear
 *   4. ECDSA(attestation key) over header||body
 *   5. QE report data binds the attestation key: sha256(attKey || qeAuthData) == qeReport.reportData[0..32]
 *   6. ECDSA(PCK leaf key) over the QE report
 *   7. certificate chain leaf -> intermediate -> root, each signature and validity period, and the root's SHA-256 is
 *      pinned by the caller
 *
 * NOT checked (no collateral is fetched; this verifier performs no network access): TCB level and QE identity from
 * Intel PCS collateral, certificate revocation lists. Every result carries `collateralChecked: false` so no caller can
 * present it as a full DCAP verification.
 */
export const TDX_HEADER_BYTES = 48;
export const TDX_BODY_BYTES = 584;
const QE_REPORT_BYTES = 384;

export interface TdxQuoteFields {
  version: number;
  teeType: number;
  mrTd: string;
  mrConfigId: string;
  rtmr: string[];
  tdAttributes: string;
  debug: boolean;
  reportData: string;
  rootSha256: string;
}

export type TdxReason =
  | "QUOTE_MALFORMED"
  | "QUOTE_UNSUPPORTED"
  | "QUOTE_DEBUG_MODE"
  | "QUOTE_SIGNATURE_INVALID"
  | "QUOTE_QE_BINDING_INVALID"
  | "QUOTE_QE_SIGNATURE_INVALID"
  | "QUOTE_CERT_CHAIN_INVALID"
  | "QUOTE_ROOT_NOT_TRUSTED";

export type TdxVerification =
  | { ok: true; fields: TdxQuoteFields; collateralChecked: false }
  | { ok: false; reason: TdxReason; detail: string; fields?: TdxQuoteFields; collateralChecked: false };

const P256_SPKI_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
const hex = (b: Buffer): string => b.toString("hex");

class Malformed extends Error {}

class Reader {
  constructor(
    private readonly b: Buffer,
    public pos = 0,
  ) {}
  take(n: number): Buffer {
    if (!Number.isInteger(n) || n < 0 || this.pos + n > this.b.length) throw new Malformed("truncated");
    const r = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return r;
  }
  u16(): number {
    return this.take(2).readUInt16LE();
  }
  u32(): number {
    return this.take(4).readUInt32LE();
  }
  get rest(): number {
    return this.b.length - this.pos;
  }
}

export function verifyTdxQuote(
  quote: Uint8Array | string,
  opts: { trustedRootSha256: string[]; now?: Date },
): TdxVerification {
  const fail = (reason: TdxReason, detail: string, fields?: TdxQuoteFields): TdxVerification => ({
    ok: false,
    reason,
    detail,
    ...(fields ? { fields } : {}),
    collateralChecked: false,
  });
  let buf: Buffer;
  try {
    buf = typeof quote === "string" ? Buffer.from(quote, "base64") : Buffer.from(quote);
  } catch {
    return fail("QUOTE_MALFORMED", "not decodable");
  }
  let r: Reader;
  let headerBody: Buffer;
  let sig: Buffer;
  let attKey: Buffer;
  let qeReport: Buffer;
  let qeSig: Buffer;
  let qeAuth: Buffer;
  let pem: string;
  let version: number;
  let keyType: number;
  let teeType: number;
  let body: Buffer;
  try {
    r = new Reader(buf);
    const header = r.take(TDX_HEADER_BYTES);
    version = header.readUInt16LE(0);
    keyType = header.readUInt16LE(2);
    teeType = header.readUInt32LE(4);
    body = r.take(TDX_BODY_BYTES);
    headerBody = Buffer.concat([header, body]);
    const sigLen = r.u32();
    // A real quote buffer may carry all-zero padding after the signature data (observed on a live OutLayer testnet
    // quote: 70 zero bytes). Padding is tolerated only when every extra byte is zero; any other trailing byte is malformed.
    if (sigLen > r.rest) throw new Malformed("signature data length does not match the remaining bytes");
    if (buf.subarray(r.pos + sigLen).some((x) => x !== 0))
      throw new Malformed("non-zero bytes after the signature data");
    buf = buf.subarray(0, r.pos + sigLen);
    r = new Reader(buf, r.pos);
    sig = r.take(64);
    attKey = r.take(64);
    const certType = r.u16();
    const certSize = r.u32();
    if (certSize !== r.rest) throw new Malformed("certification data length mismatch");
    if (certType !== 6) throw new Malformed("unsupported certification data type");
    qeReport = r.take(QE_REPORT_BYTES);
    qeSig = r.take(64);
    qeAuth = r.take(r.u16());
    const innerType = r.u16();
    const innerSize = r.u32();
    if (innerType !== 5 || innerSize !== r.rest) throw new Malformed("inner certification data malformed");
    pem = r.take(innerSize).toString("utf8").replace(/\0+$/, "");
  } catch (e) {
    return fail("QUOTE_MALFORMED", e instanceof Malformed ? e.message : "unparseable");
  }
  if (version !== 4 || keyType !== 2 || teeType !== 0x81)
    return fail(
      "QUOTE_UNSUPPORTED",
      `version ${String(version)}, key type ${String(keyType)}, tee ${String(teeType)}`,
    );

  const off = { tdAttributes: 16 + 48 + 48 + 8, mrTd: 16 + 48 + 48 + 8 + 8 + 8 };
  const tdAttr = body.subarray(off.tdAttributes, off.tdAttributes + 8);
  const mrTd = body.subarray(off.mrTd, off.mrTd + 48);
  const mrConfigId = body.subarray(off.mrTd + 48, off.mrTd + 96);
  const rtmrStart = off.mrTd + 48 * 4;
  const rtmr = [0, 1, 2, 3].map((i) => hex(body.subarray(rtmrStart + 48 * i, rtmrStart + 48 * (i + 1))));
  const reportData = body.subarray(TDX_BODY_BYTES - 64);

  let certs: X509Certificate[] = [];
  let chainError: string | null = null;
  try {
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    certs = blocks.map((p) => new X509Certificate(p));
    if (certs.length < 2) chainError = "PCK chain needs a leaf, at least one issuer and a root";
  } catch {
    chainError = "PCK chain is not valid PEM certificates";
  }
  const root = certs[certs.length - 1];
  const fields: TdxQuoteFields = {
    version,
    teeType,
    mrTd: hex(mrTd),
    mrConfigId: hex(mrConfigId),
    rtmr,
    tdAttributes: hex(tdAttr),
    debug: (tdAttr[0]! & 1) === 1,
    reportData: hex(reportData),
    rootSha256: root ? createHash("sha256").update(root.raw).digest("hex") : "",
  };

  // 3. debug TD
  if (fields.debug) return fail("QUOTE_DEBUG_MODE", "TD attributes DEBUG bit is set", fields);

  // 4. quote signature by the attestation key
  const attPub = createPublicKey({
    key: Buffer.concat([P256_SPKI_PREFIX, Buffer.from([0x04]), attKey]),
    format: "der",
    type: "spki",
  });
  let okSig: boolean;
  try {
    okSig = verify("sha256", headerBody, { key: attPub, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    okSig = false;
  }
  if (!okSig)
    return fail("QUOTE_SIGNATURE_INVALID", "ECDSA signature by the attestation key is invalid", fields);

  // 5. QE report binds the attestation key
  const bind = createHash("sha256").update(attKey).update(qeAuth).digest();
  if (!qeReport.subarray(QE_REPORT_BYTES - 64, QE_REPORT_BYTES - 32).equals(bind))
    return fail("QUOTE_QE_BINDING_INVALID", "QE report data does not bind the attestation key", fields);

  // 6/7. certificate chain, then the QE report signature by the PCK leaf
  if (chainError) return fail("QUOTE_CERT_CHAIN_INVALID", chainError, fields);
  const now = opts.now ?? new Date();
  try {
    for (let i = 0; i < certs.length; i++) {
      const c = certs[i]!;
      if (now < new Date(c.validFrom) || now > new Date(c.validTo))
        throw new Error("certificate not valid now");
      const issuer = i + 1 < certs.length ? certs[i + 1]! : c;
      if (!c.verify(issuer.publicKey)) throw new Error("certificate signature does not verify");
      if (c.issuer !== issuer.subject) throw new Error("issuer name mismatch");
    }
  } catch (e) {
    return fail("QUOTE_CERT_CHAIN_INVALID", (e as Error).message, fields);
  }
  let okQe: boolean;
  try {
    okQe = verify("sha256", qeReport, { key: certs[0]!.publicKey, dsaEncoding: "ieee-p1363" }, qeSig);
  } catch {
    okQe = false;
  }
  if (!okQe)
    return fail("QUOTE_QE_SIGNATURE_INVALID", "QE report signature by the PCK key is invalid", fields);
  if (!opts.trustedRootSha256.includes(fields.rootSha256))
    return fail("QUOTE_ROOT_NOT_TRUSTED", "chain root is not pinned", fields);
  return { ok: true, fields, collateralChecked: false };
}

export interface TdxVerifierRoots {
  /** SHA-256 (hex) of pinned production root certificate DER. A quote chained to one of these may be `live`. */
  production: string[];
  /** Roots minted by a test. A quote chained to one of these is always `fixture` evidence. */
  fixture?: string[];
  now?: () => Date;
}

/**
 * QuoteVerifier for the proof policy. `rootKind` tells the caller which kind of root the quote chained to, which is the
 * only way evidence can be `live`; evidence can never self-declare it.
 */
export function createTdxQuoteVerifier(roots: TdxVerifierRoots): QuoteVerifier {
  return {
    verifyQuote(e) {
      if (e.quote === null) return { ok: false, reason: "QUOTE_MALFORMED" };
      const r = verifyTdxQuote(e.quote, {
        trustedRootSha256: [...roots.production, ...(roots.fixture ?? [])],
        ...(roots.now ? { now: roots.now() } : {}),
      });
      if (!r.ok) return { ok: false, reason: r.reason, ...(r.fields ? { quote: r.fields } : {}) };
      return {
        ok: true,
        quote: r.fields,
        rootKind: roots.production.includes(r.fields.rootSha256) ? "production" : "fixture",
      };
    },
  };
}
