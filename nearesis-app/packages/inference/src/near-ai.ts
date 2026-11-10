import { z } from "zod";
import { AttestationClient, type ModelAttestation } from "@nearai/inference-sdk";
import type { InferenceProvider, StructuredResult, VerificationResult } from "@nearesis/contracts";
import { InferenceError, redact } from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import { loadDefaultPolicy } from "./policy.ts";
import { validateWithRepair } from "./structured.ts";
import {
  verifyNearAiResult,
  verifyPreflight,
  type PreflightSummary,
  type NearAiEvidence,
  type NearAiVerificationPolicy,
  type VerifyDeps,
} from "./near-verify.ts";

export const NEAR_AI_BASE_URL = "https://cloud-api.near.ai/v1";

export interface NearAiOptions {
  apiKey: string;
  baseUrl?: string;
  policy?: Partial<NearAiVerificationPolicy>;
  /** Total tokens (input est. + max output) this provider instance may spend. Default 20000. */
  tokenBudget?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  verifyDeps?: VerifyDeps;
}

export interface ModelDiscovery {
  id: string;
  providerType: string | null;
  attestationSupported: boolean;
  /** "near-tdx-dstack" = NEAR-operated report that this adapter verifies; "other-tee" = different evidence format. */
  proofType: "near-tdx-dstack" | "other-tee" | "none";
  attestation: "supported" | "unsupported" | "unknown";
  outputModes: string[];
  pricing: { prompt: string | null; completion: string | null };
}

interface ModelRow {
  id: string;
  supported_features?: string[];
  pricing?: { prompt?: string; completion?: string };
}

export class NearAiProvider implements InferenceProvider {
  readonly id = "near-ai";
  readonly policy: NearAiVerificationPolicy;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly verifyDeps: VerifyDeps;
  private readonly tokenBudget: number;
  private tokensSpent = 0;
  readonly ledger: Array<{
    requestId: string | null;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }> = [];

  constructor(opts: NearAiOptions) {
    if (!opts.apiKey) throw new InferenceError("UPSTREAM_DEGRADED", "NEAR_AI_API_KEY not provided");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? NEAR_AI_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.verifyDeps = opts.verifyDeps ?? {};
    this.tokenBudget = opts.tokenBudget ?? 20_000;
    this.policy = { ...loadDefaultPolicy(), ...opts.policy };
  }

  get tokensUsed(): number {
    return this.tokensSpent;
  }

