import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import type { TdxQuoteVerifier } from "@nearai/inference-sdk";
import type { StructuredResult } from "@nearesis/contracts";
import type { NearAiEvidence, NearAiVerificationPolicy } from "../../src/index.ts";

const RUNTIME_EVENT = 134217729;
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const sha384 = (b: Uint8Array) => createHash("sha384").update(b).digest();

export interface Fixture {
  result: StructuredResult<{ answer: string }>;
  evidence: NearAiEvidence;
  policy: NearAiVerificationPolicy;
  now: number;
  composeHashHex: string;
  osImageHex: string;
  quoteVerifier: (opts?: { debug?: boolean; tcb?: string }) => TdxQuoteVerifier;
  signer: { privateKey: KeyObject; addressHex: string };
}

function rawEd25519Public(pub: KeyObject): Buffer {
  return Buffer.from(pub.export({ format: "jwk" }).x!, "base64url");
}

function evt(event: string, payloadHex: string) {
  const type = Buffer.alloc(4);
  type.writeUInt32LE(RUNTIME_EVENT);
  const digest = sha384(
    Buffer.concat([
      type,
      Buffer.from(":"),
      Buffer.from(event),
      Buffer.from(":"),
      Buffer.from(payloadHex, "hex"),
    ]),
  );
  return {
    entry: { imr: 3, event_type: RUNTIME_EVENT, digest: "", event, event_payload: payloadHex },
    digest,
  };
}

export function makeSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })),
    addressHex: rawEd25519Public(publicKey).toString("hex"),
  };
}

export function buildFixture(): Fixture {
  const model = "synthetic/test-model";
  const signer = makeSigner();
  const nonce = randomBytes(32).toString("hex");
  const appCompose = JSON.stringify({ services: { vllm: { image: "example/vllm@sha256:abc" } } });
  const composeHash = sha256(appCompose);
  const osImage = randomBytes(32);
  const e1 = evt("os-image-hash", osImage.toString("hex"));
  const e2 = evt("compose-hash", composeHash.toString("hex"));
  let rtmr3: Buffer = Buffer.alloc(48);
  for (const e of [e1, e2]) rtmr3 = sha384(Buffer.concat([rtmr3, e.digest]));
  const reportData = Buffer.concat([Buffer.from(signer.addressHex, "hex"), Buffer.from(nonce, "hex")]);
  const mrConfigId = Buffer.concat([Buffer.from([1]), composeHash, Buffer.alloc(15)]);

  const quoteVerifier =
    (opts: { debug?: boolean; tcb?: string } = {}): TdxQuoteVerifier =>
    async (q) => {
      if (q === "tampered-quote") throw new Error("quote signature invalid");
      return {
        tcbStatus: (opts.tcb ?? "UpToDate") as "UpToDate",
        advisoryIds: [],
        debugEnabled: opts.debug ?? false,
        reportData: new Uint8Array(reportData),
        mrConfigId: new Uint8Array(mrConfigId),
        rtMr3: new Uint8Array(rtmr3),
      };
    };

  const output = { answer: "synthetic" };
  const requestBody = Buffer.from(
    JSON.stringify({ model, messages: [{ role: "user", content: "synthetic" }] }),
  );
  const responseBody = Buffer.from(
    JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    }),
  );
  const signedText = `${model}:${sha256(requestBody).toString("hex")}:${sha256(responseBody).toString("hex")}`;
  const signature = sign(null, Buffer.from(signedText), signer.privateKey).toString("hex");
  const now = 1_800_000_000_000;
  const evidence: NearAiEvidence = {
    kind: "near-ai/v1",
    model,
    nonce,
    signingAlgo: "ecdsa",
    preflight: {
      fetchedAtMs: now - 10_000,
      attestations: [
        {
          nonce,
          signer: { signingAlgo: "ed25519", signingAddress: signer.addressHex },
          intelQuote: "fake-quote",
          eventLog: [e1.entry, e2.entry],
          appCompose,
          reportedQuoteData: reportData.toString("hex"),
        },
      ],
    },
    completion: {
      completionId: "chatcmpl-test",
      atMs: now - 5_000,
      requestBodyB64: requestBody.toString("base64"),
      responseBodyB64: responseBody.toString("base64"),
    },
    signature: {
      kind: "provider_tee",
      signer: { signingAlgo: "ed25519", signingAddress: signer.addressHex },
      signedText,
      signature,
    },
  };
  const policy: NearAiVerificationPolicy = {
    acceptedTcbStatuses: ["UpToDate", "OutOfDate"],
    acceptedComposeHashes: [composeHash.toString("hex")],
    acceptedOsImageHashes: [osImage.toString("hex")],
    maxEvidenceAgeMs: 60_000,
    maxVerifyDelayMs: 600_000,
    gpuEvidence: "if-present",
  };
  const result: StructuredResult<{ answer: string }> = {
    output,
    provider: "near-ai",
    model,
    requestId: "req-test",
    usage: { inputTokens: 5, outputTokens: 5 },
    evidence,
    rawResponseSha256: sha256(responseBody).toString("hex"),
  };
  return {
    result,
    evidence,
    policy,
    now,
    composeHashHex: composeHash.toString("hex"),
    osImageHex: osImage.toString("hex"),
    quoteVerifier,
    signer,
  };
}

/** Deep clone evidence so a test can mutate one field. */
export function cloneResult(f: Fixture): Fixture["result"] {
  return structuredClone(f.result);
}