  private async http(path: string, init: RequestInit = {}): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.headers as Record<string, string>) },
      });
    } catch (e) {
      throw new InferenceError(
        "UPSTREAM_DEGRADED",
        redact(`request to ${path} failed: ${(e as Error).name}`, [this.apiKey]),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    try {
      const r = await this.http("/models");
      await r.arrayBuffer();
      return { ok: r.ok, detail: `GET /models -> ${r.status}` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  /** Discovery report: model, proof type, output modes (A16 a). */
  async discover(): Promise<ModelDiscovery[]> {
    const r = await this.http("/models");
    if (!r.ok) throw new InferenceError("UPSTREAM_DEGRADED", `GET /models -> ${r.status}`, r.status);
    const rows = ((await r.json()) as { data?: ModelRow[] }).data ?? [];
    const out: ModelDiscovery[] = [];
    for (const m of rows) {
      let providerType: string | null = null;
      let supported = false;
      const mr = await this.http(`/model/${encodeURIComponent(m.id)}`);
      if (mr.ok) {
        const md = (
          (await mr.json()) as { metadata?: { providerType?: string; attestationSupported?: boolean } }
        ).metadata;
        providerType = md?.providerType ?? null;
        supported = md?.attestationSupported === true;
      } else await mr.arrayBuffer();
      const feats = m.supported_features ?? [];
      const outputModes = ["text"];
      if (feats.includes("structured_outputs")) outputModes.push("json_schema");
      if (feats.includes("json_mode")) outputModes.push("json_object");
      if (feats.includes("tools")) outputModes.push("tools");
      const near = supported && providerType === "vllm";
      out.push({
        id: m.id,
        providerType,
        attestationSupported: supported,
        proofType: near ? "near-tdx-dstack" : supported ? "other-tee" : "none",
        attestation: near ? "supported" : supported ? "unknown" : "unsupported",
        outputModes,
        pricing: { prompt: m.pricing?.prompt ?? null, completion: m.pricing?.completion ?? null },
      });
    }
    return out;
  }

  async listModels() {
    return (await this.discover()).map((d) => ({
      id: d.id,
      attestation: d.attestation,
      outputModes: d.outputModes,
    }));
  }

  private charge(inputTokens: number, outputTokens: number, requestId: string | null, model: string) {
    this.tokensSpent += inputTokens + outputTokens;
    this.ledger.push({ requestId, model, inputTokens, outputTokens });
  }

  async generateStructured<T>(args: {
    model: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    idempotencyKey: string;
    maxTokens: number;
  }): Promise<StructuredResult<T>> {
    const jsonSchema = z.toJSONSchema(args.schema);
    const client = new AttestationClient({ baseUrl: this.baseUrl, apiKey: this.apiKey });
    let lastEvidence: NearAiEvidence | null = null;
    let lastMeta: {
      requestId: string | null;
      usage: { inputTokens: number; outputTokens: number };
      bodySha: string;
    } | null = null;

    const { output } = await validateWithRepair(args.schema, args.prompt, async (prompt) => {
      const estIn = Math.ceil((args.system.length + prompt.length + JSON.stringify(jsonSchema).length) / 3);
      if (this.tokensSpent + estIn + args.maxTokens > this.tokenBudget) {
        throw new InferenceError("BUDGET_EXCEEDED", `token budget ${this.tokenBudget} would be exceeded`);
      }
      // 1. preflight attestation (fresh client nonce) strictly before the completion
      const fetchedAtMs = Date.now();
      let fetched;
      try {
        fetched = await client.fetchModelAttestations({ model: args.model, signingAlgo: "ecdsa" });
      } catch (e) {
        throw new InferenceError(
          "UPSTREAM_DEGRADED",
          redact(`attestation fetch failed: ${(e as Error).name}`, [this.apiKey]),
        );
      }
      // 2. completion with exact request bytes retained
      const requestBody = Buffer.from(
        JSON.stringify({
          model: args.model,
          messages: [
            { role: "system", content: args.system },
            { role: "user", content: prompt },
          ],
          max_tokens: args.maxTokens,
          temperature: 0,
          response_format: {
            type: "json_schema",
            json_schema: { name: "result", strict: true, schema: jsonSchema },
          },
        }),
        "utf8",
      );
      const atMs = Date.now();
      const r = await this.http("/chat/completions", {
        method: "POST",
        body: requestBody,
        headers: {
          "Content-Type": "application/json",
          "x-no-aliasing": "true",
          "Accept-Encoding": "identity",
        },
      });
      const responseBody = Buffer.from(await r.arrayBuffer());
      const requestId = r.headers.get("x-request-id");
      if (!r.ok) {
        throw new InferenceError(
          "UPSTREAM_DEGRADED",
          redact(`chat/completions -> ${r.status} (request ${requestId ?? "n/a"})`, [this.apiKey]),
          r.status,
        );
      }
      let parsed: {
        id?: string;
        choices?: Array<{ message?: { content?: string | null } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        parsed = JSON.parse(responseBody.toString("utf8"));
      } catch {
        throw new InferenceError("UPSTREAM_DEGRADED", "completion response was not JSON");
      }
      const usage = {
        inputTokens: parsed.usage?.prompt_tokens ?? estIn,
        outputTokens: parsed.usage?.completion_tokens ?? args.maxTokens,
      };
      this.charge(usage.inputTokens, usage.outputTokens, requestId, args.model);
      // 3. signature over the exact bytes (bounded retry: it may be recorded shortly after the response)
      let signature = null;
      if (parsed.id) {
        for (let i = 0; i < 6 && !signature; i++) {
          try {
            signature = await client.fetchCompletionSignature({
              completionId: parsed.id,
              signingAlgo: "ecdsa",
            });
          } catch {
            await new Promise((res) => setTimeout(res, 1000));
          }
        }
      }
      lastEvidence = {
        kind: "near-ai/v1",
        model: args.model,
        nonce: fetched.clientBinding.nonce,
        signingAlgo: "ecdsa",
        preflight: { fetchedAtMs, attestations: fetched.attestations as ModelAttestation[] },
        completion: {
          completionId: parsed.id ?? "",
          atMs,
          requestBodyB64: requestBody.toString("base64"),
          responseBodyB64: responseBody.toString("base64"),
        },
        signature,
      };
      lastMeta = { requestId, usage, bodySha: sha256Hex(responseBody) };
      return { text: parsed.choices?.[0]?.message?.content ?? "", meta: null };
    });

    const m = lastMeta!;
    return {
      output,
      provider: this.id,
      model: args.model,
      requestId: m.requestId,
      usage: m.usage,
      evidence: lastEvidence,
      rawResponseSha256: m.bodySha,
    };
  }

  async *streamText(args: {
    model: string;
    system: string;
    prompt: string;
    maxTokens: number;
  }): AsyncIterable<string> {
    if (this.tokensSpent + args.maxTokens + 1000 > this.tokenBudget) {
      throw new InferenceError("BUDGET_EXCEEDED", `token budget ${this.tokenBudget} would be exceeded`);
    }
    const r = await this.http("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        stream: true,
        max_tokens: args.maxTokens,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.prompt },
        ],
      }),
    });
    if (!r.ok || !r.body) throw new InferenceError("UPSTREAM_DEGRADED", `stream -> ${r.status}`);
    this.tokensSpent += args.maxTokens; // conservative: streamed output is unverified and charged at the cap
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> })
            .choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          /* ignore malformed keep-alive lines */
        }
      }
    }
  }

  /**
   * Fetch and genuinely verify (Intel DCAP quote, nonce/signer binding, RTMR3 replay, MRCONFIGID, NVIDIA GPU) the
   * model attestation for `model` without sending a completion. Used for discovery and as supplementary evidence only:
   * it never yields verified status for any response.
   */
  async preflight(model: string): Promise<PreflightSummary[]> {
    const client = new AttestationClient({ baseUrl: this.baseUrl, apiKey: this.apiKey });
    const fetched = await client.fetchModelAttestations({ model, signingAlgo: "ecdsa" });
    return verifyPreflight(
      fetched.attestations as ModelAttestation[],
      fetched.clientBinding.nonce,
      this.policy,
      this.verifyDeps,
    );
  }

  verifyResponse(result: StructuredResult<unknown>): Promise<VerificationResult> {
    return verifyNearAiResult(result, this.policy, this.verifyDeps);
  }
}
